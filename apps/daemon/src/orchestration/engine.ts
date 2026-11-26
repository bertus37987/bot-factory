import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  HubConfigSchema,
  newId,
  RpcCommandSchema,
  slugify,
  TaskStatusSchema,
  type AgentRecord,
  type AnnotationRecord,
  type ArtifactEntry,
  type AutonomyLevel,
  type CheckpointRecord,
  type DebateMessageRecord,
  type DebateRecord,
  type HubConfig,
  type PermissionRequestRecord,
  type ProjectRecord,
  type QuietStatusProjection,
  type ReasoningEffort,
  type RpcCommand,
  type SelfModProposalRecord,
  type SubagentMode,
  type SubscriptionTopic,
  type TaskRecord,
  type TeamGoalRecord,
  type TimelineItem,
  type VerificationReportRecord,
} from "@bot-factory/shared";
import {
  redactHubConfigForExposure,
  resolveHubConfigInspection,
  restoreRedactedProviderEnvValues,
  saveHubConfig,
  type LoadedRuntimeConfig,
  type SecretScrubber,
} from "../config";
import type { CommandCore } from "../core/commandCore";
import type { StateDatabase } from "../db/database";
import {
  captureCheckpoint,
  createBotWorktree,
  listProjectArtifacts,
  listWorktreeChangedFiles,
  makeCheckpointScopeKey,
  mergeBotWorktree,
  provisionProjectWorkspace,
  removeBotWorktree,
  restoreCheckpoint,
  writeTaskHandoff,
} from "../git/worktrees";
import type { LocalSuperHermesMemory } from "../memory/memoryEngine";
import { loadActivePluginBlocks, mergeOpenByosConfigPatch, SelfModManager } from "../phase3/selfMod";
import { IndependentVerifier } from "../phase3/verifier";
import { resolveSafeProjectFile } from "../rpc/server";
import type { AcpSubprocessRuntime, PendingAcpPermissionRecord } from "../runtimes/acpSubprocessRuntime";
import type { CliStreamRuntime } from "../runtimes/cliStreamRuntime";
import type { NativeHttpRuntime } from "../runtimes/nativeHttpRuntime";
import type { ModelRouter } from "../runtimes/router";
import type { AgentRuntime, RuntimeSessionHandle, ToolCallExecutor, ToolDefinition } from "../runtimes/types";
import { getMainManagerTools, getTeamLeadTools } from "./agentTools";
import { AutonomyLoop } from "./autonomyLoop";
import { SubagentManager } from "./subagentManager";

export class OrchestrationEngine {
  public readonly metaAgentId = "agent_meta_orchestrator";
  private readonly sessionHandles = new Map<string, RuntimeSessionHandle>();
  private readonly mcpTokens = new Map<string, { projectId: string; agentId: string; sessionId: string }>();
  private readonly agentTurnPrefs = new Map<string, { reasoningEffort?: ReasoningEffort; autonomyLevel?: AutonomyLevel }>();
  private readonly verifier: IndependentVerifier;
  private readonly selfMod: SelfModManager;
  private readonly subagentManager: SubagentManager;
  private readonly autonomyLoop: AutonomyLoop;
  private boundPort: number | null = null;

  constructor(
    private readonly runtimeCfg: LoadedRuntimeConfig,
    private readonly db: StateDatabase,
    private readonly core: CommandCore,
    private readonly memory: LocalSuperHermesMemory,
    private readonly router: ModelRouter,
    private readonly nativeRuntime: NativeHttpRuntime,
    private readonly acpRuntime: AcpSubprocessRuntime,
    private readonly scrubber: SecretScrubber,
    private readonly cliRuntime?: CliStreamRuntime,
  ) {
    this.verifier = new IndependentVerifier(runtimeCfg, db, memory, router, nativeRuntime, acpRuntime, scrubber, cliRuntime);
    this.selfMod = new SelfModManager(runtimeCfg, scrubber);
    this.subagentManager = new SubagentManager(runtimeCfg, db, core, memory, router, scrubber, {
      getQuietStatusProjection: () => this.getQuietStatusProjection(),
      getProjectBoardSnapshot: (projectId) => this.getProjectBoardSnapshot(projectId),
      runAgentTurn: (agentId, userText, opts) => this.runAgentTurn(agentId, userText, opts),
      abortAndCloseAgentSession: (agent, mode) => this.abortAndCloseAgentSession(agent, mode),
      revokeMcpTokensForAgent: (agentId) => this.revokeMcpTokensForAgent(agentId),
    });
    this.autonomyLoop = new AutonomyLoop(db, core, scrubber, {
      getConfig: () => this.runtimeCfg.config,
      getQuietStatusProjection: () => this.getQuietStatusProjection(),
      getProjectBoardSnapshot: (projectId) => this.getProjectBoardSnapshot(projectId),
      spawnPeerBot: ({ projectId, name, taskId, autonomyLevel, reasoningEffort }) =>
        (
          this.handleBotSpawn({
            commandId: newId("cmd"),
            type: "bot.spawn",
            projectId,
            name,
            scope: "peer",
            taskId,
            autonomyLevel,
            reasoningEffort,
          }) as { agent: AgentRecord }
        ).agent,
      dispatchTask: ({ projectId, taskId, agentId, autonomous }) => {
        this.handleTaskDispatch({
          commandId: newId("cmd"),
          type: "task.dispatch",
          projectId,
          taskId,
          agentId,
          autonomous,
        });
      },
      runAgentTurn: (agentId, userText, opts) => this.runAgentTurn(agentId, userText, opts),
      onGoalReportFallback: async ({ project, goal, status, summary, verifiedTaskIds, blockedReasons }) => {
        const pm = this.db.listAgents(project.id).find((a) => a.scope === "project");
        if (!pm) return;
        this.autonomyLoop.markGoalReported(project.id, status, goal.goalId);
        const reportPayload = {
          projectId: project.id,
          projectName: project.name,
          pmAgentId: pm.id,
          goalId: goal.goalId,
          status,
          summary,
          verifiedTaskIds,
          blockedReasons,
          reportedAt: Date.now(),
        };
        this.core.commitCommand(newId("cmd"), "pm.report_to_manager_auto", () => ({
          result: { ok: true, ...reportPayload },
          applyProjections: () => {
            this.db.addInboxNotice(
              status === "blocked" ? "action" : "info",
              `${project.name} Team Lead reported '${status}': ${summary.slice(0, 120)}`,
              { projectId: project.id, agentId: pm.id },
            );
          },
          events: [
            { topic: `project:${project.id}:board`, eventType: "goal.reported", payload: reportPayload },
            { topic: `project:${project.id}:board`, eventType: "board.updated", payload: this.getProjectBoardSnapshot(project.id) },
            { topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() },
          ],
          effects: [{ effectType: "meta.team_report", payload: reportPayload }],
        }));
      },
    });
    this.acpRuntime.setOnSessionExit?.((sessionId) => {
      this.handleAcpSessionExit(sessionId);
    });
    this.acpRuntime.setOnPermissionRequest?.((req) => {
      this.handleAcpPermissionRequested(req);
    });
    this.ensureMetaOrchestrator();
    this.registerOutboxHandlers();
  }

  public getAutonomyLoop(): AutonomyLoop {
    return this.autonomyLoop;
  }

  public getSubagentManager(): SubagentManager {
    return this.subagentManager;
  }

  private async abortAndCloseAgentSession(agent: AgentRecord, mode: "pause" | "hard_stop"): Promise<void> {
    if (mode === "hard_stop") {
      this.revokeMcpTokensForAgent(agent.id);
    }
    const handle = this.sessionHandles.get(agent.activeSessionId ?? "");
    if (!handle) return;
    try {
      await this.getRuntime(agent.runtimeType).abort(handle, mode);
    } catch {
      // Best-effort runtime abort
    }
    if (mode === "hard_stop") {
      this.sessionHandles.delete(handle.sessionId);
      try {
        await this.getRuntime(agent.runtimeType).closeSession(handle);
      } catch {
        // Best-effort close
      }
    }
  }

  public reloadSecrets(): void {
    this.scrubber.updateSecrets(this.runtimeCfg.secrets);
    this.nativeRuntime.updateSecrets(this.runtimeCfg.secrets);
    this.cliRuntime?.updateSecrets(this.runtimeCfg.secrets);
  }

  public reloadConfig(newConfig: HubConfig): void {
    this.runtimeCfg.config = newConfig;
    this.router.setConfig(newConfig);
    this.nativeRuntime.setConfig(newConfig);
    this.acpRuntime.setConfig(newConfig);
    this.cliRuntime?.setConfig(newConfig);
    this.memory.setConfig(newConfig);
    this.reloadSecrets();
  }

  public setBoundPort(port: number): void {
    this.boundPort = port;
  }

  public getDaemonUrl(): string {
    const port = this.boundPort ?? this.runtimeCfg.config.hub.port;
    return `http://${this.runtimeCfg.config.hub.host}:${port}`;
  }

  public mintMcpToken(projectId: string, agentId: string, sessionId: string): string {
    const token = `bfmcp_${crypto.randomUUID().replace(/-/g, "")}`;
    this.mcpTokens.set(token, { projectId, agentId, sessionId });
    return token;
  }

  public resolveMcpToken(token: string): { projectId: string; agentId: string; sessionId: string } | null {
    if (!token) return null;
    return this.mcpTokens.get(token) ?? null;
  }

  public revokeMcpTokensForAgent(agentId: string): void {
    for (const [token, info] of this.mcpTokens.entries()) {
      if (info.agentId === agentId) {
        this.mcpTokens.delete(token);
      }
    }
  }

  private handleAcpSessionExit(sessionId: string): void {
    const handle = this.sessionHandles.get(sessionId);
    this.sessionHandles.delete(sessionId);
    for (const [token, info] of this.mcpTokens.entries()) {
      if (info.sessionId === sessionId) {
        this.mcpTokens.delete(token);
      }
    }
    if (handle) {
      const agent = this.db.getAgent(handle.agentId);
      if (agent && agent.activeSessionId === sessionId && agent.pid !== null && agent.status === "idle") {
        this.db.runAtomicWrite(() => {
          const latest = this.db.getAgent(handle.agentId);
          if (latest && latest.activeSessionId === sessionId && latest.pid !== null && latest.status === "idle") {
            this.db.updateAgentStatus(handle.agentId, "idle", { pid: null });
          }
        });
      }
    }
  }

  public shutdownSync(): void {
    this.acpRuntime.shutdownAllSync();
    this.nativeRuntime.shutdownAllSync();
    this.cliRuntime?.shutdownAllSync();
    this.sessionHandles.clear();
    this.mcpTokens.clear();
  }

  public async shutdown(): Promise<void> {
    await Promise.all([
      this.acpRuntime.shutdownAll(),
      this.nativeRuntime.shutdownAll(),
      this.cliRuntime ? this.cliRuntime.shutdownAll() : Promise.resolve(),
    ]);
    this.sessionHandles.clear();
    this.mcpTokens.clear();
  }

  private getMetaPromptSpec(): { identity: string; toolsBrief: string } {
    return {
      identity:
        "You are the Bot-Factory Meta-Orchestrator (Main Managing Agent). You keep the human's main Chat-Tab calm, concise, and strategic while directly managing projects, runtime configuration, bots, task boards, and Team Lead delegations.",
      toolsBrief: [
        "Direct management tools available to you:",
        "- Projects: `bf_projects_list`, `bf_project_create` (provision projects under ~/bot-factory/projects/<slug>/ with optional externalRepoPath & verifyChecks).",
        "- Config & Routing: `bf_config_get` (inspect scrubbed providers, models, routing defaults, hub host/port, memory & guardrails), `bf_config_update` (hot-reload config patches and per-project routing overrides).",
        "- Bots: `bf_bot_spawn` (spawn project, peer, sidekick, or verifier bots), `bf_bot_update_model` (switch a bot's provider & model), `bf_bot_message` (send a direct orchestrator message to any project bot).",
        "- Tasks & Teams: `bf_task_list` (inspect project tasks, assignees & DAG dependencies), `bf_task_create`, `bf_task_update` (status/spec/priority/assignee), `bf_task_dispatch` (dispatch ready tasks), `bf_team_delegate` (delegate high-level goals to the Team Lead), `bf_team_status` (inspect teams, tasks, goals, verifications, and open debates).",
        "- Memory: `bf_memory_search`, `bf_memory_remember`, `bf_memory_update_l1`, `bf_memory_forget`.",
        "Use these tools directly when asked rather than claiming you cannot inspect or update config, bots, or tasks.",
      ].join("\n"),
    };
  }

  private buildAgentSystemPrompt(agent: Pick<AgentRecord, "scope" | "name" | "projectId" | "worktreePath" | "provider" | "model">): {
    systemPrompt: string;
    hash: string;
  } {
    const pluginBlocks = loadActivePluginBlocks(this.runtimeCfg.pluginsDir);
    const modelLabel = `${agent.provider}/${agent.model}`;
    if (agent.scope === "global") {
      const metaSpec = this.getMetaPromptSpec();
      return this.memory.buildFrozenSystemPrompt({
        identity: metaSpec.identity,
        toolsBrief: metaSpec.toolsBrief,
        namespace: "global",
        modelLabel,
        pluginBlocks,
      });
    }

    const project = agent.projectId ? this.db.getProject(agent.projectId) : null;
    const slug = project?.slug ?? "unknown";
    const projectName = project?.name ?? slug;
    if (agent.scope === "project") {
      return this.memory.buildFrozenSystemPrompt({
        identity: `You are the Project Manager for '${projectName}' (${slug}). You own plans/, the Task Board, operator Steers, and Preview Annotations.`,
        toolsBrief: "Break goals into crisp tasks, translate steers/annotations into targeted fix tasks, and coordinate peer bots cleanly.",
        projectContext: `Project slug: ${slug}\nPlans dir: plans/\nArtifacts dir: artifacts/`,
        worktreePath: agent.worktreePath ?? project?.repoPath,
        namespace: `project:${slug}`,
        projectRoot: project?.rootPath,
        modelLabel,
        pluginBlocks,
      });
    }

    return this.memory.buildFrozenSystemPrompt({
      identity: `You are autonomous ${agent.scope} bot '${agent.name}' working on project '${projectName}'.`,
      toolsBrief: "Work cleanly inside your isolated Git worktree, produce concise handoffs, and avoid unrelated changes.",
      projectContext: `Project: ${projectName} (${slug})`,
      worktreePath: agent.worktreePath,
      namespace: `project:${slug}`,
      projectRoot: project?.rootPath,
      modelLabel,
      pluginBlocks,
    });
  }

  private ensureMetaOrchestrator(): AgentRecord {
    const existing = this.db.getAgent(this.metaAgentId);
    if (existing) {
      if (existing.activeSessionId) {
        const sess = this.db.getSession(existing.activeSessionId);
        if (sess && !sess.systemPrompt.includes("bf_config_get")) {
          const metaSpec = this.getMetaPromptSpec();
          const rebuilt = this.memory.buildFrozenSystemPrompt({
            identity: metaSpec.identity,
            toolsBrief: metaSpec.toolsBrief,
            namespace: "global",
            modelLabel: `${existing.provider}/${existing.model}`,
            pluginBlocks: loadActivePluginBlocks(this.runtimeCfg.pluginsDir),
          });
          this.db.runAtomicWrite(() => {
            this.db.updateSessionSystemPrompt(sess.id, rebuilt.systemPrompt, rebuilt.hash);
          });
        }
      }
      return existing;
    }

    const route = this.router.resolveIntent("meta_orchestrator");
    const now = Date.now();
    const sessionId = newId("ses");
    const metaSpec = this.getMetaPromptSpec();
    const { systemPrompt, hash } = this.memory.buildFrozenSystemPrompt({
      identity: metaSpec.identity,
      toolsBrief: metaSpec.toolsBrief,
      namespace: "global",
      modelLabel: `${route.provider}/${route.model}`,
      pluginBlocks: loadActivePluginBlocks(this.runtimeCfg.pluginsDir),
    });

    const meta: AgentRecord = {
      id: this.metaAgentId,
      projectId: null,
      parentAgentId: null,
      scope: "global",
      name: "Meta-Orchestrator",
      runtimeType: route.runtimeKind,
      provider: route.provider,
      model: route.model,
      status: "idle",
      worktreePath: this.runtimeCfg.rootDir,
      worktreeBranch: null,
      pid: null,
      activeSessionId: sessionId,
      lastSummary: "Ready on local hub (127.0.0.1).",
      updatedAt: now,
    };

    this.db.runAtomicWrite(() => {
      this.db.upsertAgent(meta);
      this.db.createSession({
        id: sessionId,
        agentId: meta.id,
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
    });

    return meta;
  }

  private getRuntime(kind: AgentRecord["runtimeType"]): AgentRuntime {
    if (kind === "acp_stdio") return this.acpRuntime;
    if (kind === "cli_stream") {
      if (!this.cliRuntime) {
        throw new Error("cli_stream_runtime_unavailable");
      }
      return this.cliRuntime;
    }
    return this.nativeRuntime;
  }

  private toPermissionRequestRecord(req: PendingAcpPermissionRecord): PermissionRequestRecord {
    const agent = this.db.getAgent(req.agentId);
    return {
      id: req.permissionId,
      agentId: req.agentId,
      sessionId: req.sessionId,
      projectId: agent?.projectId ?? null,
      agentName: agent?.name,
      title: req.title,
      commandOrPath: req.commandOrPath,
      reason: req.reason,
      status: "pending",
      decision: null,
      createdAt: req.createdAt,
      expiresAt: req.expiresAt,
    };
  }

  private handleAcpPermissionRequested(req: PendingAcpPermissionRecord): void {
    const record = this.toPermissionRequestRecord(req);
    this.db.runAtomicWrite(() => {
      const agent = this.db.getAgent(req.agentId);
      if (agent && agent.status !== "paused" && agent.status !== "stopped") {
        this.db.updateAgentStatus(agent.id, "requires_action", {
          lastSummary: `Awaiting permission: ${record.title.slice(0, 60)}`,
        });
      }
      this.db.addInboxNotice(
        "action",
        `Permission requested (${record.agentName ?? record.agentId}): ${record.title} — ${record.commandOrPath}`.slice(0, 200),
        { projectId: record.projectId ?? undefined, agentId: record.agentId },
      );
    });
    this.core.emitDirectEvent(`bot:${req.agentId}:timeline`, "permission.requested", record);
    this.core.emitDirectEvent("global:status", "permission.requested", record);
    this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
  }

  private recordTurnFailure(params: {
    agentId: string;
    projectId?: string;
    emitTopic: SubscriptionTopic;
    eventType: "chat.message" | "timeline.item";
    itemKind: "message" | "status";
    title: string;
    error: string;
    noticeLevel: "warn" | "action";
    noticePrefix: string;
  }): void {
    const cleanErr = this.scrubber.scrub(params.error);
    const agent = this.db.getAgent(params.agentId);
    if (!agent || agent.status === "paused" || agent.status === "stopped") return;

    const item: TimelineItem = {
      id: newId("msg"),
      agentId: agent.id,
      sessionId: agent.activeSessionId ?? newId("ses"),
      seq: 0,
      kind: params.itemKind,
      role: "system",
      title: params.title,
      content: `Error: ${cleanErr}`,
      createdAt: Date.now(),
    };

    this.db.runAtomicWrite(() => {
      if (agent.activeSessionId) {
        this.db.appendMessage(item);
      }
      this.db.addInboxNotice(params.noticeLevel, `${params.noticePrefix}: ${cleanErr.slice(0, 120)}`, {
        projectId: params.projectId,
        agentId: agent.id,
      });
    });

    this.core.emitDirectEvent(params.emitTopic, params.eventType, item);
    this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
  }

  private registerOutboxHandlers(): void {
    this.core.registerEffectHandler(
      "meta.chat.turn",
      async (eff) => {
        const text = String(eff.payload.text ?? "");
        const projectId =
          typeof eff.payload.projectId === "string" && eff.payload.projectId ? eff.payload.projectId : undefined;
        const reasoningEffort = eff.payload.reasoningEffort as ReasoningEffort | undefined;
        const autonomyLevel = eff.payload.autonomyLevel as AutonomyLevel | undefined;
        const turn = await this.runAgentTurn(this.metaAgentId, text, {
          emitTopic: "chat:meta",
          namespace: "global",
          projectId,
          reasoningEffort,
          autonomyLevel,
        });
        if (!turn.ok) {
          this.recordTurnFailure({
            agentId: this.metaAgentId,
            emitTopic: "chat:meta",
            eventType: "chat.message",
            itemKind: "message",
            title: "Meta-Orchestrator turn failed",
            error: turn.error ?? "Meta-Orchestrator turn failed",
            noticeLevel: "warn",
            noticePrefix: "Meta-Orchestrator error",
          });
        }
      },
      { lane: "interactive", concurrencyKey: () => `agent:${this.metaAgentId}` },
    );

    this.core.registerEffectHandler(
      "pm.steer.turn",
      async (eff) => {
        const projectId = String(eff.payload.projectId ?? "");
        const pmAgentId = String(eff.payload.pmAgentId ?? "");
        const message = String(eff.payload.message ?? "");
        const reasoningEffort = eff.payload.reasoningEffort as ReasoningEffort | undefined;
        const autonomyLevel = eff.payload.autonomyLevel as AutonomyLevel | undefined;
        const project = this.db.getProject(projectId);
        if (!project) return;

        await this.memory.ingestDocument({
          docId: `steer:${projectId}:${Date.now()}`,
          namespace: `project:${project.slug}`,
          content: `Decision / Steer from operator: ${message}`,
          instant: true,
        });

        const turn = await this.runAgentTurn(
          pmAgentId,
          `Operator Steer (highest priority): ${message}\nUpdate plan/tasks and report concise next steps.`,
          {
            emitTopic: `bot:${pmAgentId}:timeline`,
            namespace: `project:${project.slug}`,
            reasoningEffort,
            autonomyLevel,
          },
        );
        if (!turn.ok) {
          this.recordTurnFailure({
            agentId: pmAgentId,
            projectId,
            emitTopic: `bot:${pmAgentId}:timeline`,
            eventType: "timeline.item",
            itemKind: "status",
            title: "PM steer failed",
            error: turn.error ?? "PM steer turn failed",
            noticeLevel: "action",
            noticePrefix: `PM steer failed (${project.name})`,
          });
        }

        this.core.emitDirectEvent(`project:${projectId}:board`, "board.updated", this.getProjectBoardSnapshot(projectId));
        this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
      },
      { lane: "interactive", concurrencyKey: (eff) => `agent:${String(eff.payload.pmAgentId ?? "")}` },
    );

    this.core.registerEffectHandler(
      "task.run",
      async (eff) => {
        const projectId = String(eff.payload.projectId ?? "");
        const taskId = String(eff.payload.taskId ?? "");
        const agentId = String(eff.payload.agentId ?? "");
        await this.executePeerTask(projectId, taskId, agentId);
      },
      { lane: "work", concurrencyKey: (eff) => `agent:${String(eff.payload.agentId ?? "")}` },
    );

    this.core.registerEffectHandler(
      "bot.abort",
      async (eff) => {
        const agentId = String(eff.payload.agentId ?? "");
        const mode = eff.payload.mode === "pause" ? "pause" : "hard_stop";
        const agent = this.db.getAgent(agentId);
        if (!agent) return;
        await this.abortAndCloseAgentSession(agent, mode);
        if (mode === "hard_stop") {
          await this.subagentManager.cleanupSubagentsForParent(agentId);
          await this.cleanupUnusedWorktreeOnHardStop(agentId);
        }
      },
      { lane: "control", concurrencyKey: (eff) => `ctrl:${String(eff.payload.agentId ?? "")}` },
    );

    this.core.registerEffectHandler(
      "pm.goal.turn",
      async (eff) => {
        const projectId = String(eff.payload.projectId ?? "");
        const pmAgentId = String(eff.payload.pmAgentId ?? "");
        const goalId = String(eff.payload.goalId ?? "");
        const goal = String(eff.payload.goal ?? "");
        const reasoningEffort = eff.payload.reasoningEffort as ReasoningEffort | undefined;
        const autonomyLevel = eff.payload.autonomyLevel as AutonomyLevel | undefined;
        const project = this.db.getProject(projectId);
        if (!project) return;

        await this.memory
          .ingestDocument({
            docId: `goal:${projectId}:${goalId}`,
            namespace: `project:${project.slug}`,
            content: `Delegated Goal (${goalId}): ${goal}`,
            instant: true,
          })
          .catch(() => {});

        const goalPrompt = [
          `Delegated Goal (${goalId}) for project '${project.name}':`,
          goal,
          "",
          "Use your Team Lead tools (`bf_repo_tree`, `bf_repo_read`, `bf_task_create_batch`, `bf_bot_spawn`, `bf_task_dispatch`) to inspect the codebase, create a crisp task DAG, and dispatch ready root tasks with autonomous=true. The autonomous loop will verify completed tasks and wake you when all tasks pass verification or if any task blocks so you can report via `bf_report_to_manager`.",
        ].join("\n");

        const turn = await this.runAgentTurn(pmAgentId, goalPrompt, {
          emitTopic: `bot:${pmAgentId}:timeline`,
          namespace: `project:${project.slug}`,
          reasoningEffort,
          autonomyLevel,
        });
        if (!turn.ok) {
          this.recordTurnFailure({
            agentId: pmAgentId,
            projectId,
            emitTopic: `bot:${pmAgentId}:timeline`,
            eventType: "timeline.item",
            itemKind: "status",
            title: "PM goal turn failed",
            error: turn.error ?? "PM goal turn failed",
            noticeLevel: "action",
            noticePrefix: `PM goal turn failed (${project.name})`,
          });
        } else {
          this.autonomyLoop.dispatchUnblockedTasks(projectId, goalId);
        }

        this.core.emitDirectEvent(`project:${projectId}:board`, "board.updated", this.getProjectBoardSnapshot(projectId));
        this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
      },
      { lane: "interactive", concurrencyKey: (eff) => `agent:${String(eff.payload.pmAgentId ?? "")}` },
    );

    this.core.registerEffectHandler(
      "pm.goal.check",
      async (eff) => {
        await this.autonomyLoop.executePmGoalCheck({
          projectId: String(eff.payload.projectId ?? ""),
          pmAgentId: String(eff.payload.pmAgentId ?? ""),
          goalId: String(eff.payload.goalId ?? ""),
          outcome: (eff.payload.outcome as "all_verified" | "task_blocked" | "needs_human") ?? "all_verified",
          taskId: typeof eff.payload.taskId === "string" ? eff.payload.taskId : undefined,
          findings: Array.isArray(eff.payload.findings) ? eff.payload.findings.map(String) : undefined,
          checkKey: typeof eff.payload.checkKey === "string" ? eff.payload.checkKey : undefined,
        });
      },
      { lane: "interactive", concurrencyKey: (eff) => `agent:${String(eff.payload.pmAgentId ?? "")}` },
    );

    this.core.registerEffectHandler(
      "meta.team_report",
      async (eff) => {
        const projectId = String(eff.payload.projectId ?? "");
        const projectName = String(eff.payload.projectName ?? projectId);
        const goalId = typeof eff.payload.goalId === "string" ? eff.payload.goalId : null;
        const status = String(eff.payload.status ?? "milestone");
        const summary = this.scrubber.scrub(String(eff.payload.summary ?? ""));
        const verifiedTaskIds = Array.isArray(eff.payload.verifiedTaskIds)
          ? eff.payload.verifiedTaskIds.map(String)
          : [];
        const blockedReasons = Array.isArray(eff.payload.blockedReasons)
          ? eff.payload.blockedReasons.map((r) => this.scrubber.scrub(String(r)))
          : [];

        const card = {
          id: newId("card"),
          projectId,
          goalId,
          kind: status === "completed" ? "review_merge" : status === "blocked" ? "blocked" : "milestone",
          status,
          title:
            status === "completed"
              ? `Ready to Review & Merge: ${projectName}`
              : status === "blocked"
                ? `Attention Needed: ${projectName}`
                : `Milestone Update: ${projectName}`,
          subtitle: summary.slice(0, 180),
          verifiedTaskIds,
          blockedReasons,
          createdAt: Date.now(),
        };
        this.core.emitDirectEvent("chat:meta", "chat.artifact_card", card);

        const prompt = [
          `Team Lead Report received for '${projectName}' (${projectId}):`,
          `- Status: ${status}`,
          goalId ? `- Goal ID: ${goalId}` : "",
          verifiedTaskIds.length > 0 ? `- Verified Tasks: ${verifiedTaskIds.join(", ")}` : "",
          blockedReasons.length > 0 ? `- Blocked Reasons: ${blockedReasons.join("; ")}` : "",
          `- Summary: ${summary}`,
          "",
          "Present a calm, concise executive briefing for the operator summarizing the verified outcome and clear Review/Merge next steps.",
        ]
          .filter(Boolean)
          .join("\n");

        const turn = await this.runAgentTurn(this.metaAgentId, prompt, {
          emitTopic: "chat:meta",
          namespace: "global",
          projectId: projectId || undefined,
        });
        if (!turn.ok) {
          this.recordTurnFailure({
            agentId: this.metaAgentId,
            projectId: projectId || undefined,
            emitTopic: "chat:meta",
            eventType: "chat.message",
            itemKind: "message",
            title: "Meta-Orchestrator report briefing failed",
            error: turn.error ?? "Meta-Orchestrator team report failed",
            noticeLevel: "warn",
            noticePrefix: "Meta-Orchestrator report error",
          });
        }
      },
      { lane: "interactive", concurrencyKey: () => `agent:${this.metaAgentId}` },
    );

    this.core.registerEffectHandler(
      "subagent.run",
      async (eff) => {
        await this.subagentManager.executeSubagentTurn({
          projectId: String(eff.payload.projectId ?? ""),
          parentAgentId: String(eff.payload.parentAgentId ?? ""),
          subagentId: String(eff.payload.subagentId ?? ""),
          prompt: String(eff.payload.prompt ?? ""),
        });
      },
      { lane: "work", concurrencyKey: (eff) => `agent:${String(eff.payload.subagentId ?? "")}` },
    );

    this.core.registerEffectHandler(
      "bot.message.turn",
      async (eff) => {
        const projectId = String(eff.payload.projectId ?? "");
        const agentId = String(eff.payload.agentId ?? "");
        const message = String(eff.payload.message ?? "");
        const project = this.db.getProject(projectId);
        const agent = this.db.getAgent(agentId);
        if (!project || !agent || agent.status === "stopped" || agent.status === "paused") return;

        const turn = await this.runAgentTurn(agent.id, message, {
          emitTopic: `bot:${agent.id}:timeline`,
          namespace: `project:${project.slug}`,
        });
        if (!turn.ok) {
          this.recordTurnFailure({
            agentId: agent.id,
            projectId,
            emitTopic: `bot:${agent.id}:timeline`,
            eventType: "timeline.item",
            itemKind: "status",
            title: "Bot guidance turn failed",
            error: turn.error ?? "Bot guidance turn failed",
            noticeLevel: "warn",
            noticePrefix: `${agent.name} turn error`,
          });
        }

        this.core.emitDirectEvent(`project:${projectId}:board`, "board.updated", this.getProjectBoardSnapshot(projectId));
        this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
      },
      { lane: "work", concurrencyKey: (eff) => `agent:${String(eff.payload.agentId ?? "")}` },
    );

    this.core.registerEffectHandler(
      "task.merge.run",
      async (eff) => {
        await this.executeTaskMerge({
          projectId: String(eff.payload.projectId ?? ""),
          taskId: String(eff.payload.taskId ?? ""),
          agentId: typeof eff.payload.agentId === "string" ? eff.payload.agentId : null,
          worktreePath: String(eff.payload.worktreePath ?? ""),
          branch: String(eff.payload.branch ?? ""),
          strategy: eff.payload.strategy === "merge_commit" ? "merge_commit" : "squash",
          commitMessage: String(eff.payload.commitMessage ?? ""),
        });
      },
      { lane: "control", concurrencyKey: (eff) => `merge:${String(eff.payload.projectId ?? eff.id)}` },
    );

    this.core.registerEffectHandler(
      "task.verify.run",
      async (eff) => {
        const projectId = String(eff.payload.projectId ?? "");
        const taskId = String(eff.payload.taskId ?? "");
        const checks = Array.isArray(eff.payload.checks) ? eff.payload.checks.map(String) : undefined;
        await this.executeTaskVerification(projectId, taskId, checks);
      },
      {
        lane: "work",
        concurrencyKey: (eff) => String(eff.payload.taskId ?? eff.payload.proposalId ?? eff.payload.debateId ?? eff.id),
      },
    );

    this.core.registerEffectHandler(
      "selfmod.verify.run",
      async (eff) => {
        const proposalId = String(eff.payload.proposalId ?? "");
        await this.executeSelfModVerification(proposalId);
      },
      {
        lane: "work",
        concurrencyKey: (eff) => String(eff.payload.taskId ?? eff.payload.proposalId ?? eff.payload.debateId ?? eff.id),
      },
    );

    this.core.registerEffectHandler(
      "debate.escalate.pm",
      async (eff) => {
        const projectId = String(eff.payload.projectId ?? "");
        const debateId = String(eff.payload.debateId ?? "");
        await this.executeDebatePmEscalation(projectId, debateId);
      },
      {
        lane: "work",
        concurrencyKey: (eff) => String(eff.payload.taskId ?? eff.payload.proposalId ?? eff.payload.debateId ?? eff.id),
      },
    );

    this.core.registerEffectHandler(
      "checkpoint.rollback.run",
      async (eff) => {
        const projectId = String(eff.payload.projectId ?? "");
        const agentId = String(eff.payload.agentId ?? "");
        const currentCwd = String(eff.payload.currentCwd ?? "");
        const checkpointId = String(eff.payload.checkpointId ?? "");
        await this.executeCheckpointRollback(projectId, agentId, currentCwd, checkpointId);
      },
      {
        lane: "control",
        concurrencyKey: (eff) => `ckpt:${String(eff.payload.agentId ?? eff.id)}`,
      },
    );
  }

  public executeCommand(cmd: RpcCommand): unknown {
    // Receipt short-circuit BEFORE any pre-commit I/O (T3 idempotency invariant)
    const existingReceipt = this.db.getCommandReceipt(cmd.commandId);
    if (existingReceipt !== null) {
      return existingReceipt;
    }

    switch (cmd.type) {
      case "chat.send":
        return this.handleChatSend(cmd);
      case "project.create":
        return this.handleProjectCreate(cmd);
      case "project.archive":
        return this.handleProjectArchive(cmd);
      case "bot.spawn":
        return this.handleBotSpawn(cmd);
      case "bot.pause":
        return this.handleBotControl(cmd.commandId, cmd.agentId, "pause");
      case "bot.stop":
        return this.handleBotControl(cmd.commandId, cmd.agentId, "hard_stop");
      case "bot.resume":
        return this.handleBotResume(cmd);
      case "bot.update_model":
        return this.handleBotUpdateModel(cmd);
      case "bot.message":
        return this.handleBotMessage(cmd);
      case "permission.respond":
        return this.handlePermissionRespond(cmd);
      case "steer.submit":
        return this.handleSteerSubmit(cmd);
      case "task.create":
        return this.handleTaskCreate(cmd);
      case "task.dispatch":
        return this.handleTaskDispatch(cmd);
      case "task.verify":
        return this.handleTaskVerify(cmd);
      case "task.merge":
        return this.handleTaskMerge(cmd);
      case "annotation.create":
        return this.handleAnnotationCreate(cmd);
      case "annotation.resolve":
        return this.handleAnnotationResolve(cmd);
      case "session.resolve_unknown":
        return this.handleResolveUnknownAdmission(cmd);
      case "debate.open":
        return this.handleDebateOpen(cmd);
      case "debate.post":
        return this.handleDebatePost(cmd);
      case "debate.resolve":
        return this.handleDebateResolve(cmd);
      case "selfmod.propose":
        return this.handleSelfModPropose(cmd);
      case "selfmod.verify":
        return this.handleSelfModVerify(cmd);
      case "selfmod.promote":
        return this.handleSelfModPromote(cmd);
      case "selfmod.rollback":
        return this.handleSelfModRollback(cmd);
      case "config.update":
        return this.handleConfigUpdate(cmd);
      case "routing.set_override":
        return this.handleRoutingSetOverride(cmd);
      case "memory.l1.get":
        return this.handleMemoryL1Get(cmd);
      case "memory.l1.update":
        return this.handleMemoryL1Update(cmd);
      case "checkpoint.list":
        return this.handleCheckpointList(cmd);
      case "checkpoint.rollback":
        return this.handleCheckpointRollback(cmd);
      case "inbox.dismiss":
        return this.handleInboxDismiss(cmd);
      default: {
        const _exhaustive: never = cmd;
        throw new Error(`unsupported_command:${String((_exhaustive as { type?: unknown })?.type ?? "unknown")}`);
      }
    }
  }

  private handleChatSend(cmd: Extract<RpcCommand, { type: "chat.send" }>) {
    const meta = this.ensureMetaOrchestrator();
    const sessionId = meta.activeSessionId!;
    const now = Date.now();
    const cleanText = this.scrubber.scrub(cmd.text);
    if (cmd.projectId && !this.db.getProject(cmd.projectId)) {
      throw new Error(`Project not found: ${cmd.projectId}`);
    }

    const userMsg: TimelineItem = {
      id: newId("msg"),
      agentId: meta.id,
      sessionId,
      seq: 0,
      kind: "message",
      role: "user",
      content: cleanText,
      createdAt: now,
    };

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { messageId: userMsg.id },
      applyProjections: () => {
        this.db.appendMessage(userMsg);
        this.db.updateAgentStatus(meta.id, "working");
      },
      events: [
        { topic: "chat:meta", eventType: "chat.message", payload: userMsg },
        { topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() },
      ],
      effects: [
        {
          effectType: "meta.chat.turn",
          payload: {
            text: cleanText,
            ...(cmd.projectId ? { projectId: cmd.projectId } : {}),
            ...(cmd.reasoningEffort ? { reasoningEffort: cmd.reasoningEffort } : {}),
            ...(cmd.autonomyLevel ? { autonomyLevel: cmd.autonomyLevel } : {}),
          },
        },
      ],
    }));
  }

  private handleProjectCreate(cmd: Extract<RpcCommand, { type: "project.create" }>) {
    const baseSlug = slugify(cmd.slug ?? cmd.name);
    let slug = baseSlug;
    let suffix = 2;
    while (this.db.getProject(slug)) {
      slug = `${baseSlug}-${suffix++}`;
    }

    const provisioned = provisionProjectWorkspace({
      projectsDir: this.runtimeCfg.projectsDir,
      slug,
      name: cmd.name,
      externalRepoPath: cmd.externalRepoPath,
      seedDemoArtifacts: cmd.seedDemoArtifacts ?? true,
    });

    const projectId = newId("prj");
    const pmId = newId("bot");
    const pmSessionId = newId("ses");
    const pmRoute = this.router.resolveIntent("project_manager");
    const now = Date.now();

    const project: ProjectRecord = {
      id: projectId,
      slug,
      name: cmd.name,
      rootPath: provisioned.rootPath,
      repoPath: provisioned.repoPath,
      routingOverrides: {},
      verifyChecks: cmd.verifyChecks ?? [],
      status: "active",
      createdAt: now,
    };

    const { systemPrompt, hash } = this.memory.buildFrozenSystemPrompt({
      identity: `You are the Project Manager for '${cmd.name}' (${slug}). You own plans/, the Task Board, operator Steers, and Preview Annotations.`,
      toolsBrief: "Break goals into crisp tasks, translate steers/annotations into targeted fix tasks, and coordinate peer bots cleanly.",
      projectContext: `Project slug: ${slug}\nPlans dir: plans/\nArtifacts dir: artifacts/`,
      worktreePath: provisioned.repoPath,
      namespace: `project:${slug}`,
      projectRoot: provisioned.rootPath,
      modelLabel: `${pmRoute.provider}/${pmRoute.model}`,
      pluginBlocks: loadActivePluginBlocks(this.runtimeCfg.pluginsDir),
    });

    const pmAgent: AgentRecord = {
      id: pmId,
      projectId,
      parentAgentId: this.metaAgentId,
      scope: "project",
      name: `${cmd.name} PM`,
      runtimeType: pmRoute.runtimeKind,
      provider: pmRoute.provider,
      model: pmRoute.model,
      status: "idle",
      worktreePath: provisioned.repoPath,
      worktreeBranch: "main",
      pid: null,
      activeSessionId: pmSessionId,
      lastSummary: `Project workspace ready at ${provisioned.rootPath}`,
      updatedAt: now,
    };

    const starterTask: TaskRecord = {
      id: newId("tsk"),
      projectId,
      parentTaskId: null,
      title: `Review initial roadmap & artifacts for ${cmd.name}`,
      specMd: "Inspect plans/roadmap.md and verify repository bootstrap.",
      status: "ready",
      priority: 2,
      assignedAgentId: null,
      sourceAnnotationId: null,
      worktreeBranch: null,
      handoffPath: null,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { project, projectManager: pmAgent, starterTask },
      applyProjections: () => {
        this.db.insertProject(project);
        this.db.upsertAgent(pmAgent);
        this.db.createSession({
          id: pmSessionId,
          agentId: pmId,
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
        this.db.upsertTask(starterTask);
        this.db.addInboxNotice("info", `Project '${project.name}' provisioned (${slug})`, { projectId });
      },
      events: [
        { topic: "global:status", eventType: "project.created", payload: { project, projectManager: pmAgent } },
        {
          topic: "chat:meta",
          eventType: "chat.artifact_card",
          payload: {
            id: newId("card"),
            projectId,
            title: `Project provisioned: ${project.name}`,
            subtitle: `~/bot-factory/projects/${slug}/ · PM ready · Preview artifacts seeded`,
            artifactPath: "plans/roadmap.md",
            createdAt: now,
          },
        },
      ],
      effects: [],
    }));
  }

  private hasMultimodalCapability(provider: string, model: string): boolean {
    const caps = this.runtimeCfg.config.providers[provider]?.models[model]?.capabilities ?? [];
    return caps.includes("multimodal") || caps.includes("vision");
  }

  private findIdlePeerForRoute(
    projectId: string,
    intent: string,
    route: { provider: string; model: string },
  ): AgentRecord | undefined {
    const idlePeers = this.db.listAgents(projectId).filter((a) => a.scope === "peer" && a.status === "idle");
    const exact = idlePeers.find((a) => a.provider === route.provider && a.model === route.model);
    if (exact) return exact;
    if (intent === "vision_fix") {
      return idlePeers.find((a) => this.hasMultimodalCapability(a.provider, a.model));
    }
    return idlePeers[0];
  }

  private handleBotSpawn(cmd: Extract<RpcCommand, { type: "bot.spawn" }>) {
    const project = this.db.getProject(cmd.projectId);
    if (!project) throw new Error(`Project not found: ${cmd.projectId}`);

    const existingAgents = this.db.listAgents(project.id);
    if (cmd.scope === "global") {
      throw new Error("duplicate_global_agent_not_allowed");
    }
    if (cmd.scope === "project" && existingAgents.some((a) => a.scope === "project" && a.status !== "stopped")) {
      throw new Error("duplicate_project_agent");
    }

    const existingPeers = existingAgents.filter((a) => a.scope === "peer" && a.status !== "stopped");
    if (cmd.scope === "peer" && existingPeers.length >= this.runtimeCfg.config.guardrails.maxConcurrentBotsPerProject) {
      throw new Error(`max_concurrent_bots_reached (${this.runtimeCfg.config.guardrails.maxConcurrentBotsPerProject})`);
    }

    const intent = cmd.scope === "verifier" ? "verifier_default" : cmd.scope === "sidekick" ? "sidekick" : "coding_parallel";
    const route =
      cmd.provider && cmd.model
        ? this.router.resolveTarget({ provider: cmd.provider, model: cmd.model })
        : this.router.resolveIntent(intent, { projectOverrides: project.routingOverrides });

    const agentId = newId("bot");
    const sessionId = newId("ses");
    const now = Date.now();

    let worktreePath = project.repoPath;
    let worktreeBranch: string | null = "main";
    let createdWorktreePath: string | null = null;
    if (cmd.scope === "peer") {
      const wt = createBotWorktree({
        projectRoot: project.rootPath,
        repoPath: project.repoPath,
        agentId,
        taskId: cmd.taskId ?? newId("wk"),
      });
      worktreePath = wt.worktreePath;
      worktreeBranch = wt.branch;
      createdWorktreePath = wt.worktreePath;
    }

    const pm =
      existingAgents.find((a) => a.scope === "project" && a.status !== "stopped") ??
      existingAgents.find((a) => a.scope === "project");
    const requestedParentId = cmd.parentAgentId;
    let parentAgentId: string | null = pm?.id ?? null;
    if (cmd.scope === "project") {
      parentAgentId = this.metaAgentId;
    } else if (cmd.scope === "sidekick" && requestedParentId) {
      const parent = this.db.getAgent(requestedParentId);
      if (!parent) throw new Error(`Parent agent not found: ${requestedParentId}`);
      if (parent.projectId !== project.id) throw new Error("agent_project_mismatch");
      parentAgentId = parent.id;
    }

    const { systemPrompt, hash } = this.memory.buildFrozenSystemPrompt({
      identity: `You are autonomous ${cmd.scope} bot '${cmd.name}' working on project '${project.name}'.`,
      toolsBrief: "Work cleanly inside your isolated Git worktree, produce concise handoffs, and avoid unrelated changes.",
      projectContext: `Project: ${project.name} (${project.slug})`,
      worktreePath,
      namespace: `project:${project.slug}`,
      projectRoot: project.rootPath,
      modelLabel: `${route.provider}/${route.model}`,
      pluginBlocks: loadActivePluginBlocks(this.runtimeCfg.pluginsDir),
    });

    if (cmd.autonomyLevel || cmd.reasoningEffort) {
      this.agentTurnPrefs.set(agentId, {
        autonomyLevel: cmd.autonomyLevel,
        reasoningEffort: cmd.reasoningEffort,
      });
    }

    const bot: AgentRecord = {
      id: agentId,
      projectId: project.id,
      parentAgentId,
      scope: cmd.scope,
      name: cmd.name,
      runtimeType: route.runtimeKind,
      provider: route.provider,
      model: route.model,
      status: "idle",
      worktreePath,
      worktreeBranch,
      pid: null,
      activeSessionId: sessionId,
      lastSummary: `Worktree ready (${worktreeBranch})`,
      autonomyLevel: cmd.autonomyLevel,
      reasoningEffort: cmd.reasoningEffort,
      updatedAt: now,
    };

    try {
      return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
        result: { agent: bot },
        applyProjections: () => {
          this.db.upsertAgent(bot);
          this.db.createSession({
            id: sessionId,
            agentId,
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
        },
        events: [
          { topic: "global:status", eventType: "agent.spawned", payload: bot },
          { topic: `project:${project.id}:board`, eventType: "agent.spawned", payload: bot },
        ],
        effects: [],
      }));
    } catch (err) {
      if (createdWorktreePath) {
        try {
          removeBotWorktree(project.repoPath, createdWorktreePath);
        } catch {
          // Best-effort orphan worktree cleanup
        }
      }
      throw err;
    }
  }

  private handleBotControl(commandId: string, agentId: string, mode: "pause" | "hard_stop") {
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    const nextStatus = mode === "pause" ? "paused" : "stopped";

    return this.core.commitCommand(commandId, mode === "pause" ? "bot.pause" : "bot.stop", () => ({
      result: { agentId, status: nextStatus },
      applyProjections: () => {
        this.db.updateAgentStatus(agentId, nextStatus, {
          pid: mode === "hard_stop" ? null : undefined,
          lastSummary: mode === "pause" ? "Paused by operator" : "Hard-stopped by operator",
        });
      },
      events: [
        { topic: `bot:${agentId}:timeline`, eventType: "agent.status", payload: { agentId, status: nextStatus } },
        { topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() },
      ],
      effects: [{ effectType: "bot.abort", payload: { agentId, mode } }],
    }));
  }

  private handleSteerSubmit(cmd: Extract<RpcCommand, { type: "steer.submit" }>) {
    const project = this.db.getProject(cmd.projectId);
    if (!project) throw new Error(`Project not found: ${cmd.projectId}`);
    const pm = this.db.listAgents(project.id).find((a) => a.scope === "project");
    if (!pm || !pm.activeSessionId) throw new Error(`Project Manager missing for project: ${project.id}`);

    const cleanMsg = this.scrubber.scrub(cmd.message);
    const now = Date.now();
    const steerItem: TimelineItem = {
      id: newId("msg"),
      agentId: pm.id,
      sessionId: pm.activeSessionId,
      seq: 0,
      kind: "steer",
      role: "user",
      title: "Operator Steer → Project Manager",
      content: cleanMsg,
      createdAt: now,
    };

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { pmAgentId: pm.id, steerId: steerItem.id },
      applyProjections: () => {
        this.db.appendMessage(steerItem);
        this.db.updateAgentStatus(pm.id, "working", { lastSummary: `Steer received: ${cleanMsg.slice(0, 70)}` });
      },
      events: [
        { topic: `bot:${pm.id}:timeline`, eventType: "timeline.item", payload: steerItem },
        { topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() },
      ],
      effects: [
        {
          effectType: "pm.steer.turn",
          payload: {
            projectId: project.id,
            pmAgentId: pm.id,
            message: cleanMsg,
            ...(cmd.reasoningEffort ? { reasoningEffort: cmd.reasoningEffort } : {}),
            ...(cmd.autonomyLevel ? { autonomyLevel: cmd.autonomyLevel } : {}),
          },
        },
      ],
    }));
  }

  private handleTaskCreate(cmd: Extract<RpcCommand, { type: "task.create" }>) {
    const project = this.db.getProject(cmd.projectId);
    if (!project) throw new Error(`Project not found: ${cmd.projectId}`);
    const dependsOn = [...new Set(cmd.dependsOn ?? [])];
    for (const depId of dependsOn) {
      const depTask = this.db.getTask(depId);
      if (!depTask || depTask.projectId !== project.id) {
        throw new Error(`unknown_dependency_task:${depId}`);
      }
    }

    const now = Date.now();
    const task: TaskRecord = {
      id: newId("tsk"),
      projectId: project.id,
      parentTaskId: null,
      title: cmd.title,
      specMd: cmd.specMd,
      status: "ready",
      priority: cmd.priority,
      assignedAgentId: null,
      sourceAnnotationId: null,
      worktreeBranch: null,
      handoffPath: null,
      retryCount: 0,
      dependsOn,
      autoRetryCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { task },
      applyProjections: () => {
        this.db.upsertTask(task);
      },
      events: [{ topic: `project:${project.id}:board`, eventType: "task.created", payload: task }],
      effects: [],
    }));
  }

  private handleTaskDispatch(cmd: Extract<RpcCommand, { type: "task.dispatch" }>) {
    const project = this.db.getProject(cmd.projectId);
    if (!project) throw new Error(`Project not found: ${cmd.projectId}`);
    const task = this.db.getTask(cmd.taskId);
    if (!task) throw new Error(`Task not found: ${cmd.taskId}`);
    if (task.projectId !== project.id) {
      throw new Error("task_project_mismatch");
    }
    if (task.status !== "ready" && task.status !== "backlog") {
      throw new Error(`task_not_dispatchable:${task.status}`);
    }
    const unmetDeps = (task.dependsOn ?? []).filter((depId) => {
      const dep = this.db.getTask(depId);
      return !dep || (dep.status !== "verified" && dep.status !== "merged");
    });
    if (unmetDeps.length > 0) {
      throw new Error(`task_dependencies_unmet:${unmetDeps.join(",")}`);
    }

    let bot: AgentRecord | null = null;
    if (cmd.agentId) {
      bot = this.db.getAgent(cmd.agentId);
      if (!bot) throw new Error(`Agent not found: ${cmd.agentId}`);
      if (bot.projectId !== project.id) throw new Error("agent_project_mismatch");
      if (bot.scope !== "peer" && bot.scope !== "sidekick") throw new Error(`agent_invalid_scope:${bot.scope}`);
      if (bot.status === "working") throw new Error("agent_busy");
      if (bot.status === "stopped" || bot.status === "paused" || bot.status === "error") {
        throw new Error(`agent_unavailable:${bot.status}`);
      }
    } else {
      bot =
        this.db.listAgents(project.id).find((a) => a.scope === "peer" && a.status === "idle") ??
        (this.handleBotSpawn({
          commandId: newId("cmd"),
          type: "bot.spawn",
          projectId: project.id,
          name: `Peer-${Math.floor(Math.random() * 90 + 10)}`,
          scope: "peer",
          taskId: task.id,
        }) as { agent: AgentRecord }).agent;
    }

    let recreatedWorktree: { worktreePath: string; branch: string } | null = null;
    if (bot.scope === "peer" && !bot.worktreePath) {
      recreatedWorktree = createBotWorktree({
        projectRoot: project.rootPath,
        repoPath: project.repoPath,
        agentId: bot.id,
        taskId: task.id,
      });
      bot = {
        ...bot,
        worktreePath: recreatedWorktree.worktreePath,
        worktreeBranch: recreatedWorktree.branch,
        updatedAt: Date.now(),
      };
    }

    const updatedTask: TaskRecord = {
      ...task,
      status: "claimed",
      assignedAgentId: bot.id,
      worktreeBranch: bot.worktreeBranch,
      updatedAt: Date.now(),
    };

    try {
      const committed = this.core.commitCommand(cmd.commandId, cmd.type, () => ({
        result: { task: updatedTask, agent: bot },
        applyProjections: () => {
          if (recreatedWorktree) {
            this.db.upsertAgent(bot!);
          }
          this.db.upsertTask(updatedTask);
          this.db.updateAgentStatus(bot!.id, "working", { lastSummary: `Claimed task: ${task.title}` });
        },
        events: [
          { topic: `project:${project.id}:board`, eventType: "task.updated", payload: updatedTask },
          { topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() },
        ],
        effects: [{ effectType: "task.run", payload: { projectId: project.id, taskId: task.id, agentId: bot!.id } }],
      }));
      if (cmd.autonomous) {
        this.autonomyLoop.markTaskAutonomous(task.id, project.id);
      }
      return committed;
    } catch (err) {
      if (recreatedWorktree) {
        try {
          removeBotWorktree(project.repoPath, recreatedWorktree.worktreePath);
        } catch {
          // Best-effort cleanup
        }
      }
      throw err;
    }
  }

  private handleAnnotationCreate(cmd: Extract<RpcCommand, { type: "annotation.create" }>) {
    const project = this.db.getProject(cmd.projectId);
    if (!project) throw new Error(`Project not found: ${cmd.projectId}`);
    // Strictly validate annotation target path against project artifact boundary before persisting or spawning fix bots
    resolveSafeProjectFile(project.rootPath, cmd.anchor.filePath);

    const now = Date.now();
    const annotationId = newId("ann");
    const taskId = cmd.requestFixNow ? newId("tsk") : null;

    const annotation: AnnotationRecord = {
      id: annotationId,
      projectId: project.id,
      targetType: cmd.anchor.kind,
      filePath: cmd.anchor.filePath,
      anchor: cmd.anchor,
      comment: this.scrubber.scrub(cmd.comment),
      snapshotDataUrl: cmd.snapshotDataUrl ?? null,
      status: cmd.requestFixNow ? "in_progress" : "open",
      linkedTaskId: taskId,
      createdAt: now,
      updatedAt: now,
    };

    let fixTask: TaskRecord | null = null;
    let targetBot: AgentRecord | null = null;

    if (cmd.requestFixNow && taskId) {
      const intent = cmd.anchor.kind === "doc" ? "coding_parallel" : "vision_fix";
      const route = this.router.resolveIntent(intent, { projectOverrides: project.routingOverrides });
      targetBot =
        this.findIdlePeerForRoute(project.id, intent, route) ??
        (this.handleBotSpawn({
          commandId: newId("cmd"),
          type: "bot.spawn",
          projectId: project.id,
          name: cmd.anchor.kind === "model_3d" ? "3D-Fix-Bot" : cmd.anchor.kind === "image" ? "Visual-Fix-Bot" : "Plan-Fix-Bot",
          scope: "peer",
          provider: route.provider,
          model: route.model,
          taskId,
        }) as { agent: AgentRecord }).agent;

      fixTask = {
        id: taskId,
        projectId: project.id,
        parentTaskId: null,
        title: `Fix [${cmd.anchor.kind}] ${cmd.anchor.filePath}: ${annotation.comment.slice(0, 64)}`,
        specMd: [
          `# Annotation Fix-Task (${annotationId})`,
          `- **Target Type:** ${cmd.anchor.kind}`,
          `- **File:** \`${cmd.anchor.filePath}\``,
          `- **Anchor:** \`${JSON.stringify(cmd.anchor)}\``,
          `- **Operator Comment:** ${annotation.comment}`,
          cmd.snapshotDataUrl ? "- **Viewport Snapshot:** attached (multimodal context available)" : "",
        ]
          .filter(Boolean)
          .join("\n"),
        status: "claimed",
        priority: 1,
        assignedAgentId: targetBot.id,
        sourceAnnotationId: annotationId,
        worktreeBranch: targetBot.worktreeBranch,
        handoffPath: null,
        retryCount: 0,
        createdAt: now,
        updatedAt: now,
      };
    }

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { annotation, fixTask },
      applyProjections: () => {
        if (fixTask) {
          this.db.upsertTask(fixTask);
          if (targetBot) {
            this.db.updateAgentStatus(targetBot.id, "working", { lastSummary: `Claimed fix-task: ${fixTask.title}` });
          }
        }
        this.db.upsertAnnotation(annotation);
        this.db.addInboxNotice(
          "info",
          `Annotation on ${annotation.filePath} (${annotation.targetType})${fixTask ? " → Fix-Task dispatched" : ""}`,
          { projectId: project.id, agentId: targetBot?.id },
        );
      },
      events: [
        { topic: `project:${project.id}:previews`, eventType: "annotation.created", payload: annotation },
        ...(fixTask ? [{ topic: `project:${project.id}:board` as SubscriptionTopic, eventType: "task.created", payload: fixTask }] : []),
        { topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() },
      ],
      effects:
        fixTask && targetBot
          ? [{ effectType: "task.run", payload: { projectId: project.id, taskId: fixTask.id, agentId: targetBot.id } }]
          : [],
    }));
  }

  private handleAnnotationResolve(cmd: Extract<RpcCommand, { type: "annotation.resolve" }>) {
    const existing = this.db.getAnnotation(cmd.annotationId);
    if (!existing) throw new Error(`Annotation not found: ${cmd.annotationId}`);

    const now = Date.now();
    const updated: AnnotationRecord = {
      ...existing,
      status: cmd.status,
      updatedAt: now,
    };

    const reopenEffects: Array<{ effectType: string; payload: Record<string, unknown> }> = [];
    let nextTaskToSave: TaskRecord | null = null;
    let botToMarkWorking: string | null = null;
    let reopenNotice: { level: "info" | "warn" | "action"; message: string; agentId?: string } | null = null;

    const isReopen = cmd.status === "open" || (cmd.status === "in_progress" && existing.status !== "in_progress");
    if (isReopen && existing.linkedTaskId) {
      const task = this.db.getTask(existing.linkedTaskId);
      if (task && task.retryCount < this.runtimeCfg.config.guardrails.maxAnnotationFixRetries) {
        const assignedBot = task.assignedAgentId ? this.db.getAgent(task.assignedAgentId) : null;
        const assignedUsable =
          assignedBot &&
          assignedBot.projectId === existing.projectId &&
          (assignedBot.status === "idle" || assignedBot.status === "waiting_review");

        let targetBot: AgentRecord | undefined = assignedUsable ? assignedBot : undefined;
        if (!targetBot) {
          const project = this.db.getProject(existing.projectId);
          const intent = existing.targetType === "doc" ? "coding_parallel" : "vision_fix";
          const route = project ? this.router.resolveIntent(intent, { projectOverrides: project.routingOverrides }) : null;
          targetBot = route
            ? this.findIdlePeerForRoute(existing.projectId, intent, route)
            : this.db.listAgents(existing.projectId).find((a) => a.scope === "peer" && a.status === "idle");
        }

        if (targetBot) {
          nextTaskToSave = {
            ...task,
            status: "claimed",
            assignedAgentId: targetBot.id,
            worktreeBranch: targetBot.worktreeBranch,
            retryCount: task.retryCount + 1,
            updatedAt: now,
          };
          updated.status = "in_progress";
          botToMarkWorking = targetBot.id;
          reopenEffects.push({
            effectType: "task.run",
            payload: { projectId: existing.projectId, taskId: task.id, agentId: targetBot.id },
          });
        } else {
          nextTaskToSave = {
            ...task,
            status: "ready",
            assignedAgentId: null,
            worktreeBranch: null,
            updatedAt: now,
          };
          updated.status = "open";
          reopenNotice = {
            level: "action",
            message: `Annotation ${existing.id} reopened, but no active/idle bot is available; task '${task.title}' left ready for dispatch.`,
          };
        }
      } else if (task) {
        reopenNotice = {
          level: "action",
          message: `Annotation ${existing.id} hit max auto-fix retries (${this.runtimeCfg.config.guardrails.maxAnnotationFixRetries}); human review required.`,
        };
      }
    }

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { annotation: updated },
      applyProjections: () => {
        if (nextTaskToSave) this.db.upsertTask(nextTaskToSave);
        if (botToMarkWorking && nextTaskToSave) {
          this.db.updateAgentStatus(botToMarkWorking, "working", {
            lastSummary: `Retrying annotation fix: ${nextTaskToSave.title}`,
          });
        }
        if (reopenNotice) {
          this.db.addInboxNotice(reopenNotice.level, reopenNotice.message, {
            projectId: existing.projectId,
            agentId: reopenNotice.agentId,
          });
        }
        this.db.upsertAnnotation(updated);
      },
      events: [
        { topic: `project:${existing.projectId}:previews`, eventType: "annotation.updated", payload: updated },
        ...(nextTaskToSave
          ? [{ topic: `project:${existing.projectId}:board` as SubscriptionTopic, eventType: "task.updated", payload: nextTaskToSave }]
          : []),
        { topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() },
      ],
      effects: reopenEffects,
    }));
  }

  private handleResolveUnknownAdmission(cmd: Extract<RpcCommand, { type: "session.resolve_unknown" }>) {
    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { admissionId: cmd.admissionId, status: "terminal" },
      applyProjections: () => {
        const row = this.db.getAdmission(cmd.admissionId);
        if (!row || row.status !== "unknown") throw new Error("admission_not_unknown");
        if (row.executionGeneration !== cmd.expectedGeneration) throw new Error("stale_generation");
        this.db.updateAdmissionStatus(cmd.admissionId, "terminal");
      },
      events: [{ topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() }],
      effects: [],
    }));
  }

  private async cleanupUnusedWorktreeOnHardStop(agentId: string): Promise<void> {
    const agent = this.db.getAgent(agentId);
    if (!agent || agent.scope !== "peer" || !agent.worktreePath || !agent.projectId) return;
    const project = this.db.getProject(agent.projectId);
    if (!project || agent.worktreePath === project.repoPath || !existsSync(agent.worktreePath)) return;

    const hasActiveOrUnmergedTask = this.db
      .listTasks(project.id)
      .some(
        (t) =>
          t.assignedAgentId === agent.id &&
          (t.status === "claimed" || t.status === "in_review" || t.status === "verified"),
      );
    if (hasActiveOrUnmergedTask) return;

    const changed = await listWorktreeChangedFiles(agent.worktreePath).catch(() => ["__keep__"]);
    if (changed.length > 0) return;

    const branch = agent.worktreeBranch;
    try {
      removeBotWorktree(project.repoPath, agent.worktreePath);
      if (branch && branch !== "main" && branch !== "master") {
        Bun.spawnSync(["git", "-c", "core.longpaths=true", "branch", "-D", branch], {
          cwd: project.repoPath,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
      }
      this.db.runAtomicWrite(() => {
        const fresh = this.db.getAgent(agent.id);
        if (fresh) {
          this.db.upsertAgent({
            ...fresh,
            worktreePath: null,
            worktreeBranch: null,
            updatedAt: Date.now(),
          });
        }
      });
    } catch {
      // Best-effort unused worktree cleanup
    }
  }

  private async executePeerTask(projectId: string, taskId: string, agentId: string): Promise<void> {
    const project = this.db.getProject(projectId);
    const task = this.db.getTask(taskId);
    const agent = this.db.getAgent(agentId);
    if (!project || !task || !agent) return;
    if (agent.status === "stopped" || agent.status === "paused") return;

    const annotation = task.sourceAnnotationId ? this.db.getAnnotation(task.sourceAnnotationId) : null;
    const cwd = agent.worktreePath ?? project.repoPath;

    const turn = await this.runAgentTurn(
      agent.id,
      `Execute task ${task.id}: ${task.title}\n\nSpecification:\n${task.specMd}`,
      {
        emitTopic: `bot:${agent.id}:timeline`,
        namespace: `project:${project.slug}`,
        imageDataUrl: annotation?.snapshotDataUrl ?? null,
      },
    );

    // If agent was paused/stopped mid-turn, skip post-turn artifact mutations & completion
    const agentAfterTurn = this.db.getAgent(agent.id);
    if (!agentAfterTurn || agentAfterTurn.status === "stopped" || agentAfterTurn.status === "paused") return;

    // Clean up any depth-1 child subagents spawned during this task turn so slots/worktrees never leak across tasks or retries
    await this.subagentManager.cleanupSubagentsForParent(agent.id).catch(() => {});

    if (!turn.ok) {
      const errMsg = this.scrubber.scrub(turn.error ?? "Task turn failed");
      const failure = this.db.runAtomicWrite(() => {
        const freshAgent = this.db.getAgent(agent.id);
        if (!freshAgent || freshAgent.status === "stopped" || freshAgent.status === "paused") return null;
        const freshTask = this.db.getTask(task.id);
        const now = Date.now();
        const blockedTask: TaskRecord | null = freshTask
          ? {
              ...freshTask,
              status: freshTask.status === "merged" ? "merged" : "blocked",
              updatedAt: now,
            }
          : null;
        if (blockedTask) {
          this.db.upsertTask(blockedTask);
        }
        const errItem: TimelineItem = {
          id: newId("msg"),
          agentId: freshAgent.id,
          sessionId: freshAgent.activeSessionId ?? agent.activeSessionId!,
          seq: 0,
          kind: "status",
          role: "system",
          title: "Task turn failed",
          content: `Task '${freshTask?.title ?? task.title}' blocked: ${errMsg}`,
          createdAt: now,
        };
        if (freshAgent.activeSessionId) {
          this.db.appendMessage(errItem);
        }
        this.db.updateAgentStatus(freshAgent.id, "error", { lastSummary: errMsg.slice(0, 90) });
        this.db.addInboxNotice("action", `${freshAgent.name} failed on '${freshTask?.title ?? task.title}': ${errMsg.slice(0, 120)}`, {
          projectId: project.id,
          agentId: freshAgent.id,
        });
        return { blockedTask, errItem };
      });
      if (failure) {
        this.core.emitDirectEvent(`bot:${agent.id}:timeline`, "timeline.item", failure.errItem);
        if (failure.blockedTask) {
          this.core.emitDirectEvent(`project:${project.id}:board`, "task.updated", failure.blockedTask);
        }
        this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
        this.autonomyLoop.onPeerTaskFailed(project.id, task.id, errMsg);
      }
      return;
    }

    const summaryText = turn.text;

    // If this was a doc annotation fix, record a traceable revision note cleanly ONLY within allowed project artifact dirs
    const changedFiles: string[] = [];
    if (annotation && annotation.targetType === "doc") {
      let docAbs: string | null = null;
      try {
        docAbs = resolveSafeProjectFile(project.rootPath, annotation.filePath);
      } catch {
        docAbs = null;
      }
      if (docAbs && existsSync(docAbs)) {
        const current = readFileSync(docAbs, "utf8");
        const marker = `\n> _Bot-Factory Fix (${task.id}): ${annotation.comment} — addressed by ${agent.name}._\n`;
        if (!current.includes(task.id)) {
          writeFileSync(docAbs, `${current.trimEnd()}\n${marker}`, "utf8");
          changedFiles.push(annotation.filePath);
        }
      }
    }

    const isRealCliOrAcp = agent.runtimeType !== "native_http" && process.env.BOT_FACTORY_OFFLINE_MOCK !== "1";
    if (!isRealCliOrAcp) {
      // Offline / native simulation fallback: record a task marker file inside the isolated worktree so Git checkpoint captures a concrete diff
      const wtNote = join(cwd, `.bf-task-${task.id}.md`);
      writeFileSync(wtNote, `# ${task.title}\n\nCompleted by ${agent.name} (${agent.provider}/${agent.model})\n\n${summaryText}\n`, "utf8");
      changedFiles.push(`.bf-task-${task.id}.md`);
    }

    const gitChangedFiles = await listWorktreeChangedFiles(cwd).catch(() => []);
    const allChangedFiles = [...new Set([...changedFiles, ...gitChangedFiles])];

    // Separate milestone (T3 invariant): turn finished -> now capture workspace-scoped hidden Git checkpoint!
    const nextTurn = this.db.incrementAgentTurnCounter(agent.id);
    let checkpointRef: string | null = null;
    try {
      const cp = await captureCheckpoint(this.db, { agentId: agent.id, cwd, turnNum: nextTurn });
      checkpointRef = cp.refName;
    } catch {
      // Non-git fallback stays safe
    }

    const existingTask = this.db.getTask(task.id);
    const botWroteHandoff =
      isRealCliOrAcp &&
      Boolean(existingTask?.handoffPath) &&
      existsSync(join(project.rootPath, existingTask!.handoffPath!));
    const handoffPath = botWroteHandoff
      ? existingTask!.handoffPath!
      : writeTaskHandoff(project.rootPath, task.id, {
          title: task.title,
          summary: summaryText,
          changedFiles: allChangedFiles,
          testsRun: isRealCliOrAcp ? [] : ["worktree-checkpoint-verified"],
          notes: checkpointRef ? `Checkpoint ref: ${checkpointRef}` : undefined,
        });

    const persisted = this.db.runAtomicWrite(() => {
      const freshAgent = this.db.getAgent(agent.id);
      if (!freshAgent || freshAgent.status === "stopped" || freshAgent.status === "paused") return null;
      const freshTask = this.db.getTask(task.id);
      if (!freshTask) return null;
      const annId = freshTask.sourceAnnotationId ?? annotation?.id ?? null;
      const freshAnn = annId ? this.db.getAnnotation(annId) : null;

      const now = Date.now();
      const completedTask: TaskRecord = {
        ...freshTask,
        status: freshTask.status === "merged" ? "merged" : "in_review",
        handoffPath,
        updatedAt: now,
      };

      const handoffItem: TimelineItem = {
        id: newId("msg"),
        agentId: freshAgent.id,
        sessionId: freshAgent.activeSessionId ?? agent.activeSessionId!,
        seq: 0,
        kind: "handoff",
        role: "assistant",
        title: `Handoff written: ${handoffPath}`,
        content: summaryText,
        filePath: handoffPath,
        checkpointRef,
        createdAt: now,
      };

      this.db.upsertTask(completedTask);
      this.db.appendMessage(handoffItem);
      this.db.updateAgentStatus(freshAgent.id, "waiting_review", { lastSummary: `Handoff ready (${handoffPath})` });

      let updatedAnn: AnnotationRecord | null = null;
      if (freshAnn) {
        updatedAnn = {
          ...freshAnn,
          status: freshAnn.status === "approved" ? "approved" : "resolved_pending_review",
          updatedAt: now,
        };
        this.db.upsertAnnotation(updatedAnn);
      }

      this.db.addInboxNotice("info", `${freshAgent.name} finished '${freshTask.title}' → ready for review`, {
        projectId: project.id,
        agentId: freshAgent.id,
      });

      return { completedTask, handoffItem, updatedAnn };
    });

    if (!persisted) return;

    this.core.emitDirectEvent(`bot:${agent.id}:timeline`, "timeline.item", persisted.handoffItem);
    this.core.emitDirectEvent(`project:${project.id}:board`, "task.updated", persisted.completedTask);
    if (persisted.updatedAnn) {
      this.core.emitDirectEvent(`project:${project.id}:previews`, "annotation.updated", persisted.updatedAnn);
    }
    this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
    this.autonomyLoop.onPeerTaskCompleted(project.id, task.id);
  }

  private async runAgentTurn(
    agentId: string,
    userText: string,
    opts: {
      emitTopic: SubscriptionTopic;
      namespace: string;
      imageDataUrl?: string | null;
      projectId?: string;
      reasoningEffort?: ReasoningEffort;
      autonomyLevel?: AutonomyLevel;
    },
  ): Promise<{ ok: boolean; text: string; error?: string }> {
    const agent = this.db.getAgent(agentId);
    if (!agent || !agent.activeSessionId) throw new Error(`Agent/session missing: ${agentId}`);
    const session = this.db.getSession(agent.activeSessionId);
    if (!session) throw new Error(`Session missing: ${agent.activeSessionId}`);

    const prefs = this.agentTurnPrefs.get(agent.id);
    const reasoningEffort = opts.reasoningEffort ?? prefs?.reasoningEffort ?? agent.reasoningEffort;
    const autonomyLevel = opts.autonomyLevel ?? prefs?.autonomyLevel ?? agent.autonomyLevel;
    const botTimelineTopic: SubscriptionTopic = `bot:${agent.id}:timeline`;

    const admission = this.db.runAtomicWrite(() => this.db.enqueueAdmission(session.id, userText, "started"));

    const runtime = this.getRuntime(agent.runtimeType);
    let handle = this.sessionHandles.get(session.id);
    if (
      handle &&
      ((handle.runtimeKind === "acp_stdio" && !this.acpRuntime.isSessionAlive(handle.sessionId)) ||
        (handle.runtimeKind === "cli_stream" && !this.cliRuntime?.isSessionAlive(handle.sessionId)))
    ) {
      this.sessionHandles.delete(session.id);
      this.revokeMcpTokensForAgent(agent.id);
      handle = undefined;
    }

    let finalText = "";
    let thoughtText = "";
    let runtimeError: string | null = null;
    let receivedDone = false;

    try {
      if (!handle) {
        this.revokeMcpTokensForAgent(agent.id);
        const supportsMcp = agent.runtimeType === "acp_stdio" || agent.runtimeType === "cli_stream";
        const mcpToken =
          supportsMcp && agent.projectId
            ? this.mintMcpToken(agent.projectId, agent.id, session.id)
            : this.runtimeCfg.sessionToken;
        const mcpBridgeScript = resolve(import.meta.dir, "../mcp/mcpBridge.ts");
        const mcpServers = supportsMcp
          ? [
              {
                name: "bot-factory",
                command: "bun",
                args: [
                  "run",
                  mcpBridgeScript,
                  "--daemon-url",
                  this.getDaemonUrl(),
                  "--project",
                  agent.projectId ?? "global",
                  "--agent",
                  agent.id,
                ],
                env: {
                  BOT_FACTORY_TOKEN: mcpToken,
                },
              },
            ]
          : undefined;

        handle = await runtime.startSession({
          agentId: agent.id,
          sessionId: session.id,
          provider: agent.provider,
          model: agent.model,
          cwd: agent.worktreePath ?? this.runtimeCfg.rootDir,
          systemPrompt: session.systemPrompt,
          mcpServers,
          reasoningEffort,
          autonomyLevel,
        });
        const latestAfterStart = this.db.getAgent(agent.id);
        if (!latestAfterStart || latestAfterStart.status === "stopped" || latestAfterStart.status === "paused") {
          const abortMode = latestAfterStart?.status === "paused" ? "pause" : "hard_stop";
          try {
            await runtime.abort(handle, abortMode);
          } catch {
            // ignore cleanup errors
          }
          if (abortMode === "hard_stop") {
            this.revokeMcpTokensForAgent(agent.id);
          } else {
            this.sessionHandles.set(session.id, handle);
          }
          this.db.runAtomicWrite(() => {
            this.db.updateAdmissionStatus(admission.id, "terminal");
          });
          this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
          return { ok: false, text: "", error: `Agent ${latestAfterStart?.status ?? "missing"} during session startup` };
        }
        this.sessionHandles.set(session.id, handle);
        if (handle.pid) {
          this.db.runAtomicWrite(() => this.db.updateAgentStatus(agent.id, "working", { pid: handle!.pid }));
        }
      }

      const filteredHistory = this.db
        .listActiveSessionMessages(session.id, 48)
        .filter(
          (m) =>
            (m.kind === "message" && (m.role === "user" || m.role === "assistant")) ||
            (m.kind === "status" && Boolean(m.title?.startsWith("Compaction Gen #"))),
        );
      let rawHistory = filteredHistory
        .slice(-24)
        .map((m) => ({
          role: (m.kind === "status" ? "system" : m.role) as "user" | "assistant" | "system",
          content: m.content,
        }));
      const latestCompaction = [...filteredHistory]
        .reverse()
        .find((m) => m.kind === "status" && Boolean(m.title?.startsWith("Compaction Gen #")));
      if (latestCompaction && !rawHistory.some((h) => h.role === "system" && h.content === latestCompaction.content)) {
        rawHistory = [{ role: "system", content: latestCompaction.content }, ...rawHistory.slice(-23)];
      }
      if (rawHistory.length > 0 && rawHistory[rawHistory.length - 1]?.role === "user" && rawHistory[rawHistory.length - 1]?.content === userText) {
        rawHistory.pop();
      }
      const history = rawHistory;

      let recalled = "";
      try {
        recalled = await this.memory.recallForTurn(opts.namespace, userText, 6);
      } catch {
        recalled = "";
      }
      const memoryContext = recalled || this.memory.prefetch(opts.namespace);
      const projectSummary = opts.projectId ? this.buildConciseProjectSummary(opts.projectId) : "";
      const ephemeralContext = [projectSummary, memoryContext].filter(Boolean).join("\n\n");

      let turnTools: ToolDefinition[] | undefined;
      let turnToolExecutor: ToolCallExecutor | undefined;
      if (agent.scope === "global") {
        const mainTools = getMainManagerTools({
          db: this.db,
          core: this.core,
          memory: this.memory,
          scrubber: this.scrubber,
          autonomyLoop: this.autonomyLoop,
          metaAgentId: this.metaAgentId,
          executeCommand: (cmd) => this.executeCommand(cmd),
          getQuietStatusProjection: () => this.getQuietStatusProjection(),
          getProjectBoardSnapshot: (pid) => this.getProjectBoardSnapshot(pid),
          getConfigSnapshot: () => this.getScrubbedConfigSnapshot(),
        });
        turnTools = mainTools.tools;
        turnToolExecutor = mainTools.onToolCall;
      } else if (agent.scope === "project" && agent.projectId) {
        const pmProject = this.db.getProject(agent.projectId);
        if (pmProject) {
          const teamTools = getTeamLeadTools({
            db: this.db,
            core: this.core,
            memory: this.memory,
            scrubber: this.scrubber,
            autonomyLoop: this.autonomyLoop,
            pmAgent: agent,
            project: pmProject,
            metaAgentId: this.metaAgentId,
            executeCommand: (cmd) => this.executeCommand(cmd),
            getQuietStatusProjection: () => this.getQuietStatusProjection(),
            getProjectBoardSnapshot: (pid) => this.getProjectBoardSnapshot(pid),
          });
          turnTools = teamTools.tools;
          turnToolExecutor = teamTools.onToolCall;
        }
      }

      for await (const evt of runtime.sendTurn(handle, {
        userText,
        ephemeralContext: ephemeralContext || undefined,
        history,
        imageDataUrl: opts.imageDataUrl,
        reasoningEffort,
        autonomyLevel,
        tools: turnTools,
        onToolCall: turnToolExecutor,
      })) {
        if (evt.type === "plan") {
          const item: TimelineItem = {
            id: newId("msg"),
            agentId: agent.id,
            sessionId: session.id,
            seq: 0,
            kind: "plan",
            role: "assistant",
            title: "Execution Plan",
            content: evt.items.map((i) => `- [${i.status}] ${i.title}`).join("\n"),
            createdAt: Date.now(),
          };
          if (opts.emitTopic !== "chat:meta") {
            this.db.runAtomicWrite(() => this.db.appendMessage(item));
            this.core.emitDirectEvent(opts.emitTopic, "timeline.item", item);
          }
        } else if (evt.type === "thought") {
          thoughtText += evt.text;
          this.core.emitDirectEvent(
            opts.emitTopic,
            opts.emitTopic === "chat:meta" ? "chat.thought" : "timeline.delta",
            { agentId: agent.id, sessionId: session.id, kind: "thought", text: evt.text },
          );
        } else if (evt.type === "tool_call") {
          const item: TimelineItem = {
            id: newId("msg"),
            agentId: agent.id,
            sessionId: session.id,
            seq: 0,
            kind: "tool_call",
            role: "tool",
            title: evt.title,
            content: evt.output ?? evt.diffPreview ?? evt.title,
            toolCallId: evt.toolCallId,
            toolStatus: evt.status,
            exitCode: evt.exitCode ?? null,
            filePath: evt.filePath,
            diffPreview: evt.diffPreview,
            createdAt: Date.now(),
          };
          // Strict Anti-Log-Spam invariant: tool_calls are persisted & emitted ONLY on bot timeline, NEVER pushed to chat:meta!
          if (opts.emitTopic !== "chat:meta") {
            this.db.runAtomicWrite(() => this.db.upsertToolCallMessage(item));
          }
          this.core.emitDirectEvent(botTimelineTopic, "timeline.item", item);
        } else if (evt.type === "tool_result") {
          // Strict Anti-Log-Spam invariant: tool_results stay on bot timeline, NEVER pushed to chat:meta!
          this.core.emitDirectEvent(botTimelineTopic, "tool.result", {
            agentId: agent.id,
            sessionId: session.id,
            toolCallId: evt.toolCallId,
            name: evt.name,
            output: evt.output,
            isError: Boolean(evt.isError),
          });
        } else if (evt.type === "permission_requested") {
          // Handled synchronously via acpRuntime.setOnPermissionRequest
        } else if (evt.type === "permission_escalated") {
          this.db.runAtomicWrite(() => {
            this.db.updateAgentStatus(agent.id, "requires_action", { lastSummary: evt.reason });
            this.db.addInboxNotice("action", `Permission escalated for ${agent.name}: ${evt.reason}`, {
              projectId: agent.projectId ?? undefined,
              agentId: agent.id,
            });
          });
          this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
        } else if (evt.type === "usage") {
          this.db.runAtomicWrite(() => this.db.addSessionTokenUsage(session.id, evt.tokenIn, evt.tokenOut));
        } else if (evt.type === "text_delta") {
          finalText += evt.text;
          this.core.emitDirectEvent(
            opts.emitTopic,
            opts.emitTopic === "chat:meta" ? "chat.delta" : "timeline.delta",
            { agentId: agent.id, sessionId: session.id, kind: "text_delta", text: evt.text },
          );
        } else if (evt.type === "done") {
          receivedDone = true;
          finalText = evt.finalText;
        } else if (evt.type === "error") {
          runtimeError = this.scrubber.scrub(evt.message || "Runtime error");
        }
      }

      if (runtimeError === null && !receivedDone) {
        const latest = this.db.getAgent(agent.id);
        if (latest && (latest.status === "paused" || latest.status === "stopped")) {
          finalText = finalText || "[Turn paused/stopped by operator]";
        } else {
          runtimeError = "Runtime stream ended without completion";
        }
      }

      if (runtimeError !== null) {
        if (
          (handle.runtimeKind === "acp_stdio" && !this.acpRuntime.isSessionAlive(handle.sessionId)) ||
          (handle.runtimeKind === "cli_stream" && !this.cliRuntime?.isSessionAlive(handle.sessionId))
        ) {
          this.sessionHandles.delete(session.id);
          this.revokeMcpTokensForAgent(agent.id);
        }
        this.db.runAtomicWrite(() => {
          this.db.updateAdmissionStatus(admission.id, "terminal");
          const latest = this.db.getAgent(agent.id);
          if (!latest || (latest.status !== "paused" && latest.status !== "stopped")) {
            const keepPid =
              (handle?.runtimeKind === "acp_stdio" && this.acpRuntime.isSessionAlive(session.id)) ||
              (handle?.runtimeKind === "cli_stream" && this.cliRuntime?.isSessionAlive(session.id))
                ? handle.pid
                : null;
            this.db.updateAgentStatus(agent.id, "error", {
              pid: keepPid,
              lastSummary: runtimeError!.slice(0, 90),
            });
          }
        });
        this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
        return { ok: false, text: finalText, error: runtimeError };
      }

      const now = Date.now();
      const thoughtItem: TimelineItem | null =
        opts.emitTopic !== "chat:meta" && thoughtText.trim().length > 0
          ? {
              id: newId("msg"),
              agentId: agent.id,
              sessionId: session.id,
              seq: 0,
              kind: "thought",
              role: "assistant",
              title: "Reasoning",
              content: thoughtText.trim(),
              createdAt: now,
            }
          : null;

      const assistantItem: TimelineItem = {
        id: newId("msg"),
        agentId: agent.id,
        sessionId: session.id,
        seq: 0,
        kind: "message",
        role: "assistant",
        content: finalText || "(no output)",
        createdAt: now,
      };

      this.db.runAtomicWrite(() => {
        if (thoughtItem) {
          this.db.appendMessage(thoughtItem);
        }
        this.db.appendMessage(assistantItem);
        this.db.updateAdmissionStatus(admission.id, "terminal");
        const latest = this.db.getAgent(agent.id);
        if (!latest || latest.status === "working" || latest.status === "idle") {
          this.db.updateAgentStatus(agent.id, "idle", { lastSummary: (finalText || "Idle").slice(0, 90) });
        }
      });

      if (thoughtItem) {
        this.core.emitDirectEvent(opts.emitTopic, "timeline.item", thoughtItem);
      }
      this.core.emitDirectEvent(
        opts.emitTopic,
        opts.emitTopic === "chat:meta" ? "chat.message" : "timeline.item",
        assistantItem,
      );
      this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());

      if (opts.emitTopic === "chat:meta") {
        try {
          await this.memory.ingestDocument({
            docId: `chat:${session.id}:${assistantItem.id}`,
            namespace: opts.namespace,
            content: `User: ${userText}\n\nAssistant: ${finalText || "(no output)"}`,
            metadata: {
              agentId: agent.id,
              sessionId: session.id,
              projectId: opts.projectId ?? null,
              createdAt: assistantItem.createdAt,
            },
          });
        } catch {
          // Fail-open invariant: memory ingestion must not break completed turns
        }
      }

      const totalTokens = this.db.getSessionTokenTotal(session.id);
      if (totalTokens >= this.runtimeCfg.config.guardrails.autoCompactThresholdTokens) {
        const activeMsgs = this.db.listActiveSessionMessages(session.id, 40);
        const priorSummary = activeMsgs.find((m) => m.kind === "status" && m.title?.startsWith("Compaction Gen #"));
        const summaryLines = activeMsgs
          .filter((m) => m.kind === "message" && (m.role === "user" || m.role === "assistant"))
          .slice(-8)
          .map((m) => `- ${m.role}: ${m.content.replace(/\s+/g, " ").slice(0, 180)}`);
        const priorBlock = priorSummary
          ? `Prior summary (${priorSummary.title}): ${priorSummary.content.replace(/\s+/g, " ").slice(0, 600)}\n`
          : "";
        const summaryText = this.scrubber.scrub(
          `Compacted ${activeMsgs.length} active messages (${totalTokens} tokens).\n${priorBlock}${summaryLines.join("\n")}`,
        );
        const freshAgent = this.db.getAgent(agent.id) ?? agent;
        const rebuilt = this.buildAgentSystemPrompt(freshAgent);
        const nextGen = this.db.compactSessionInPlace(session.id, summaryText, rebuilt.systemPrompt, rebuilt.hash);
        if (handle) {
          this.sessionHandles.delete(session.id);
          await runtime.closeSession(handle).catch(() => {});
        }
        const compactPayload = {
          agentId: agent.id,
          sessionId: session.id,
          generation: nextGen,
          previousTokens: totalTokens,
        };
        this.core.emitDirectEvent(botTimelineTopic, "session.compacted", compactPayload);
        if (opts.emitTopic === "chat:meta") {
          this.core.emitDirectEvent("chat:meta", "session.compacted", compactPayload);
        }
      }

      // Non-blocking memory pre-warm for next turn
      this.memory.queuePrefetch(opts.namespace, `${userText}\n${finalText}`);
      return { ok: true, text: finalText };
    } catch (err) {
      const msg = this.scrubber.scrub(err instanceof Error ? err.message : String(err));
      if (!this.sessionHandles.has(session.id)) {
        this.revokeMcpTokensForAgent(agent.id);
      } else if (
        handle &&
        ((handle.runtimeKind === "acp_stdio" && !this.acpRuntime.isSessionAlive(session.id)) ||
          (handle.runtimeKind === "cli_stream" && !this.cliRuntime?.isSessionAlive(session.id)))
      ) {
        this.sessionHandles.delete(session.id);
        this.revokeMcpTokensForAgent(agent.id);
      }
      this.db.runAtomicWrite(() => {
        this.db.updateAdmissionStatus(admission.id, "terminal");
        const latest = this.db.getAgent(agent.id);
        if (!latest || (latest.status !== "paused" && latest.status !== "stopped")) {
          const keepPid =
            (handle?.runtimeKind === "acp_stdio" && this.acpRuntime.isSessionAlive(session.id)) ||
            (handle?.runtimeKind === "cli_stream" && this.cliRuntime?.isSessionAlive(session.id))
              ? handle.pid
              : null;
          this.db.updateAgentStatus(agent.id, "error", { pid: keepPid, lastSummary: msg.slice(0, 90) });
        }
      });
      this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
      return { ok: false, text: finalText, error: msg };
    }
  }

  // --- MCP Bridge Tool Handler (for external ACP bots) ---

  public async handleMcpToolCall(
    toolName: string,
    body: { projectId: string; agentId: string; args?: Record<string, unknown>; scoped?: boolean },
  ) {
    const args = body.args ?? {};
    const project = this.db.getProject(body.projectId);
    if (!project) return { error: "project_not_found" };
    const agent = this.db.getAgent(body.agentId);
    if (!agent) return { error: "agent_not_found" };
    if (agent.projectId !== project.id) return { error: "agent_project_mismatch" };
    const ns = `project:${project.slug}`;

    switch (toolName) {
      case "bf_task_list": {
        const tasks = this.db.listTasks(project.id);
        const status = args.status ? String(args.status) : null;
        return { tasks: status ? tasks.filter((t) => t.status === status) : tasks };
      }
      case "bf_task_claim": {
        const requestedId = args.taskId ? String(args.taskId) : "";
        const claimResult = this.db.runAtomicWrite(() => {
          const task = requestedId
            ? this.db.getTask(requestedId)
            : (this.db.listTasks(project.id).find((t) => t.status === "ready") ?? null);
          if (!task) return { error: requestedId ? "task_not_found" : "no_ready_tasks" } as const;
          if (task.projectId !== project.id) return { error: "task_project_mismatch" } as const;
          if (task.status !== "ready" && task.status !== "backlog") {
            return { error: `task_not_claimable:${task.status}` } as const;
          }
          const updated: TaskRecord = {
            ...task,
            status: "claimed",
            assignedAgentId: agent.id,
            worktreeBranch: task.worktreeBranch ?? agent.worktreeBranch,
            updatedAt: Date.now(),
          };
          this.db.upsertTask(updated);
          return { task: updated } as const;
        });
        if ("error" in claimResult) return claimResult;
        this.core.emitDirectEvent(`project:${claimResult.task.projectId}:board`, "task.updated", claimResult.task);
        return { task: claimResult.task };
      }
      case "bf_task_update": {
        if (args.status !== undefined) {
          const parsedStatus = TaskStatusSchema.safeParse(args.status);
          if (!parsedStatus.success) {
            return { error: "invalid_task_status" };
          }
        }
        const updateResult = this.db.runAtomicWrite(() => {
          const task = this.db.getTask(String(args.taskId ?? ""));
          if (!task) return { error: "task_not_found" } as const;
          if (task.projectId !== project.id) return { error: "task_project_mismatch" } as const;
          const nextStatus = args.status !== undefined ? TaskStatusSchema.parse(args.status) : task.status;
          const updated: TaskRecord = {
            ...task,
            status: nextStatus,
            updatedAt: Date.now(),
          };
          this.db.upsertTask(updated);
          return { task: updated } as const;
        });
        if ("error" in updateResult) return updateResult;
        this.core.emitDirectEvent(`project:${updateResult.task.projectId}:board`, "task.updated", updateResult.task);
        return { task: updateResult.task };
      }
      case "bf_handoff_write": {
        const rawTaskId = typeof args.taskId === "string" && args.taskId.trim() ? args.taskId.trim() : "";
        const existingTask = rawTaskId ? this.db.getTask(rawTaskId) : null;
        if (existingTask && existingTask.projectId !== project.id) {
          return { error: "task_project_mismatch" };
        }
        const taskId = rawTaskId || newId("tsk");
        const handoffPath = writeTaskHandoff(project.rootPath, taskId, {
          title: this.scrubber.scrub(String(args.title ?? existingTask?.title ?? taskId)),
          summary: this.scrubber.scrub(String(args.summary ?? args.content ?? "")),
          changedFiles: Array.isArray(args.changedFiles)
            ? args.changedFiles.map((f) => this.scrubber.scrub(String(f)))
            : [],
          testsRun: Array.isArray(args.testsRun) ? args.testsRun.map((t) => this.scrubber.scrub(String(t))) : [],
          notes: args.notes ? this.scrubber.scrub(String(args.notes)) : undefined,
        });
        if (rawTaskId && existingTask) {
          const updatedTask = this.db.runAtomicWrite(() => {
            const fresh = this.db.getTask(rawTaskId);
            if (!fresh || fresh.projectId !== project.id) return null;
            const next: TaskRecord = { ...fresh, handoffPath, updatedAt: Date.now() };
            this.db.upsertTask(next);
            return next;
          });
          if (updatedTask) {
            this.core.emitDirectEvent(`project:${project.id}:board`, "task.updated", updatedTask);
          }
        }
        return { handoffPath };
      }
      case "bf_memory_search": {
        const scope = args.scope === "global" ? "global" : ns;
        const rawLimit = Number(args.limit ?? 8);
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 50) : 8;
        return this.memory.search(scope, String(args.query ?? ""), limit);
      }
      case "bf_fix_tasks_list": {
        const annotations = this.db
          .listAnnotations(project.id)
          .filter((a) => a.status === "open" || a.status === "in_progress");
        return { annotations };
      }
      case "bf_fix_task_resolve": {
        const annId = args.annotationId ? String(args.annotationId) : "";
        const linkedTaskId = args.taskId ? String(args.taskId) : "";
        const resolveResult = this.db.runAtomicWrite(() => {
          const ann =
            (annId ? this.db.getAnnotation(annId) : null) ??
            (linkedTaskId
              ? (this.db.listAnnotations(project.id).find((a) => a.linkedTaskId === linkedTaskId) ?? null)
              : null);
          if (!ann) return { error: "annotation_not_found" } as const;
          if (ann.projectId !== project.id) return { error: "annotation_project_mismatch" } as const;
          const updated: AnnotationRecord = { ...ann, status: "resolved_pending_review", updatedAt: Date.now() };
          this.db.upsertAnnotation(updated);
          return { annotation: updated } as const;
        });
        if ("error" in resolveResult) return resolveResult;
        this.core.emitDirectEvent(
          `project:${resolveResult.annotation.projectId}:previews`,
          "annotation.updated",
          resolveResult.annotation,
        );
        return { annotation: resolveResult.annotation };
      }
      case "bf_debate_post": {
        if (typeof args.debateId !== "string" || typeof args.position !== "string") {
          return { error: "invalid_debate_post_args" };
        }
        const parsed = RpcCommandSchema.safeParse({
          commandId: newId("cmd"),
          type: "debate.post",
          debateId: args.debateId,
          agentId: agent.id,
          position: args.position.trim(),
          evidence: typeof args.evidence === "string" ? args.evidence : undefined,
        });
        if (!parsed.success || parsed.data.type !== "debate.post") {
          return { error: "invalid_debate_post_args" };
        }
        const debate = this.db.getDebate(parsed.data.debateId);
        if (!debate) return { error: "debate_not_found" };
        if (debate.projectId !== project.id) return { error: "debate_project_mismatch" };
        try {
          return this.handleDebatePost(parsed.data);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
      case "bf_subagent_spawn": {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!name || !prompt) return { error: "invalid_subagent_args" };
        const mode = args.mode !== undefined ? String(args.mode) : undefined;
        if (mode !== undefined && mode !== "readonly" && mode !== "code") {
          return { error: "invalid_subagent_mode" };
        }
        try {
          return await this.subagentManager.spawnSubagent({
            projectId: project.id,
            parentAgentId: agent.id,
            name,
            role: typeof args.role === "string" ? args.role : undefined,
            mode: mode as SubagentMode | undefined,
            prompt,
            provider: typeof args.provider === "string" && args.provider.trim() ? args.provider.trim() : undefined,
            model: typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined,
          });
        } catch (err) {
          return { error: this.scrubber.scrub(err instanceof Error ? err.message : String(err)) };
        }
      }
      case "bf_subagent_status": {
        const subagentId = typeof args.subagentId === "string" && args.subagentId.trim() ? args.subagentId.trim() : undefined;
        try {
          return this.subagentManager.getStatus(agent.id, subagentId);
        } catch (err) {
          return { error: this.scrubber.scrub(err instanceof Error ? err.message : String(err)) };
        }
      }
      case "bf_subagent_wait": {
        const subagentId = typeof args.subagentId === "string" ? args.subagentId.trim() : "";
        if (!subagentId) return { error: "subagent_id_required" };
        const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
        try {
          return await this.subagentManager.waitForSubagent(agent.id, subagentId, timeoutMs);
        } catch (err) {
          return { error: this.scrubber.scrub(err instanceof Error ? err.message : String(err)) };
        }
      }
      case "bf_subagent_message": {
        const subagentId = typeof args.subagentId === "string" ? args.subagentId.trim() : "";
        const message = typeof args.message === "string" ? args.message.trim() : "";
        if (!subagentId || !message) return { error: "invalid_subagent_message_args" };
        try {
          return this.subagentManager.messageSubagent(agent.id, subagentId, message);
        } catch (err) {
          return { error: this.scrubber.scrub(err instanceof Error ? err.message : String(err)) };
        }
      }
      case "bf_subagent_kill": {
        const subagentId = typeof args.subagentId === "string" ? args.subagentId.trim() : "";
        if (!subagentId) return { error: "subagent_id_required" };
        try {
          return await this.subagentManager.killSubagent(agent.id, subagentId);
        } catch (err) {
          return { error: this.scrubber.scrub(err instanceof Error ? err.message : String(err)) };
        }
      }
      case "bf_subagent_apply_patch": {
        const subagentId = typeof args.subagentId === "string" ? args.subagentId.trim() : "";
        if (!subagentId) return { error: "subagent_id_required" };
        try {
          return await this.subagentManager.applySubagentPatch(agent.id, subagentId);
        } catch (err) {
          return { error: this.scrubber.scrub(err instanceof Error ? err.message : String(err)) };
        }
      }
      default:
        return { error: `unknown_mcp_tool:${toolName}` };
    }
  }

  // --- Phase 3: Conflict Debates, Independent Verifier & Self-Modification ---

  private handleTaskVerify(cmd: Extract<RpcCommand, { type: "task.verify" }>) {
    const project = this.db.getProject(cmd.projectId);
    if (!project) throw new Error(`Project not found: ${cmd.projectId}`);
    const task = this.db.getTask(cmd.taskId);
    if (!task) throw new Error(`Task not found: ${cmd.taskId}`);
    if (task.projectId !== project.id) throw new Error("task_project_mismatch");
    if (task.status !== "in_review" && task.status !== "blocked" && task.status !== "verified") {
      throw new Error(`task_not_verifiable:${task.status}`);
    }

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { taskId: task.id, queued: true },
      applyProjections: () => {
        this.db.addInboxNotice("info", `Independent cross-family verification queued for '${task.title}'`, {
          projectId: project.id,
        });
      },
      events: [{ topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() }],
      effects: [
        {
          effectType: "task.verify.run",
          payload: { projectId: project.id, taskId: task.id, checks: cmd.checks ?? [] },
        },
      ],
    }));
  }

  private async executeTaskVerification(projectId: string, taskId: string, checks?: string[]): Promise<void> {
    const project = this.db.getProject(projectId);
    const task = this.db.getTask(taskId);
    if (!project || !task) return;

    const report = await this.verifier.verifyTask({ project, task, customChecks: checks });

    const updatedTask = this.db.runAtomicWrite(() => {
      this.db.upsertVerification(report);
      const freshTask = this.db.getTask(taskId);
      if (!freshTask) return null;
      const nextStatus: TaskRecord["status"] =
        freshTask.status === "merged"
          ? "merged"
          : report.verdict === "pass"
            ? "verified"
            : report.verdict === "fail"
              ? "blocked"
              : "in_review";
      const nextTask: TaskRecord = { ...freshTask, status: nextStatus, updatedAt: Date.now() };
      this.db.upsertTask(nextTask);
      this.db.addInboxNotice(
        report.verdict === "pass" ? "info" : "action",
        `Verifier [${report.verifierProvider}/${report.verifierModel}${report.crossFamily ? " · cross-family" : ""}]: '${freshTask.title}' → ${report.verdict.toUpperCase()}`,
        { projectId: project.id },
      );
      return nextTask;
    });

    this.core.emitDirectEvent(`project:${project.id}:debates`, "verification.completed", report);
    if (updatedTask) {
      this.core.emitDirectEvent(`project:${project.id}:board`, "task.updated", updatedTask);
    }
    this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
    this.autonomyLoop.onVerificationCompleted(project.id, taskId, report);
  }

  private handleDebateOpen(cmd: Extract<RpcCommand, { type: "debate.open" }>) {
    const project = this.db.getProject(cmd.projectId);
    if (!project) throw new Error(`Project not found: ${cmd.projectId}`);
    if (cmd.taskId) {
      const task = this.db.getTask(cmd.taskId);
      if (!task) throw new Error(`Task not found: ${cmd.taskId}`);
      if (task.projectId !== project.id) throw new Error("task_project_mismatch");
    }

    const uniqueParticipants = [...new Set(cmd.participantAgentIds)];
    for (const aid of uniqueParticipants) {
      const ag = this.db.getAgent(aid);
      if (!ag) throw new Error(`Agent not found: ${aid}`);
      if (ag.projectId !== project.id) throw new Error("agent_project_mismatch");
    }

    const hardCap = this.runtimeCfg.config.guardrails.maxDebateRounds;
    const maxRounds = Math.min(cmd.maxRounds ?? hardCap, hardCap);
    const now = Date.now();
    const debate: DebateRecord = {
      id: newId("dbt"),
      projectId: project.id,
      taskId: cmd.taskId ?? null,
      topic: this.scrubber.scrub(cmd.topic),
      reason: this.scrubber.scrub(cmd.reason),
      participantAgentIds: uniqueParticipants,
      status: "open",
      roundCount: 0,
      maxRounds,
      escalatedToAgentId: null,
      resolutionSummary: null,
      createdAt: now,
      updatedAt: now,
    };

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { debate },
      applyProjections: () => {
        this.db.upsertDebate(debate);
        for (const aid of uniqueParticipants) {
          const ag = this.db.getAgent(aid);
          if (ag && ag.scope === "peer" && ag.status !== "stopped" && ag.status !== "paused") {
            this.db.updateAgentStatus(aid, "debating", { lastSummary: `Debate: ${debate.topic.slice(0, 60)}` });
          }
        }
        this.db.addInboxNotice("info", `Conflict debate opened: '${debate.topic}' (max ${maxRounds} rounds)`, {
          projectId: project.id,
        });
      },
      events: [
        { topic: `project:${project.id}:debates`, eventType: "debate.updated", payload: debate },
        { topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() },
      ],
      effects: [],
    }));
  }

  private handleDebatePost(cmd: Extract<RpcCommand, { type: "debate.post" }>) {
    const debate = this.db.getDebate(cmd.debateId);
    if (!debate) throw new Error(`Debate not found: ${cmd.debateId}`);
    if (debate.status !== "open") throw new Error(`debate_not_open:${debate.status}`);

    const agent = this.db.getAgent(cmd.agentId);
    if (!agent) throw new Error(`Agent not found: ${cmd.agentId}`);
    if (agent.projectId !== debate.projectId) throw new Error("agent_project_mismatch");
    if (!debate.participantAgentIds.includes(agent.id) && agent.scope !== "project") {
      throw new Error("agent_not_debate_participant");
    }

    const now = Date.now();
    const existingMessages = this.db.listDebateMessages(debate.id);
    const participantCount = Math.max(1, debate.participantAgentIds.length);
    const nextRound = Math.ceil((existingMessages.length + 1) / participantCount);
    const hitCap = existingMessages.length + 1 >= debate.maxRounds * participantCount;
    const pm = hitCap ? this.db.listAgents(debate.projectId).find((a) => a.scope === "project") ?? null : null;

    const msg: DebateMessageRecord = {
      id: newId("dmsg"),
      debateId: debate.id,
      roundNum: nextRound,
      agentId: agent.id,
      position: this.scrubber.scrub(cmd.position),
      evidence: cmd.evidence ? this.scrubber.scrub(cmd.evidence) : null,
      createdAt: now,
    };

    const updatedDebate: DebateRecord = {
      ...debate,
      roundCount: nextRound,
      status: hitCap ? "escalated" : "open",
      escalatedToAgentId: hitCap ? (pm?.id ?? null) : null,
      updatedAt: now,
    };

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { debate: updatedDebate, message: msg, escalated: hitCap },
      applyProjections: () => {
        this.db.appendDebateMessage(msg);
        this.db.upsertDebate(updatedDebate);
        if (hitCap) {
          this.db.addInboxNotice(
            "action",
            `Debate '${debate.topic}' reached round cap (${nextRound}/${debate.maxRounds}) → escalated to Project Manager`,
            { projectId: debate.projectId, agentId: pm?.id },
          );
        }
      },
      events: [
        { topic: `project:${debate.projectId}:debates`, eventType: "debate.message", payload: msg },
        { topic: `project:${debate.projectId}:debates`, eventType: "debate.updated", payload: updatedDebate },
        { topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() },
      ],
      effects: hitCap
        ? [{ effectType: "debate.escalate.pm", payload: { projectId: debate.projectId, debateId: debate.id } }]
        : [],
    }));
  }

  private async executeDebatePmEscalation(projectId: string, debateId: string): Promise<void> {
    const project = this.db.getProject(projectId);
    const debate = this.db.getDebate(debateId);
    if (!project || !debate) return;
    const pm = this.db.listAgents(project.id).find((a) => a.scope === "project");
    if (!pm) return;
    const msgs = this.db.listDebateMessages(debate.id);
    const summaryLines = msgs.map((m) => `- Round ${m.roundNum} (${m.agentId}): ${m.position}`).join("\n");
    const turn = await this.runAgentTurn(
      pm.id,
      `Escalated Debate (${debate.id}): ${debate.topic}\nReason: ${debate.reason}\nRounds (${debate.roundCount}/${debate.maxRounds}):\n${summaryLines}\n\nProvide a clear tie-breaking recommendation for the operator/team.`,
      { emitTopic: `bot:${pm.id}:timeline`, namespace: `project:${project.slug}` },
    );
    if (!turn.ok) {
      this.recordTurnFailure({
        agentId: pm.id,
        projectId: project.id,
        emitTopic: `bot:${pm.id}:timeline`,
        eventType: "timeline.item",
        itemKind: "status",
        title: "Debate escalation turn failed",
        error: turn.error ?? "PM debate escalation failed",
        noticeLevel: "action",
        noticePrefix: `Debate escalation failed (${debate.topic})`,
      });
    }
  }

  private handleDebateResolve(cmd: Extract<RpcCommand, { type: "debate.resolve" }>) {
    const debate = this.db.getDebate(cmd.debateId);
    if (!debate) throw new Error(`Debate not found: ${cmd.debateId}`);
    if (debate.status === "resolved") throw new Error("debate_already_resolved");
    if (cmd.resolvedByAgentId) {
      const resolver = this.db.getAgent(cmd.resolvedByAgentId);
      if (!resolver) throw new Error(`Agent not found: ${cmd.resolvedByAgentId}`);
      if (resolver.projectId !== null && resolver.projectId !== debate.projectId) {
        throw new Error("agent_project_mismatch");
      }
    }

    const cleanDecision = this.scrubber.scrub(cmd.decision);
    const updated: DebateRecord = {
      ...debate,
      status: "resolved",
      resolutionSummary: cleanDecision,
      updatedAt: Date.now(),
    };

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { debate: updated },
      applyProjections: () => {
        this.db.upsertDebate(updated);
        for (const aid of debate.participantAgentIds) {
          const ag = this.db.getAgent(aid);
          if (ag && ag.status === "debating") {
            this.db.updateAgentStatus(aid, "idle", { lastSummary: `Debate resolved: ${cleanDecision.slice(0, 60)}` });
          }
        }
        this.db.addInboxNotice("info", `Debate '${debate.topic}' resolved: ${cleanDecision.slice(0, 80)}`, {
          projectId: debate.projectId,
        });
      },
      events: [
        { topic: `project:${debate.projectId}:debates`, eventType: "debate.updated", payload: updated },
        { topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() },
      ],
      effects: [],
    }));
  }

  private handleSelfModPropose(cmd: Extract<RpcCommand, { type: "selfmod.propose" }>) {
    if (cmd.authorAgentId && !this.db.getAgent(cmd.authorAgentId)) {
      throw new Error(`Agent not found: ${cmd.authorAgentId}`);
    }
    const proposalId = newId("smod");
    const staged = this.selfMod.stageProposal({
      id: proposalId,
      kind: cmd.kind,
      targetId: cmd.targetId,
      title: this.scrubber.scrub(cmd.title),
      rationale: this.scrubber.scrub(cmd.rationale),
      content: cmd.content,
      authorAgentId: cmd.authorAgentId ?? null,
    });
    const toPersist: SelfModProposalRecord = cmd.autoVerify ? { ...staged, status: "verifying" } : staged;

    try {
      return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
        result: { proposal: toPersist },
        applyProjections: () => {
          this.db.upsertSelfModProposal(toPersist);
          this.db.addInboxNotice("info", `Self-mod staged (${toPersist.kind}:${toPersist.targetId}): ${toPersist.title}`, {});
        },
        events: [
          { topic: "global:selfmod", eventType: "selfmod.updated", payload: toPersist },
          { topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() },
        ],
        effects: cmd.autoVerify ? [{ effectType: "selfmod.verify.run", payload: { proposalId: toPersist.id } }] : [],
      }));
    } catch (err) {
      try {
        rmSync(dirname(staged.stagingPath), { recursive: true, force: true });
      } catch {
        // best-effort orphan staging cleanup
      }
      throw err;
    }
  }

  private handleSelfModVerify(cmd: Extract<RpcCommand, { type: "selfmod.verify" }>) {
    const existing = this.db.getSelfModProposal(cmd.proposalId);
    if (!existing) throw new Error(`Self-mod proposal not found: ${cmd.proposalId}`);
    if (existing.status !== "staged" && existing.status !== "rejected") {
      throw new Error(`selfmod_not_verifiable:${existing.status}`);
    }
    const updated: SelfModProposalRecord = { ...existing, status: "verifying", updatedAt: Date.now() };
    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { proposal: updated },
      applyProjections: () => {
        this.db.upsertSelfModProposal(updated);
      },
      events: [
        { topic: "global:selfmod", eventType: "selfmod.updated", payload: updated },
        { topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() },
      ],
      effects: [{ effectType: "selfmod.verify.run", payload: { proposalId: updated.id } }],
    }));
  }

  private async executeSelfModVerification(proposalId: string): Promise<void> {
    const proposal = this.db.getSelfModProposal(proposalId);
    if (!proposal || proposal.status !== "verifying") return;
    const staticChecks = this.selfMod.runSandboxStaticChecks(proposal);
    let stagedContent = "";
    try {
      stagedContent = this.selfMod.readStagedContent(proposal);
    } catch {
      stagedContent = "";
    }
    const report = await this.verifier.verifySelfMod({ proposal, staticChecks, stagedContent });
    const nextStatus: SelfModProposalRecord["status"] = report.verdict === "pass" ? "verified" : "rejected";

    let persisted: SelfModProposalRecord | null = null;
    this.db.runAtomicWrite(() => {
      // Guard against stale async verify regressing an already-promoted/rolled-back proposal
      const latest = this.db.getSelfModProposal(proposalId);
      if (!latest || latest.status !== "verifying") return;
      persisted = {
        ...latest,
        status: nextStatus,
        verificationId: report.id,
        verificationSummary: report.summary.slice(0, 240),
        updatedAt: Date.now(),
      };
      this.db.upsertVerification(report);
      this.db.upsertSelfModProposal(persisted);
      this.db.addInboxNotice(
        nextStatus === "verified" ? "info" : "action",
        `Self-mod '${latest.title}' verification → ${report.verdict.toUpperCase()} (${report.verifierProvider}/${report.verifierModel})`,
        {},
      );
    });

    if (persisted) {
      this.core.emitDirectEvent("global:selfmod", "selfmod.updated", persisted);
      this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
    }
  }

  private reloadLiveConfigFromDisk(): void {
    if (existsSync(this.runtimeCfg.configPath)) {
      const parsed = HubConfigSchema.parse(JSON.parse(readFileSync(this.runtimeCfg.configPath, "utf8")));
      this.reloadConfig(parsed);
      return;
    }
    const inspected = resolveHubConfigInspection({
      rootDir: this.runtimeCfg.rootDir,
      dbPath: this.runtimeCfg.dbPath,
      port: this.runtimeCfg.config.hub.port,
    });
    this.reloadConfig(inspected.config);
  }

  private handleSelfModPromote(cmd: Extract<RpcCommand, { type: "selfmod.promote" }>) {
    const existing = this.db.getSelfModProposal(cmd.proposalId);
    if (!existing) throw new Error(`Self-mod proposal not found: ${cmd.proposalId}`);
    const candidate: SelfModProposalRecord = { ...existing };
    // Enforces selfModRequiresStagingAndVerifier + single-read SHA-256 integrity + creates live backup before swap
    this.selfMod.promoteProposal(candidate);

    try {
      const committed = this.core.commitCommand(cmd.commandId, cmd.type, () => ({
        result: { proposal: candidate },
        applyProjections: () => {
          this.db.upsertSelfModProposal(candidate);
          this.db.addInboxNotice("info", `Self-mod promoted (${candidate.kind}:${candidate.targetId}) with rollback backup`, {});
        },
        events: [
          { topic: "global:selfmod", eventType: "selfmod.updated", payload: candidate },
          { topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() },
        ],
        effects: [],
      }));
      if (candidate.kind === "config_patch") {
        this.reloadLiveConfigFromDisk();
      }
      return committed;
    } catch (err) {
      try {
        this.selfMod.rollbackProposal(candidate);
      } catch {
        // best-effort FS restore if DB commit failed
      }
      throw err;
    }
  }

  private handleSelfModRollback(cmd: Extract<RpcCommand, { type: "selfmod.rollback" }>) {
    const existing = this.db.getSelfModProposal(cmd.proposalId);
    if (!existing) throw new Error(`Self-mod proposal not found: ${cmd.proposalId}`);
    const candidate: SelfModProposalRecord = { ...existing };
    this.selfMod.rollbackProposal(candidate);

    const committed = this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { proposal: candidate },
      applyProjections: () => {
        this.db.upsertSelfModProposal(candidate);
        this.db.addInboxNotice(
          "warn",
          `Self-mod rolled back (${candidate.kind}:${candidate.targetId})${cmd.reason ? `: ${this.scrubber.scrub(cmd.reason)}` : ""}`,
          {},
        );
      },
      events: [
        { topic: "global:selfmod", eventType: "selfmod.updated", payload: candidate },
        { topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() },
      ],
      effects: [],
    }));
    if (candidate.kind === "config_patch") {
      this.reloadLiveConfigFromDisk();
    }
    return committed;
  }

  // --- Phase 2: Operator Controls, Config Hot-Reload, L1 Memory & Checkpoints ---

  private handlePermissionRespond(cmd: Extract<RpcCommand, { type: "permission.respond" }>) {
    const pending = this.acpRuntime.listPendingPermissions?.().find((p) => p.permissionId === cmd.permissionId);
    const resolved = this.acpRuntime.resolvePermission?.(cmd.permissionId, cmd.decision) ?? false;
    if (!resolved) {
      throw new Error(`permission_not_pending:${cmd.permissionId}`);
    }

    const resolvedEvent = {
      permissionId: cmd.permissionId,
      id: cmd.permissionId,
      agentId: pending?.agentId ?? null,
      sessionId: pending?.sessionId ?? null,
      decision: cmd.decision,
      status: cmd.decision === "deny" ? ("denied" as const) : ("allowed" as const),
      resolvedAt: Date.now(),
    };
    const statusEvt = { topic: "global:status" as SubscriptionTopic, eventType: "status.updated", payload: null as unknown };

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: {
        permissionId: cmd.permissionId,
        decision: cmd.decision,
        resolved: true,
        agentId: pending?.agentId ?? null,
      },
      applyProjections: () => {
        if (pending?.agentId) {
          const ag = this.db.getAgent(pending.agentId);
          if (ag && ag.status === "requires_action") {
            this.db.updateAgentStatus(ag.id, "working", {
              lastSummary: `Permission ${cmd.decision}: ${pending.title.slice(0, 50)}`,
            });
          }
        }
        statusEvt.payload = this.getQuietStatusProjection();
      },
      events: [
        { topic: "global:status", eventType: "permission.resolved", payload: resolvedEvent },
        ...(pending?.agentId
          ? [
              {
                topic: `bot:${pending.agentId}:timeline` as SubscriptionTopic,
                eventType: "permission.resolved",
                payload: resolvedEvent,
              },
            ]
          : []),
        statusEvt,
      ],
      effects: [],
    }));
  }

  private handleBotResume(cmd: Extract<RpcCommand, { type: "bot.resume" }>) {
    const agent = this.db.getAgent(cmd.agentId);
    if (!agent) throw new Error(`Agent not found: ${cmd.agentId}`);
    if (agent.status === "working") {
      throw new Error("agent_already_working");
    }

    const hadSession = agent.activeSessionId ? this.db.getSession(agent.activeSessionId) : null;
    const needsFreshSession = !hadSession || agent.status === "stopped";
    let nextSessionId = agent.activeSessionId;

    if (agent.activeSessionId) {
      const staleHandle = this.sessionHandles.get(agent.activeSessionId);
      const isDead =
        needsFreshSession ||
        (staleHandle?.runtimeKind === "acp_stdio" && !this.acpRuntime.isSessionAlive(agent.activeSessionId)) ||
        (staleHandle?.runtimeKind === "cli_stream" && !this.cliRuntime?.isSessionAlive(agent.activeSessionId));
      if (isDead) {
        this.sessionHandles.delete(agent.activeSessionId);
        this.revokeMcpTokensForAgent(agent.id);
      }
    }

    const now = Date.now();
    const freshPrompt = needsFreshSession ? this.buildAgentSystemPrompt(agent) : null;
    if (needsFreshSession) {
      nextSessionId = newId("ses");
    }

    const statusEvt = { topic: "global:status" as SubscriptionTopic, eventType: "status.updated", payload: null as unknown };

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { agentId: agent.id, status: "idle" as const, sessionId: nextSessionId },
      applyProjections: () => {
        if (needsFreshSession && nextSessionId && freshPrompt) {
          this.db.createSession({
            id: nextSessionId,
            agentId: agent.id,
            parentSessionId: agent.activeSessionId,
            systemPrompt: freshPrompt.systemPrompt,
            systemPromptHash: freshPrompt.hash,
            generation: 1,
            tokenIn: 0,
            tokenOut: 0,
            status: "active",
            createdAt: now,
            updatedAt: now,
          });
          this.db.upsertAgent({
            ...agent,
            status: "idle",
            pid: null,
            activeSessionId: nextSessionId,
            lastSummary: "Resumed by operator (fresh session)",
            updatedAt: now,
          });
        } else {
          this.db.updateAgentStatus(agent.id, "idle", {
            pid: agent.status === "error" ? null : undefined,
            lastSummary: "Resumed by operator",
          });
        }
        statusEvt.payload = this.getQuietStatusProjection();
      },
      events: [
        { topic: `bot:${agent.id}:timeline`, eventType: "agent.status", payload: { agentId: agent.id, status: "idle" } },
        statusEvt,
      ],
      effects: [],
    }));
  }

  private handleBotUpdateModel(cmd: Extract<RpcCommand, { type: "bot.update_model" }>) {
    const agent = this.db.getAgent(cmd.agentId);
    if (!agent) throw new Error(`Agent not found: ${cmd.agentId}`);

    const route = this.router.resolveTarget({ provider: cmd.provider, model: cmd.model });
    let handleToClose: RuntimeSessionHandle | undefined;

    const resObj: { agent: AgentRecord | null } = { agent: null };
    const boardEvt = agent.projectId
      ? {
          topic: `project:${agent.projectId}:board` as SubscriptionTopic,
          eventType: "board.updated",
          payload: null as unknown,
        }
      : null;
    const statusEvt = { topic: "global:status" as SubscriptionTopic, eventType: "status.updated", payload: null as unknown };

    const committed = this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: resObj,
      applyProjections: () => {
        let updated = this.db.updateAgentModel(agent.id, route.provider, route.model, route.runtimeKind);
        if (!updated) throw new Error(`Agent not found: ${cmd.agentId}`);
        if (updated.status !== "working" && updated.activeSessionId) {
          const cached = this.sessionHandles.get(updated.activeSessionId);
          if (cached) {
            this.sessionHandles.delete(updated.activeSessionId);
            this.revokeMcpTokensForAgent(updated.id);
            handleToClose = cached;
            if (updated.pid !== null) {
              this.db.updateAgentStatus(updated.id, updated.status, { pid: null });
              updated = this.db.getAgent(updated.id) ?? updated;
            }
          }
        }
        resObj.agent = updated;
        if (boardEvt && updated.projectId) {
          boardEvt.payload = this.getProjectBoardSnapshot(updated.projectId);
        }
        statusEvt.payload = this.getQuietStatusProjection();
      },
      events: [...(boardEvt ? [boardEvt] : []), statusEvt],
      effects: [],
    }));

    if (handleToClose) {
      void this.getRuntime(handleToClose.runtimeKind).closeSession(handleToClose).catch(() => {});
    }

    return committed;
  }

  private handleBotMessage(cmd: Extract<RpcCommand, { type: "bot.message" }>) {
    const project = this.db.getProject(cmd.projectId);
    if (!project) throw new Error(`Project not found: ${cmd.projectId}`);
    const agent = this.db.getAgent(cmd.agentId);
    if (!agent) throw new Error(`Agent not found: ${cmd.agentId}`);
    if (agent.projectId !== project.id) throw new Error("agent_project_mismatch");
    if (agent.status === "stopped" || agent.status === "paused") {
      throw new Error(`agent_unavailable:${agent.status}`);
    }
    if (!agent.activeSessionId) {
      throw new Error("agent_session_missing");
    }

    const cleanMsg = this.scrubber.scrub(cmd.message);
    const senderRole = cmd.senderRole ?? "user";
    const senderAgentId = cmd.senderAgentId ?? (senderRole === "orchestrator" ? this.metaAgentId : null);
    const now = Date.now();
    const item: TimelineItem = {
      id: newId("msg"),
      agentId: agent.id,
      sessionId: agent.activeSessionId,
      seq: 0,
      kind: "message",
      role: "user",
      senderAgentId,
      senderRole,
      ...(senderRole === "orchestrator" ? { title: "Main Manager Message" } : {}),
      content: cleanMsg,
      createdAt: now,
    };

    const boardEvt = {
      topic: `project:${project.id}:board` as SubscriptionTopic,
      eventType: "board.updated",
      payload: null as unknown,
    };
    const statusEvt = { topic: "global:status" as SubscriptionTopic, eventType: "status.updated", payload: null as unknown };

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { queued: true, projectId: project.id, agentId: agent.id, messageId: item.id, item },
      applyProjections: () => {
        this.db.appendMessage(item);
        this.db.updateAgentStatus(agent.id, "working", {
          lastSummary: `${senderRole === "orchestrator" ? "Manager message" : "Message"}: ${cleanMsg.slice(0, 60)}`,
        });
        boardEvt.payload = this.getProjectBoardSnapshot(project.id);
        statusEvt.payload = this.getQuietStatusProjection();
      },
      events: [
        { topic: `bot:${agent.id}:timeline`, eventType: "timeline.item", payload: item },
        boardEvt,
        statusEvt,
      ],
      effects: [
        {
          effectType: "bot.message.turn",
          payload: { projectId: project.id, agentId: agent.id, message: cleanMsg },
        },
      ],
    }));
  }

  private handleConfigUpdate(cmd: Extract<RpcCommand, { type: "config.update" }>) {
    let patch: unknown;
    try {
      patch = JSON.parse(cmd.patchJson);
    } catch {
      throw new Error("invalid_config_patch_json");
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("invalid_config_patch_json");
    }

    const patchRecord = patch as Record<string, unknown>;
    restoreRedactedProviderEnvValues(patchRecord, this.runtimeCfg.config);
    const nextCfg = mergeOpenByosConfigPatch(
      this.runtimeCfg.config,
      patchRecord,
      this.runtimeCfg.config,
    );
    const prevCfg = this.runtimeCfg.config;
    const savedCfg = saveHubConfig(this.runtimeCfg.configPath, nextCfg);
    this.reloadConfig(savedCfg);
    const exposedCfg = redactHubConfigForExposure(savedCfg);

    const statusEvt = { topic: "global:status" as SubscriptionTopic, eventType: "status.updated", payload: null as unknown };
    try {
      return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
        result: { config: exposedCfg },
        applyProjections: () => {
          this.db.addInboxNotice("info", "Hub configuration updated and hot-reloaded", {});
          statusEvt.payload = this.getQuietStatusProjection();
        },
        events: [
          { topic: "global:status", eventType: "config.updated", payload: { config: exposedCfg } },
          statusEvt,
        ],
        effects: [],
      }));
    } catch (err) {
      this.reloadConfig(prevCfg);
      throw err;
    }
  }

  private handleRoutingSetOverride(cmd: Extract<RpcCommand, { type: "routing.set_override" }>) {
    const project = this.db.getProject(cmd.projectId);
    if (!project) throw new Error(`Project not found: ${cmd.projectId}`);
    if (cmd.target !== null) {
      this.router.resolveTarget(cmd.target);
    }
    const nextOverrides = { ...project.routingOverrides };
    if (cmd.target === null) {
      delete nextOverrides[cmd.intent];
    } else {
      nextOverrides[cmd.intent] = cmd.target;
    }
    const updatedProject: ProjectRecord = { ...project, routingOverrides: nextOverrides };
    const statusEvt = { topic: "global:status" as SubscriptionTopic, eventType: "status.updated", payload: null as unknown };

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { project: updatedProject },
      applyProjections: () => {
        this.db.db
          .query("UPDATE projects SET routing_overrides_json = ? WHERE id = ?")
          .run(JSON.stringify(nextOverrides), project.id);
        statusEvt.payload = this.getQuietStatusProjection();
      },
      events: [
        { topic: "global:status", eventType: "project.updated", payload: updatedProject },
        statusEvt,
      ],
      effects: [],
    }));
  }

  private handleMemoryL1Get(cmd: Extract<RpcCommand, { type: "memory.l1.get" }>) {
    let project: ProjectRecord | null = null;
    if (cmd.target === "project") {
      if (!cmd.projectId) throw new Error("project_id_required_for_project_l1");
      project = this.db.getProject(cmd.projectId);
      if (!project) throw new Error(`Project not found: ${cmd.projectId}`);
    }
    const snap = this.memory.getL1Target(cmd.target, project?.rootPath);
    const result = { ...snap, projectId: project?.id ?? null };
    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result,
      applyProjections: () => {},
      events: [],
      effects: [],
    }));
  }

  private handleMemoryL1Update(cmd: Extract<RpcCommand, { type: "memory.l1.update" }>) {
    let project: ProjectRecord | null = null;
    if (cmd.target === "project") {
      if (!cmd.projectId) throw new Error("project_id_required_for_project_l1");
      project = this.db.getProject(cmd.projectId);
      if (!project) throw new Error(`Project not found: ${cmd.projectId}`);
    }
    const snap = this.memory.updateL1Target(cmd.target, cmd.content, project?.rootPath);
    const result = { ...snap, projectId: project?.id ?? null };
    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result,
      applyProjections: () => {},
      events: [
        {
          topic: "global:status",
          eventType: "memory.l1.updated",
          payload: { target: cmd.target, projectId: project?.id ?? null, usedChars: snap.usedChars, maxChars: snap.maxChars },
        },
      ],
      effects: [],
    }));
  }

  private listProjectCheckpoints(projectId: string, agentId?: string): CheckpointRecord[] {
    const rows = agentId
      ? (this.db.db
          .query(
            `SELECT c.* FROM checkpoints c
             JOIN agents a ON a.id = c.agent_id
             WHERE a.project_id = ? AND c.agent_id = ?
             ORDER BY c.created_at DESC LIMIT 100`,
          )
          .all(projectId, agentId) as Array<Record<string, unknown>>)
      : (this.db.db
          .query(
            `SELECT c.* FROM checkpoints c
             JOIN agents a ON a.id = c.agent_id
             WHERE a.project_id = ?
             ORDER BY c.created_at DESC LIMIT 100`,
          )
          .all(projectId) as Array<Record<string, unknown>>);

    return rows.map((r) => ({
      id: String(r.id),
      scopeKey: String(r.scope_key),
      agentId: String(r.agent_id),
      cwd: String(r.cwd),
      turnNum: Number(r.turn_num),
      refName: String(r.ref_name),
      commitSha: String(r.commit_sha),
      createdAt: Number(r.created_at),
    }));
  }

  private handleCheckpointList(cmd: Extract<RpcCommand, { type: "checkpoint.list" }>) {
    const project = this.db.getProject(cmd.projectId);
    if (!project) throw new Error(`Project not found: ${cmd.projectId}`);
    if (cmd.agentId) {
      const agent = this.db.getAgent(cmd.agentId);
      if (!agent) throw new Error(`Agent not found: ${cmd.agentId}`);
      if (agent.projectId !== project.id) throw new Error("agent_project_mismatch");
    }
    const checkpoints = this.listProjectCheckpoints(project.id, cmd.agentId);
    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { checkpoints },
      applyProjections: () => {},
      events: [],
      effects: [],
    }));
  }

  private handleCheckpointRollback(cmd: Extract<RpcCommand, { type: "checkpoint.rollback" }>) {
    const project = this.db.getProject(cmd.projectId);
    if (!project) throw new Error(`Project not found: ${cmd.projectId}`);
    const cp = this.db.getCheckpoint(cmd.checkpointId);
    if (!cp) throw new Error(`checkpoint_not_found: ${cmd.checkpointId}`);
    const agent = this.db.getAgent(cp.agentId);
    if (!agent || agent.projectId !== project.id) {
      throw new Error("checkpoint_project_mismatch");
    }
    const currentCwd = agent.worktreePath ?? project.repoPath;
    if (cp.scopeKey !== makeCheckpointScopeKey(agent.id, currentCwd)) {
      throw new Error("cross_worktree_restore_refused");
    }

    const statusEvt = { topic: "global:status" as SubscriptionTopic, eventType: "status.updated", payload: null as unknown };
    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { checkpoint: cp, projectId: project.id, agentId: agent.id, queued: true },
      applyProjections: () => {
        this.db.addInboxNotice("info", `Rolling back ${agent.name} to checkpoint #${cp.turnNum}`, {
          projectId: project.id,
          agentId: agent.id,
        });
        statusEvt.payload = this.getQuietStatusProjection();
      },
      events: [
        { topic: `project:${project.id}:board`, eventType: "board.updated", payload: this.getProjectBoardSnapshot(project.id) },
        statusEvt,
      ],
      effects: [
        {
          effectType: "checkpoint.rollback.run",
          payload: { projectId: project.id, agentId: agent.id, currentCwd, checkpointId: cp.id },
        },
      ],
    }));
  }

  private async executeCheckpointRollback(
    projectId: string,
    agentId: string,
    currentCwd: string,
    checkpointId: string,
  ): Promise<void> {
    try {
      await restoreCheckpoint(this.db, { agentId, currentCwd, checkpointId });
      this.db.runAtomicWrite(() => {
        const ag = this.db.getAgent(agentId);
        if (ag) {
          this.db.updateAgentStatus(ag.id, ag.status, {
            lastSummary: `Restored checkpoint ${checkpointId}`,
          });
        }
        this.db.addInboxNotice("info", `Checkpoint ${checkpointId} restored cleanly`, { projectId, agentId });
      });
    } catch (err) {
      const msg = this.scrubber.scrub(err instanceof Error ? err.message : String(err));
      this.db.runAtomicWrite(() => {
        this.db.addInboxNotice("action", `Checkpoint rollback failed (${checkpointId}): ${msg.slice(0, 120)}`, {
          projectId,
          agentId,
        });
      });
    }
    this.core.emitDirectEvent(`project:${projectId}:board`, "board.updated", this.getProjectBoardSnapshot(projectId));
    this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
  }

  private handleTaskMerge(cmd: Extract<RpcCommand, { type: "task.merge" }>) {
    const project = this.db.getProject(cmd.projectId);
    if (!project) throw new Error(`Project not found: ${cmd.projectId}`);
    const task = this.db.getTask(cmd.taskId);
    if (!task) throw new Error(`Task not found: ${cmd.taskId}`);
    if (task.projectId !== project.id) throw new Error("task_project_mismatch");
    if (task.status === "merged") throw new Error("task_already_merged");
    if (task.status !== "verified" && !cmd.overrideReason?.trim()) {
      throw new Error(`task_not_verified:${task.status}`);
    }

    const agent = task.assignedAgentId ? this.db.getAgent(task.assignedAgentId) : null;
    const branch = agent?.worktreeBranch || task.worktreeBranch;
    const worktreePath = agent?.worktreePath ?? "";
    if (!branch || branch === "main" || (!worktreePath && !branch)) {
      throw new Error("task_missing_worktree_for_merge");
    }

    const commitMessage =
      cmd.commitMessage?.trim() ||
      `feat(${project.slug}): ${task.title}${cmd.overrideReason?.trim() ? ` [override: ${this.scrubber.scrub(cmd.overrideReason.trim())}]` : ""}`;
    const statusEvt = { topic: "global:status" as SubscriptionTopic, eventType: "status.updated", payload: null as unknown };

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { taskId: task.id, projectId: project.id, strategy: cmd.strategy, branch, queued: true },
      applyProjections: () => {
        this.db.addInboxNotice("info", `Merging '${task.title}' (${cmd.strategy}) into main`, {
          projectId: project.id,
          agentId: agent?.id,
        });
        statusEvt.payload = this.getQuietStatusProjection();
      },
      events: [statusEvt],
      effects: [
        {
          effectType: "task.merge.run",
          payload: {
            projectId: project.id,
            taskId: task.id,
            agentId: agent?.id ?? null,
            worktreePath,
            branch,
            strategy: cmd.strategy,
            commitMessage,
          },
        },
      ],
    }));
  }

  private async executeTaskMerge(params: {
    projectId: string;
    taskId: string;
    agentId: string | null;
    worktreePath: string;
    branch: string;
    strategy: "squash" | "merge_commit";
    commitMessage: string;
  }): Promise<void> {
    const project = this.db.getProject(params.projectId);
    const task = this.db.getTask(params.taskId);
    if (!project || !task || task.status === "merged") return;

    const agent = params.agentId ? this.db.getAgent(params.agentId) : null;
    if (agent) {
      await this.subagentManager.cleanupSubagentsForParent(agent.id);
      await this.abortAndCloseAgentSession(agent, "hard_stop");
    }

    const res = await mergeBotWorktree({
      repoPath: project.repoPath,
      worktreePath: params.worktreePath,
      branch: params.branch,
      strategy: params.strategy,
      commitMessage: params.commitMessage,
    });

    if (res.ok) {
      let mergedTask: TaskRecord | null = null;
      this.db.runAtomicWrite(() => {
        const freshTask = this.db.getTask(task.id);
        if (!freshTask) return;
        const now = Date.now();
        mergedTask = {
          ...freshTask,
          status: "merged",
          worktreeBranch: null,
          updatedAt: now,
        };
        this.db.upsertTask(mergedTask);

        if (agent && res.cleanedWorktree) {
          const freshAgent = this.db.getAgent(agent.id);
          if (freshAgent) {
            this.db.upsertAgent({
              ...freshAgent,
              status: freshAgent.status === "stopped" ? "stopped" : "idle",
              pid: null,
              worktreePath: null,
              worktreeBranch: null,
              lastSummary: `Merged ${params.branch}${res.mergeCommitSha ? ` (${res.mergeCommitSha.slice(0, 7)})` : ""}`,
              updatedAt: now,
            });
          }
        }

        this.db.addInboxNotice(
          "info",
          `Merged '${freshTask.title}' into main (${params.strategy}${res.mergeCommitSha ? ` · ${res.mergeCommitSha.slice(0, 7)}` : ""})`,
          { projectId: project.id, agentId: agent?.id },
        );
      });

      if (mergedTask) {
        this.core.emitDirectEvent(`project:${project.id}:board`, "task.updated", mergedTask);
      }
      this.core.emitDirectEvent(`project:${project.id}:board`, "board.updated", this.getProjectBoardSnapshot(project.id));
      this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
      this.autonomyLoop.dispatchUnblockedTasks(project.id);
      return;
    }

    const cleanErr = this.scrubber.scrub(res.error ?? "merge_failed");
    this.db.runAtomicWrite(() => {
      this.db.addInboxNotice(
        "action",
        `Merge failed for '${task.title}': ${cleanErr}${res.conflicts?.length ? ` (${res.conflicts.join(", ")})` : ""}`,
        { projectId: project.id, agentId: agent?.id },
      );
    });
    this.core.emitDirectEvent(`project:${project.id}:board`, "task.merge_failed", {
      taskId: task.id,
      error: cleanErr,
      conflicts: res.conflicts ?? [],
      preMergeRef: res.preMergeRef ?? null,
    });
    this.core.emitDirectEvent(`project:${project.id}:board`, "board.updated", this.getProjectBoardSnapshot(project.id));
    this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
  }

  private handleProjectArchive(cmd: Extract<RpcCommand, { type: "project.archive" }>) {
    const project = this.db.getProject(cmd.projectId);
    if (!project) throw new Error(`Project not found: ${cmd.projectId}`);
    const updated: ProjectRecord = { ...project, status: cmd.status };
    const statusEvt = { topic: "global:status" as SubscriptionTopic, eventType: "status.updated", payload: null as unknown };

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { project: updated },
      applyProjections: () => {
        this.db.db.query("UPDATE projects SET status = ? WHERE id = ?").run(cmd.status, project.id);
        this.db.addInboxNotice("info", `Project '${project.name}' status → ${cmd.status}`, { projectId: project.id });
        statusEvt.payload = this.getQuietStatusProjection();
      },
      events: [
        { topic: "global:status", eventType: "project.updated", payload: updated },
        statusEvt,
      ],
      effects: [],
    }));
  }

  private handleInboxDismiss(cmd: Extract<RpcCommand, { type: "inbox.dismiss" }>) {
    const statusEvt = { topic: "global:status" as SubscriptionTopic, eventType: "status.updated", payload: null as unknown };
    const resObj = { noticeId: cmd.noticeId, dismissed: false };
    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: resObj,
      applyProjections: () => {
        const res = this.db.db.query("UPDATE inbox_notices SET dismissed = 1 WHERE id = ? AND dismissed = 0").run(cmd.noticeId);
        resObj.dismissed = res.changes > 0;
        statusEvt.payload = this.getQuietStatusProjection();
      },
      events: [statusEvt],
      effects: [],
    }));
  }

  private buildConciseProjectSummary(projectId: string): string {
    const project = this.db.getProject(projectId);
    if (!project) return "";
    const tasks = this.db.listTasks(project.id);
    const agents = this.db.listAgents(project.id);
    const openDebates = this.db.listDebates(project.id).filter((d) => d.status !== "resolved");

    const counts: Record<string, number> = {};
    for (const t of tasks) {
      counts[t.status] = (counts[t.status] ?? 0) + 1;
    }
    const countsLine = Object.entries(counts)
      .map(([status, count]) => `${status}=${count}`)
      .join(", ");
    const activeTaskLines = tasks
      .filter((t) => t.status !== "merged")
      .slice(0, 5)
      .map((t) => `- [${t.status}] ${t.title} (${t.id})`);
    const agentLines = agents.slice(0, 6).map((a) => `- ${a.name} (${a.scope}, ${a.status}, ${a.provider}/${a.model})`);

    return this.scrubber.scrub(
      [
        `<active_project_context id="${project.id}" slug="${project.slug}" status="${project.status}">`,
        `Name: ${project.name}`,
        `Repo: ${project.repoPath}`,
        `Tasks (${tasks.length}): ${countsLine || "none"}`,
        activeTaskLines.length > 0 ? `Recent Tasks:\n${activeTaskLines.join("\n")}` : "",
        agentLines.length > 0 ? `Agents:\n${agentLines.join("\n")}` : "",
        `Open Debates: ${openDebates.length}`,
        `</active_project_context>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  // --- Read Projections for Scoped Subscriptions ---

  private getScrubbedConfigSnapshot() {
    const cfg = this.runtimeCfg.config;
    const providers = Object.fromEntries(
      Object.entries(cfg.providers).map(([providerId, p]) => [
        providerId,
        {
          runtime: p.runtime,
          ...(p.protocol ? { protocol: p.protocol } : {}),
          ...(p.adapter ? { adapter: p.adapter } : {}),
          ...(p.baseUrl ? { baseUrl: this.scrubber.scrub(p.baseUrl) } : {}),
          ...(p.apiKeyEnv
            ? {
                apiKeyEnv: p.apiKeyEnv,
                apiKeyConfigured: Boolean(this.runtimeCfg.secrets[p.apiKeyEnv]),
              }
            : {}),
          ...(p.command ? { command: p.command } : {}),
          ...(p.args ? { args: [...p.args] } : {}),
          ...(p.embeddingModel ? { embeddingModel: p.embeddingModel } : {}),
          models: Object.fromEntries(
            Object.entries(p.models).map(([modelKey, m]) => [
              modelKey,
              { id: m.id, capabilities: [...m.capabilities], tier: m.tier },
            ]),
          ),
        },
      ]),
    );
    const rawSnapshot = {
      version: cfg.version,
      hub: {
        host: cfg.hub.host,
        port: this.boundPort ?? cfg.hub.port,
        rootDir: this.scrubber.scrub(this.runtimeCfg.rootDir),
        defaultProjectsDir: this.scrubber.scrub(this.runtimeCfg.projectsDir),
      },
      providers,
      routing: structuredClone(cfg.routing),
      memory: structuredClone(cfg.memory),
      guardrails: structuredClone(cfg.guardrails),
    };
    return JSON.parse(this.scrubber.scrub(JSON.stringify(rawSnapshot))) as typeof rawSnapshot;
  }

  public getQuietStatusProjection(): QuietStatusProjection {
    const counts = this.db.getQuietStatusCounts();
    const rawPending = this.acpRuntime.listPendingPermissions?.() ?? [];
    const pendingPermissions = rawPending.map((p) => this.toPermissionRequestRecord(p));
    const activeGoals = this.autonomyLoop.listGoals().filter((g) => g.status === "active");
    return {
      ...counts,
      inboxNotices: this.db.listInboxNotices(15),
      unknownAdmissions: this.db.listUnknownAdmissions(),
      pendingPermissionsCount: pendingPermissions.length,
      pendingPermissions,
      ...(activeGoals.length > 0 ? { activeGoals } : {}),
    };
  }

  public getGlobalSnapshot() {
    return {
      status: this.getQuietStatusProjection(),
      projects: this.db.listProjects(),
      agents: this.db.listAgents(),
      goals: this.autonomyLoop.listGoals(),
      providers: Object.entries(this.runtimeCfg.config.providers).map(([name, cfg]) => ({
        name,
        runtime: cfg.runtime,
        models: Object.keys(cfg.models),
      })),
    };
  }

  public getMetaChatSnapshot() {
    return {
      agent: this.db.getAgent(this.metaAgentId),
      messages: this.db.listAgentTimeline(this.metaAgentId, 80).filter((m) => m.kind === "message"),
      cards: this.db.listRecentEvents("chat:meta", "chat.artifact_card", 20),
    };
  }

  public getProjectBoardSnapshot(projectId: string): {
    project: ProjectRecord | null;
    agents: AgentRecord[];
    tasks: TaskRecord[];
    goals: TeamGoalRecord[];
  } {
    return {
      project: this.db.getProject(projectId),
      agents: this.db.listAgents(projectId),
      tasks: this.db.listTasks(projectId),
      goals: this.autonomyLoop.listGoals(projectId),
    };
  }

  public getProjectPreviewsSnapshot(projectId: string): {
    project: ProjectRecord | null;
    artifacts: ArtifactEntry[];
    annotations: AnnotationRecord[];
  } {
    const project = this.db.getProject(projectId);
    if (!project) return { project: null, artifacts: [], annotations: [] };
    return {
      project,
      artifacts: listProjectArtifacts(project.id, project.rootPath),
      annotations: this.db.listAnnotations(project.id),
    };
  }

  public getProjectDebatesSnapshot(projectId: string): {
    project: ProjectRecord | null;
    debates: DebateRecord[];
    messagesByDebate: Record<string, DebateMessageRecord[]>;
    verifications: VerificationReportRecord[];
  } {
    const project = this.db.getProject(projectId);
    if (!project) return { project: null, debates: [], messagesByDebate: {}, verifications: [] };
    const debates = this.db.listDebates(project.id);
    const messagesByDebate: Record<string, DebateMessageRecord[]> = {};
    for (const d of debates) {
      messagesByDebate[d.id] = this.db.listDebateMessages(d.id);
    }
    return {
      project,
      debates,
      messagesByDebate,
      verifications: this.db.listVerifications({ projectId: project.id }),
    };
  }

  public getSelfModSnapshot(): { proposals: SelfModProposalRecord[]; verifications: VerificationReportRecord[] } {
    return {
      proposals: this.db.listSelfModProposals(),
      verifications: this.db.listVerificationsByTarget("selfmod", 40),
    };
  }

  public getBotTimelineSnapshot(agentId: string) {
    return {
      agent: this.db.getAgent(agentId),
      timeline: this.db.listAgentTimeline(agentId, 150),
    };
  }
}
