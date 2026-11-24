import {
  newId,
  type AgentRecord,
  type AutonomyLevel,
  type ProjectRecord,
  type QuietStatusProjection,
  type ReasoningEffort,
  type SubagentMode,
  type SubscriptionTopic,
  type TimelineItem,
} from "@bot-factory/shared";
import type { LoadedRuntimeConfig, SecretScrubber } from "../config";
import type { CommandCore } from "../core/commandCore";
import type { StateDatabase } from "../db/database";
import {
  cleanupSubagentWorktree,
  createSubagentWorktree,
  extractAndApplySubagentPatch,
  removeBotWorktree,
} from "../git/worktrees";
import type { LocalSuperHermesMemory } from "../memory/memoryEngine";
import { loadActivePluginBlocks } from "../phase3/selfMod";
import type { ModelRouter } from "../runtimes/router";

export interface SubagentEngineCallbacks {
  getQuietStatusProjection: () => QuietStatusProjection;
  getProjectBoardSnapshot: (projectId: string) => unknown;
  runAgentTurn: (
    agentId: string,
    userText: string,
    opts: {
      emitTopic: SubscriptionTopic;
      namespace: string;
      autonomyLevel?: AutonomyLevel;
      reasoningEffort?: ReasoningEffort;
    },
  ) => Promise<{ ok: boolean; text: string; error?: string }>;
  abortAndCloseAgentSession: (agent: AgentRecord, mode: "pause" | "hard_stop") => Promise<void>;
  revokeMcpTokensForAgent: (agentId: string) => void;
}

const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const MIN_WAIT_TIMEOUT_MS = 100;
const MAX_WAIT_TIMEOUT_MS = 300_000;

export class SubagentManager {
  private readonly pendingTurns = new Map<string, number>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly runtimeCfg: LoadedRuntimeConfig,
    private readonly db: StateDatabase,
    private readonly core: CommandCore,
    private readonly memory: LocalSuperHermesMemory,
    private readonly router: ModelRouter,
    private readonly scrubber: SecretScrubber,
    private readonly callbacks: SubagentEngineCallbacks,
  ) {}

  private notifyWaiters(subagentId: string): void {
    const set = this.waiters.get(subagentId);
    if (!set || set.size === 0) return;
    for (const cb of [...set]) {
      try {
        cb();
      } catch {
        // ignore listener errors
      }
    }
  }

  private bumpPendingTurns(subagentId: string, delta: number): number {
    const next = Math.max(0, (this.pendingTurns.get(subagentId) ?? 0) + delta);
    if (next === 0) {
      this.pendingTurns.delete(subagentId);
    } else {
      this.pendingTurns.set(subagentId, next);
    }
    return next;
  }

  private assertOwnedSidekick(parentAgentId: string, subagentId: string): { parent: AgentRecord; subagent: AgentRecord } {
    const parent = this.db.getAgent(parentAgentId);
    if (!parent) throw new Error("agent_not_found");
    const subagent = this.db.getAgent(subagentId);
    if (!subagent || subagent.scope !== "sidekick") {
      throw new Error("subagent_not_found");
    }
    if (subagent.parentAgentId !== parent.id || subagent.projectId !== parent.projectId) {
      throw new Error("subagent_forbidden");
    }
    return { parent, subagent };
  }

  private getLatestAssistantOutput(subagentId: string): string | null {
    const items = this.db.listAgentTimeline(subagentId, 25);
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]!;
      if (item.kind === "message" && item.role === "assistant") {
        return item.content;
      }
    }
    return null;
  }

  public async spawnSubagent(params: {
    projectId: string;
    parentAgentId: string;
    name: string;
    role?: string;
    mode?: SubagentMode;
    prompt: string;
    provider?: string;
    model?: string;
  }): Promise<{ subagent: AgentRecord; mode: SubagentMode }> {
    const parent = this.db.getAgent(params.parentAgentId);
    if (!parent) throw new Error("agent_not_found");

    if (parent.scope === "sidekick" || (parent.depth ?? 0) >= 1) {
      throw new Error("subagent_max_depth_exceeded");
    }
    if (parent.scope !== "peer") {
      throw new Error("subagent_parent_must_be_peer");
    }

    const project = this.db.getProject(params.projectId);
    if (!project) throw new Error("project_not_found");
    if (parent.projectId !== project.id) throw new Error("agent_project_mismatch");

    const mode: SubagentMode = params.mode ?? "readonly";
    if (mode !== "readonly" && mode !== "code") {
      throw new Error("invalid_subagent_mode");
    }

    const cleanName = this.scrubber.scrub(params.name).trim();
    const cleanPrompt = this.scrubber.scrub(params.prompt).trim();
    const cleanRole = params.role ? this.scrubber.scrub(params.role).trim() : "";
    if (!cleanName || !cleanPrompt) {
      throw new Error("invalid_subagent_args");
    }

    const activeSidekicks = this.db
      .listAgents(project.id)
      .filter((a) => a.scope === "sidekick" && a.parentAgentId === parent.id && a.status !== "stopped");
    const maxPerBot = this.runtimeCfg.config.guardrails.maxSubagentsPerBot;
    if (activeSidekicks.length >= maxPerBot) {
      throw new Error(`max_subagents_per_bot_reached (${maxPerBot})`);
    }

    const route =
      params.provider && params.model
        ? this.router.resolveTarget({ provider: params.provider, model: params.model })
        : this.router.resolveIntent("sidekick", { projectOverrides: project.routingOverrides });

    const subagentId = newId("sub");
    const sessionId = newId("ses");
    const parentWorktreePath = parent.worktreePath ?? project.repoPath;
    let worktreePath = parentWorktreePath;
    let worktreeBranch: string | null = parent.worktreeBranch;
    let createdChildWorktree: { worktreePath: string; branch: string; baseCommitSha: string } | null = null;
    let autonomyLevel: AutonomyLevel = "spec";

    if (mode === "code") {
      createdChildWorktree = await createSubagentWorktree({
        projectRoot: project.rootPath,
        parentWorktreePath,
        subagentId,
      });
      worktreePath = createdChildWorktree.worktreePath;
      worktreeBranch = createdChildWorktree.branch;
      autonomyLevel = "high";
    }

    const roleClause = cleanRole ? ` (${cleanRole})` : "";
    const toolsBrief =
      mode === "readonly"
        ? "Strictly read-only analysis inside the shared worktree. Never edit files. Provide concise findings back to your parent bot."
        : "Work strictly inside your isolated child worktree. Keep edits minimal and well-verified so your parent bot can apply your patch cleanly.";

    const { systemPrompt, hash } = this.memory.buildFrozenSystemPrompt({
      identity: `You are depth-1 ${mode} sidekick subagent '${cleanName}'${roleClause} deployed by '${parent.name}' on project '${project.name}'.`,
      toolsBrief,
      projectContext: `Project: ${project.name} (${project.slug})\nParent Bot: ${parent.name} (${parent.id})`,
      worktreePath,
      namespace: `project:${project.slug}`,
      projectRoot: project.rootPath,
      modelLabel: `${route.provider}/${route.model}`,
      pluginBlocks: loadActivePluginBlocks(this.runtimeCfg.pluginsDir),
    });

    const now = Date.now();
    const subagent: AgentRecord = {
      id: subagentId,
      projectId: project.id,
      parentAgentId: parent.id,
      scope: "sidekick",
      name: cleanName,
      runtimeType: route.runtimeKind,
      provider: route.provider,
      model: route.model,
      status: "working",
      worktreePath,
      worktreeBranch,
      pid: null,
      activeSessionId: sessionId,
      lastSummary: `Starting ${mode} subagent${roleClause}`,
      depth: 1,
      subagentMode: mode,
      autonomyLevel,
      updatedAt: now,
    };

    const userMsg: TimelineItem = {
      id: newId("msg"),
      agentId: subagentId,
      sessionId,
      seq: 0,
      kind: "message",
      role: "user",
      content: cleanPrompt,
      createdAt: now,
    };

    const parentNoticeItem: TimelineItem | null = parent.activeSessionId
      ? {
          id: newId("msg"),
          agentId: parent.id,
          sessionId: parent.activeSessionId,
          seq: 0,
          kind: "status",
          role: "system",
          title: `Spawned ${mode} subagent: ${cleanName}`,
          content: cleanPrompt.slice(0, 400),
          createdAt: now,
        }
      : null;

    this.bumpPendingTurns(subagentId, 1);
    try {
      this.core.commitCommand(newId("cmd"), "subagent.spawn", () => ({
        result: { subagent, mode },
        applyProjections: () => {
          this.db.upsertAgent(subagent);
          this.db.createSession({
            id: sessionId,
            agentId: subagentId,
            parentSessionId: null,
            systemPrompt,
            systemPromptHash: hash,
            generation: 1,
            tokenIn: 0,
            tokenOut: 0,
            status: "active",
            createdAt: now,
            updatedAt: now,
          });
          this.db.appendMessage(userMsg);
          if (parentNoticeItem) {
            this.db.appendMessage(parentNoticeItem);
          }
        },
        events: [
          { topic: "global:status", eventType: "agent.spawned", payload: subagent },
          { topic: `project:${project.id}:board`, eventType: "agent.spawned", payload: subagent },
          ...(parentNoticeItem
            ? [{ topic: `bot:${parent.id}:timeline` as SubscriptionTopic, eventType: "timeline.item", payload: parentNoticeItem }]
            : []),
          { topic: "global:status", eventType: "status.updated", payload: this.callbacks.getQuietStatusProjection() },
        ],
        effects: [
          {
            effectType: "subagent.run",
            payload: {
              projectId: project.id,
              parentAgentId: parent.id,
              subagentId,
              prompt: cleanPrompt,
            },
          },
        ],
      }));
    } catch (err) {
      this.bumpPendingTurns(subagentId, -1);
      if (createdChildWorktree) {
        try {
          await cleanupSubagentWorktree({
            repoPath: project.repoPath,
            worktreePath: createdChildWorktree.worktreePath,
            branch: createdChildWorktree.branch,
          });
        } catch {
          // Best-effort cleanup
        }
      }
      throw err;
    }

    return { subagent, mode };
  }

  public async executeSubagentTurn(payload: {
    projectId: string;
    parentAgentId: string;
    subagentId: string;
    prompt: string;
  }): Promise<void> {
    try {
      const project = this.db.getProject(payload.projectId);
      const subagent = this.db.getAgent(payload.subagentId);
      if (!project || !subagent || subagent.status === "stopped" || subagent.status === "paused") {
        return;
      }

      const autonomyLevel: AutonomyLevel = subagent.autonomyLevel ?? (subagent.subagentMode === "code" ? "high" : "spec");
      const turn = await this.callbacks.runAgentTurn(subagent.id, payload.prompt, {
        emitTopic: `bot:${subagent.id}:timeline`,
        namespace: `project:${project.slug}`,
        autonomyLevel,
        reasoningEffort: subagent.reasoningEffort,
      });

      const latestSub = this.db.getAgent(subagent.id);
      if (!latestSub || latestSub.status === "stopped" || latestSub.status === "paused") return;

      const parent = this.db.getAgent(payload.parentAgentId);
      if (parent && parent.activeSessionId) {
        const item: TimelineItem = {
          id: newId("msg"),
          agentId: parent.id,
          sessionId: parent.activeSessionId,
          seq: 0,
          kind: "status",
          role: "system",
          title: turn.ok ? `Subagent '${latestSub.name}' completed` : `Subagent '${latestSub.name}' failed`,
          content: this.scrubber.scrub(turn.ok ? turn.text.slice(0, 600) : turn.error ?? "Subagent error"),
          createdAt: Date.now(),
        };
        this.db.runAtomicWrite(() => {
          this.db.appendMessage(item);
        });
        this.core.emitDirectEvent(`bot:${parent.id}:timeline`, "timeline.item", item);
      }

      this.core.emitDirectEvent(`project:${project.id}:board`, "board.updated", this.callbacks.getProjectBoardSnapshot(project.id));
      this.core.emitDirectEvent("global:status", "status.updated", this.callbacks.getQuietStatusProjection());
    } finally {
      this.bumpPendingTurns(payload.subagentId, -1);
      const current = this.db.getAgent(payload.subagentId);
      if (current && current.status === "working" && (this.pendingTurns.get(payload.subagentId) ?? 0) === 0) {
        this.db.runAtomicWrite(() => {
          const fresh = this.db.getAgent(payload.subagentId);
          if (fresh && fresh.status === "working") {
            this.db.updateAgentStatus(fresh.id, "error", { lastSummary: "Subagent turn ended unexpectedly" });
          }
        });
      }
      this.notifyWaiters(payload.subagentId);
    }
  }

  public getStatus(parentAgentId: string, subagentId?: string) {
    if (subagentId) {
      const { subagent } = this.assertOwnedSidekick(parentAgentId, subagentId);
      return {
        subagent,
        latestOutput: this.getLatestAssistantOutput(subagent.id),
      };
    }
    const subagents = this.db
      .listAgents()
      .filter((a) => a.scope === "sidekick" && a.parentAgentId === parentAgentId)
      .map((sub) => ({
        ...sub,
        latestOutput: this.getLatestAssistantOutput(sub.id),
      }));
    return { subagents };
  }

  public async waitForSubagent(
    parentAgentId: string,
    subagentId: string,
    timeoutMs?: number,
  ): Promise<{ subagent: AgentRecord; timedOut: boolean; latestOutput: string | null }> {
    this.assertOwnedSidekick(parentAgentId, subagentId);
    const boundedTimeout =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
        ? Math.max(MIN_WAIT_TIMEOUT_MS, Math.min(MAX_WAIT_TIMEOUT_MS, Math.trunc(timeoutMs)))
        : DEFAULT_WAIT_TIMEOUT_MS;

    const isDone = (): boolean => {
      const cur = this.db.getAgent(subagentId);
      if (!cur) return true;
      return cur.status !== "working" && (this.pendingTurns.get(subagentId) ?? 0) === 0;
    };

    if (!isDone()) {
      await new Promise<void>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onWake = () => {
          if (settled) return;
          if (!isDone()) return;
          settled = true;
          if (timer) clearTimeout(timer);
          const set = this.waiters.get(subagentId);
          set?.delete(onWake);
          if (set && set.size === 0) this.waiters.delete(subagentId);
          resolve();
        };

        let set = this.waiters.get(subagentId);
        if (!set) {
          set = new Set();
          this.waiters.set(subagentId, set);
        }
        set.add(onWake);

        if (isDone()) {
          onWake();
          return;
        }

        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const currentSet = this.waiters.get(subagentId);
          currentSet?.delete(onWake);
          if (currentSet && currentSet.size === 0) this.waiters.delete(subagentId);
          resolve();
        }, boundedTimeout);
      });
    }

    const finalSub = this.db.getAgent(subagentId);
    if (!finalSub) throw new Error("subagent_not_found");
    return {
      subagent: finalSub,
      timedOut: finalSub.status === "working" || (this.pendingTurns.get(subagentId) ?? 0) > 0,
      latestOutput: this.getLatestAssistantOutput(subagentId),
    };
  }

  public messageSubagent(parentAgentId: string, subagentId: string, message: string): { queued: boolean; subagentId: string } {
    const { subagent } = this.assertOwnedSidekick(parentAgentId, subagentId);
    if (subagent.status === "stopped" || subagent.status === "paused") {
      throw new Error(`subagent_unavailable:${subagent.status}`);
    }
    if (!subagent.projectId || !subagent.activeSessionId) {
      throw new Error("subagent_session_missing");
    }

    const cleanMessage = this.scrubber.scrub(message).trim();
    if (!cleanMessage) throw new Error("empty_message");

    const now = Date.now();
    const msgItem: TimelineItem = {
      id: newId("msg"),
      agentId: subagent.id,
      sessionId: subagent.activeSessionId,
      seq: 0,
      kind: "message",
      role: "user",
      content: cleanMessage,
      createdAt: now,
    };

    this.bumpPendingTurns(subagent.id, 1);
    try {
      this.core.commitCommand(newId("cmd"), "subagent.message", () => ({
        result: { queued: true, subagentId: subagent.id },
        applyProjections: () => {
          this.db.appendMessage(msgItem);
          this.db.updateAgentStatus(subagent.id, "working", {
            lastSummary: `Follow-up: ${cleanMessage.slice(0, 60)}`,
          });
        },
        events: [
          { topic: `bot:${subagent.id}:timeline`, eventType: "timeline.item", payload: msgItem },
          { topic: `bot:${subagent.id}:timeline`, eventType: "agent.status", payload: { agentId: subagent.id, status: "working" } },
          { topic: "global:status", eventType: "status.updated", payload: this.callbacks.getQuietStatusProjection() },
        ],
        effects: [
          {
            effectType: "subagent.run",
            payload: {
              projectId: subagent.projectId,
              parentAgentId,
              subagentId: subagent.id,
              prompt: cleanMessage,
            },
          },
        ],
      }));
    } catch (err) {
      this.bumpPendingTurns(subagent.id, -1);
      throw err;
    }

    return { queued: true, subagentId: subagent.id };
  }

  public async killSubagent(parentAgentId: string, subagentId: string): Promise<{ killed: boolean; subagentId: string }> {
    const { parent, subagent } = this.assertOwnedSidekick(parentAgentId, subagentId);
    const project = subagent.projectId ? this.db.getProject(subagent.projectId) : null;
    await this.cleanupSingleSubagent(subagent, parent, project, "Killed by parent bot");
    return { killed: true, subagentId: subagent.id };
  }

  public async applySubagentPatch(
    parentAgentId: string,
    subagentId: string,
  ): Promise<{ ok: boolean; patch: string; changedFiles: string[]; error?: string }> {
    const { parent, subagent } = this.assertOwnedSidekick(parentAgentId, subagentId);
    if (subagent.subagentMode !== "code") {
      return { ok: false, patch: "", changedFiles: [], error: "subagent_is_readonly" };
    }
    if (subagent.status === "working" || (this.pendingTurns.get(subagent.id) ?? 0) > 0) {
      return { ok: false, patch: "", changedFiles: [], error: "subagent_still_running" };
    }
    const project = parent.projectId ? this.db.getProject(parent.projectId) : null;
    if (!project) {
      return { ok: false, patch: "", changedFiles: [], error: "project_not_found" };
    }
    const parentWorktreePath = parent.worktreePath ?? project.repoPath;
    if (!subagent.worktreePath || !subagent.worktreeBranch || subagent.worktreePath === parentWorktreePath) {
      return { ok: false, patch: "", changedFiles: [], error: "subagent_worktree_missing" };
    }

    const res = await extractAndApplySubagentPatch({
      repoPath: project.repoPath,
      parentWorktreePath,
      childWorktreePath: subagent.worktreePath,
      childBranch: subagent.worktreeBranch,
      skipCleanup: true,
    });

    const cleanPatch = this.scrubber.scrub(res.patch);
    const now = Date.now();

    if (res.ok) {
      this.callbacks.revokeMcpTokensForAgent(subagent.id);
      await this.callbacks.abortAndCloseAgentSession(subagent, "hard_stop");
      if (process.platform === "win32" && subagent.pid) {
        await new Promise((r) => setTimeout(r, 50));
      }
      this.pendingTurns.delete(subagent.id);
      await cleanupSubagentWorktree({
        repoPath: project.repoPath,
        worktreePath: subagent.worktreePath,
        branch: subagent.worktreeBranch,
      });

      const timelineItem: TimelineItem | null = parent.activeSessionId
        ? {
            id: newId("msg"),
            agentId: parent.id,
            sessionId: parent.activeSessionId,
            seq: 0,
            kind: "tool_call",
            role: "tool",
            title: `Applied subagent patch (${subagent.name})`,
            content:
              res.changedFiles.length > 0
                ? `Applied changes to: ${res.changedFiles.join(", ")}`
                : "Subagent produced empty diff (cleaned up cleanly).",
            toolStatus: "completed",
            exitCode: 0,
            filePath: res.changedFiles[0],
            diffPreview: cleanPatch ? cleanPatch.slice(0, 4000) : undefined,
            createdAt: now,
          }
        : null;

      this.db.runAtomicWrite(() => {
        if (timelineItem) {
          this.db.appendMessage(timelineItem);
        }
        const freshSub = this.db.getAgent(subagent.id);
        if (freshSub) {
          this.db.upsertAgent({
            ...freshSub,
            status: "stopped",
            pid: null,
            worktreePath: null,
            worktreeBranch: null,
            lastSummary: "Patch applied to parent worktree",
            updatedAt: now,
          });
        }
      });

      if (timelineItem) {
        this.core.emitDirectEvent(`bot:${parent.id}:timeline`, "timeline.item", timelineItem);
      }
      this.core.emitDirectEvent(`bot:${subagent.id}:timeline`, "agent.status", { agentId: subagent.id, status: "stopped" });
      this.core.emitDirectEvent(`project:${project.id}:board`, "board.updated", this.callbacks.getProjectBoardSnapshot(project.id));
      this.core.emitDirectEvent("global:status", "status.updated", this.callbacks.getQuietStatusProjection());
      this.notifyWaiters(subagent.id);
    } else if (parent.activeSessionId) {
      const errItem: TimelineItem = {
        id: newId("msg"),
        agentId: parent.id,
        sessionId: parent.activeSessionId,
        seq: 0,
        kind: "tool_call",
        role: "tool",
        title: `Failed applying subagent patch (${subagent.name})`,
        content: this.scrubber.scrub(res.error ?? "apply_patch_failed"),
        toolStatus: "failed",
        exitCode: 1,
        diffPreview: cleanPatch ? cleanPatch.slice(0, 2000) : undefined,
        createdAt: now,
      };
      this.db.runAtomicWrite(() => this.db.appendMessage(errItem));
      this.core.emitDirectEvent(`bot:${parent.id}:timeline`, "timeline.item", errItem);
    }

    return {
      ok: res.ok,
      patch: cleanPatch,
      changedFiles: res.changedFiles,
      ...(res.error ? { error: this.scrubber.scrub(res.error) } : {}),
    };
  }

  public async cleanupSubagentsForParent(parentAgentId: string): Promise<void> {
    const parent = this.db.getAgent(parentAgentId);
    const project = parent?.projectId ? this.db.getProject(parent.projectId) : null;
    const children = this.db
      .listAgents(parent?.projectId ?? undefined)
      .filter((a) => a.scope === "sidekick" && a.parentAgentId === parentAgentId && (a.status !== "stopped" || (a.subagentMode === "code" && Boolean(a.worktreePath))));

    for (const child of children) {
      await this.cleanupSingleSubagent(child, parent, project, "Cleaned up on parent stop");
    }
  }

  private async cleanupSingleSubagent(
    subagent: AgentRecord,
    parent: AgentRecord | null,
    project: ProjectRecord | null,
    reason: string,
  ): Promise<void> {
    this.callbacks.revokeMcpTokensForAgent(subagent.id);
    this.pendingTurns.delete(subagent.id);
    await this.callbacks.abortAndCloseAgentSession(subagent, "hard_stop");
    if (process.platform === "win32" && subagent.pid) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const parentWt = parent?.worktreePath ?? project?.repoPath ?? null;
    if (
      project &&
      subagent.subagentMode === "code" &&
      subagent.worktreePath &&
      subagent.worktreePath !== parentWt &&
      subagent.worktreePath !== project.repoPath
    ) {
      try {
        await cleanupSubagentWorktree({
          repoPath: project.repoPath,
          worktreePath: subagent.worktreePath,
          branch: subagent.worktreeBranch,
        });
      } catch {
        try {
          removeBotWorktree(project.repoPath, subagent.worktreePath);
        } catch {
          // Best-effort child worktree removal
        }
      }
    }

    const now = Date.now();
    this.db.runAtomicWrite(() => {
      const fresh = this.db.getAgent(subagent.id);
      if (fresh) {
        this.db.upsertAgent({
          ...fresh,
          status: "stopped",
          pid: null,
          worktreePath: null,
          worktreeBranch: null,
          lastSummary: reason,
          updatedAt: now,
        });
      }
    });

    this.core.emitDirectEvent(`bot:${subagent.id}:timeline`, "agent.status", { agentId: subagent.id, status: "stopped" });
    if (project) {
      this.core.emitDirectEvent(`project:${project.id}:board`, "board.updated", this.callbacks.getProjectBoardSnapshot(project.id));
    }
    this.core.emitDirectEvent("global:status", "status.updated", this.callbacks.getQuietStatusProjection());
    this.notifyWaiters(subagent.id);
  }
}
