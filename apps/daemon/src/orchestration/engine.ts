import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  newId,
  RpcCommandSchema,
  slugify,
  type AgentRecord,
  type AnnotationRecord,
  type ArtifactEntry,
  type DebateMessageRecord,
  type DebateRecord,
  type ProjectRecord,
  type QuietStatusProjection,
  type RpcCommand,
  type SelfModProposalRecord,
  type SubscriptionTopic,
  type TaskRecord,
  type TimelineItem,
  type VerificationReportRecord,
} from "@bot-factory/shared";
import type { LoadedRuntimeConfig, SecretScrubber } from "../config";
import type { CommandCore } from "../core/commandCore";
import type { StateDatabase } from "../db/database";
import {
  captureCheckpoint,
  createBotWorktree,
  listProjectArtifacts,
  provisionProjectWorkspace,
  removeBotWorktree,
  writeTaskHandoff,
} from "../git/worktrees";
import type { LocalSuperHermesMemory } from "../memory/memoryEngine";
import { SelfModManager } from "../phase3/selfMod";
import { IndependentVerifier } from "../phase3/verifier";
import { resolveSafeProjectFile } from "../rpc/server";
import type { AcpSubprocessRuntime } from "../runtimes/acpSubprocessRuntime";
import type { NativeHttpRuntime } from "../runtimes/nativeHttpRuntime";
import type { ModelRouter } from "../runtimes/router";
import type { AgentRuntime, RuntimeSessionHandle } from "../runtimes/types";

export class OrchestrationEngine {
  public readonly metaAgentId = "agent_meta_orchestrator";
  private readonly sessionHandles = new Map<string, RuntimeSessionHandle>();
  private readonly turnCounters = new Map<string, number>();
  private readonly verifier: IndependentVerifier;
  private readonly selfMod: SelfModManager;
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
  ) {
    this.verifier = new IndependentVerifier(runtimeCfg, db, memory, router, nativeRuntime, acpRuntime, scrubber);
    this.selfMod = new SelfModManager(runtimeCfg, scrubber);
    this.ensureMetaOrchestrator();
    this.registerOutboxHandlers();
  }

  public setBoundPort(port: number): void {
    this.boundPort = port;
  }

  public getDaemonUrl(): string {
    const port = this.boundPort ?? this.runtimeCfg.config.hub.port;
    return `http://${this.runtimeCfg.config.hub.host}:${port}`;
  }

  public shutdownSync(): void {
    this.acpRuntime.shutdownAllSync();
    this.nativeRuntime.shutdownAllSync();
    this.sessionHandles.clear();
  }

  public async shutdown(): Promise<void> {
    await Promise.all([this.acpRuntime.shutdownAll(), this.nativeRuntime.shutdownAll()]);
    this.sessionHandles.clear();
  }

  private ensureMetaOrchestrator(): AgentRecord {
    const existing = this.db.getAgent(this.metaAgentId);
    if (existing) return existing;

    const route = this.router.resolveIntent("meta_orchestrator");
    const now = Date.now();
    const sessionId = newId("ses");
    const { systemPrompt, hash } = this.memory.buildFrozenSystemPrompt({
      identity:
        "You are the Bot-Factory Meta-Orchestrator (Life-Manager). You keep the human's main Chat-Tab calm, concise, and strategic while provisioning projects and steering background Project Managers.",
      toolsBrief:
        "You coordinate projects under ~/bot-factory/projects/<slug>/, spawn Project Managers, review high-level milestones, and record durable preferences/decisions.",
      namespace: "global",
      modelLabel: `${route.provider}/${route.model}`,
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
    return kind === "acp_stdio" ? this.acpRuntime : this.nativeRuntime;
  }

  private registerOutboxHandlers(): void {
    this.core.registerEffectHandler("meta.chat.turn", async (eff) => {
      const text = String(eff.payload.text ?? "");
      await this.runAgentTurn(this.metaAgentId, text, {
        emitTopic: "chat:meta",
        namespace: "global",
      });
    });

    this.core.registerEffectHandler("pm.steer.turn", async (eff) => {
      const projectId = String(eff.payload.projectId ?? "");
      const pmAgentId = String(eff.payload.pmAgentId ?? "");
      const message = String(eff.payload.message ?? "");
      const project = this.db.getProject(projectId);
      if (!project) return;

      await this.memory.ingestDocument({
        docId: `steer:${projectId}:${Date.now()}`,
        namespace: `project:${project.slug}`,
        content: `Decision / Steer from operator: ${message}`,
        instant: true,
      });

      await this.runAgentTurn(pmAgentId, `Operator Steer (highest priority): ${message}\nUpdate plan/tasks and report concise next steps.`, {
        emitTopic: `bot:${pmAgentId}:timeline`,
        namespace: `project:${project.slug}`,
      });

      this.core.emitDirectEvent(`project:${projectId}:board`, "board.updated", this.getProjectBoardSnapshot(projectId));
      this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
    });

    this.core.registerEffectHandler("task.run", async (eff) => {
      const projectId = String(eff.payload.projectId ?? "");
      const taskId = String(eff.payload.taskId ?? "");
      const agentId = String(eff.payload.agentId ?? "");
      await this.executePeerTask(projectId, taskId, agentId);
    });
    this.core.registerEffectHandler("bot.abort", async (eff) => {
      const agentId = String(eff.payload.agentId ?? "");
      const mode = eff.payload.mode === "pause" ? "pause" : "hard_stop";
      const agent = this.db.getAgent(agentId);
      if (!agent) return;
      const handle = this.sessionHandles.get(agent.activeSessionId ?? "");
      if (handle) {
        await this.getRuntime(agent.runtimeType).abort(handle, mode);
        if (mode === "hard_stop") {
          this.sessionHandles.delete(handle.sessionId);
        }
      }
    });

    this.core.registerEffectHandler("task.verify.run", async (eff) => {
      const projectId = String(eff.payload.projectId ?? "");
      const taskId = String(eff.payload.taskId ?? "");
      const checks = Array.isArray(eff.payload.checks) ? eff.payload.checks.map(String) : undefined;
      await this.executeTaskVerification(projectId, taskId, checks);
    });

    this.core.registerEffectHandler("selfmod.verify.run", async (eff) => {
      const proposalId = String(eff.payload.proposalId ?? "");
      await this.executeSelfModVerification(proposalId);
    });

    this.core.registerEffectHandler("debate.escalate.pm", async (eff) => {
      const projectId = String(eff.payload.projectId ?? "");
      const debateId = String(eff.payload.debateId ?? "");
      await this.executeDebatePmEscalation(projectId, debateId);
    });
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
      case "bot.spawn":
        return this.handleBotSpawn(cmd);
      case "bot.pause":
        return this.handleBotControl(cmd.commandId, cmd.agentId, "pause");
      case "bot.stop":
        return this.handleBotControl(cmd.commandId, cmd.agentId, "hard_stop");
      case "steer.submit":
        return this.handleSteerSubmit(cmd);
      case "task.create":
        return this.handleTaskCreate(cmd);
      case "task.dispatch":
        return this.handleTaskDispatch(cmd);
      case "task.verify":
        return this.handleTaskVerify(cmd);
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
    }
  }

  private handleChatSend(cmd: Extract<RpcCommand, { type: "chat.send" }>) {
    const meta = this.ensureMetaOrchestrator();
    const sessionId = meta.activeSessionId!;
    const now = Date.now();
    const cleanText = this.scrubber.scrub(cmd.text);

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
      effects: [{ effectType: "meta.chat.turn", payload: { text: cleanText } }],
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

  private handleBotSpawn(cmd: Extract<RpcCommand, { type: "bot.spawn" }>) {
    const project = this.db.getProject(cmd.projectId);
    if (!project) throw new Error(`Project not found: ${cmd.projectId}`);

    const existingPeers = this.db.listAgents(project.id).filter((a) => a.scope === "peer" && a.status !== "stopped");
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

    const pm = this.db.listAgents(project.id).find((a) => a.scope === "project");
    const { systemPrompt, hash } = this.memory.buildFrozenSystemPrompt({
      identity: `You are autonomous ${cmd.scope} bot '${cmd.name}' working on project '${project.name}'.`,
      toolsBrief: "Work cleanly inside your isolated Git worktree, produce concise handoffs, and avoid unrelated changes.",
      projectContext: `Project: ${project.name} (${project.slug})`,
      worktreePath,
      namespace: `project:${project.slug}`,
      projectRoot: project.rootPath,
      modelLabel: `${route.provider}/${route.model}`,
    });

    const bot: AgentRecord = {
      id: agentId,
      projectId: project.id,
      parentAgentId: pm?.id ?? null,
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
      effects: [{ effectType: "pm.steer.turn", payload: { projectId: project.id, pmAgentId: pm.id, message: cleanMsg } }],
    }));
  }

  private handleTaskCreate(cmd: Extract<RpcCommand, { type: "task.create" }>) {
    const project = this.db.getProject(cmd.projectId);
    if (!project) throw new Error(`Project not found: ${cmd.projectId}`);
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

    const updatedTask: TaskRecord = {
      ...task,
      status: "claimed",
      assignedAgentId: bot.id,
      worktreeBranch: bot.worktreeBranch,
      updatedAt: Date.now(),
    };

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { task: updatedTask, agent: bot },
      applyProjections: () => {
        this.db.upsertTask(updatedTask);
        this.db.updateAgentStatus(bot!.id, "working", { lastSummary: `Claimed task: ${task.title}` });
      },
      events: [
        { topic: `project:${project.id}:board`, eventType: "task.updated", payload: updatedTask },
        { topic: "global:status", eventType: "status.updated", payload: this.getQuietStatusProjection() },
      ],
      effects: [{ effectType: "task.run", payload: { projectId: project.id, taskId: task.id, agentId: bot!.id } }],
    }));
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
        this.db.listAgents(project.id).find((a) => a.scope === "peer" && a.status === "idle") ??
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

    const updated: AnnotationRecord = {
      ...existing,
      status: cmd.status,
      updatedAt: Date.now(),
    };

    const reopenEffects: Array<{ effectType: string; payload: Record<string, unknown> }> = [];
    let nextTaskToSave: TaskRecord | null = null;
    let maxRetryNotice: string | null = null;

    if (cmd.status === "open" && existing.linkedTaskId) {
      const task = this.db.getTask(existing.linkedTaskId);
      if (task && task.retryCount < this.runtimeCfg.config.guardrails.maxAnnotationFixRetries) {
        nextTaskToSave = { ...task, status: "claimed", retryCount: task.retryCount + 1, updatedAt: Date.now() };
        if (task.assignedAgentId) {
          updated.status = "in_progress";
          reopenEffects.push({
            effectType: "task.run",
            payload: { projectId: existing.projectId, taskId: task.id, agentId: task.assignedAgentId },
          });
        }
      } else if (task) {
        maxRetryNotice = `Annotation ${existing.id} hit max auto-fix retries (${this.runtimeCfg.config.guardrails.maxAnnotationFixRetries}); human review required.`;
      }
    }

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
      result: { annotation: updated },
      applyProjections: () => {
        if (nextTaskToSave) this.db.upsertTask(nextTaskToSave);
        if (maxRetryNotice) this.db.addInboxNotice("action", maxRetryNotice, { projectId: existing.projectId });
        this.db.upsertAnnotation(updated);
      },
      events: [
        { topic: `project:${existing.projectId}:previews`, eventType: "annotation.updated", payload: updated },
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

  private async executePeerTask(projectId: string, taskId: string, agentId: string): Promise<void> {
    const project = this.db.getProject(projectId);
    const task = this.db.getTask(taskId);
    const agent = this.db.getAgent(agentId);
    if (!project || !task || !agent) return;
    if (agent.status === "stopped" || agent.status === "paused") return;

    const annotation = task.sourceAnnotationId ? this.db.getAnnotation(task.sourceAnnotationId) : null;
    const cwd = agent.worktreePath ?? project.repoPath;

    const summaryText = await this.runAgentTurn(
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

    // Also record a task marker file inside the isolated worktree so Git checkpoint captures a concrete diff
    const wtNote = join(cwd, `.bf-task-${task.id}.md`);
    writeFileSync(wtNote, `# ${task.title}\n\nCompleted by ${agent.name} (${agent.provider}/${agent.model})\n\n${summaryText}\n`, "utf8");
    changedFiles.push(`.bf-task-${task.id}.md`);

    // Separate milestone (T3 invariant): turn finished -> now capture workspace-scoped hidden Git checkpoint!
    const nextTurn = (this.turnCounters.get(agent.id) ?? 0) + 1;
    this.turnCounters.set(agent.id, nextTurn);
    let checkpointRef: string | null = null;
    try {
      const cp = await captureCheckpoint(this.db, { agentId: agent.id, cwd, turnNum: nextTurn });
      checkpointRef = cp.refName;
    } catch {
      // Non-git fallback stays safe
    }

    const handoffPath = writeTaskHandoff(project.rootPath, task.id, {
      title: task.title,
      summary: summaryText,
      changedFiles,
      testsRun: ["worktree-checkpoint-verified"],
      notes: checkpointRef ? `Checkpoint ref: ${checkpointRef}` : undefined,
    });

    const completedTask: TaskRecord = {
      ...task,
      status: "in_review",
      handoffPath,
      updatedAt: Date.now(),
    };

    const handoffItem: TimelineItem = {
      id: newId("msg"),
      agentId: agent.id,
      sessionId: agent.activeSessionId!,
      seq: 0,
      kind: "handoff",
      role: "assistant",
      title: `Handoff written: ${handoffPath}`,
      content: summaryText,
      filePath: handoffPath,
      checkpointRef,
      createdAt: Date.now(),
    };

    this.db.runAtomicWrite(() => {
      this.db.upsertTask(completedTask);
      this.db.appendMessage(handoffItem);
      this.db.updateAgentStatus(agent.id, "waiting_review", { lastSummary: `Handoff ready (${handoffPath})` });
      if (annotation) {
        this.db.upsertAnnotation({
          ...annotation,
          status: "resolved_pending_review",
          updatedAt: Date.now(),
        });
      }
      this.db.addInboxNotice("info", `${agent.name} finished '${task.title}' → ready for review`, {
        projectId: project.id,
        agentId: agent.id,
      });
    });

    this.core.emitDirectEvent(`bot:${agent.id}:timeline`, "timeline.item", handoffItem);
    this.core.emitDirectEvent(`project:${project.id}:board`, "task.updated", completedTask);
    if (annotation) {
      this.core.emitDirectEvent(`project:${project.id}:previews`, "annotation.updated", this.db.getAnnotation(annotation.id));
    }
    this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
  }

  private async runAgentTurn(
    agentId: string,
    userText: string,
    opts: { emitTopic: SubscriptionTopic; namespace: string; imageDataUrl?: string | null },
  ): Promise<string> {
    const agent = this.db.getAgent(agentId);
    if (!agent || !agent.activeSessionId) throw new Error(`Agent/session missing: ${agentId}`);
    const session = this.db.getSession(agent.activeSessionId);
    if (!session) throw new Error(`Session missing: ${agent.activeSessionId}`);

    const admission = this.db.runAtomicWrite(() => this.db.enqueueAdmission(session.id, userText, "started"));

    const runtime = this.getRuntime(agent.runtimeType);
    let handle = this.sessionHandles.get(session.id);
    if (!handle) {
      const mcpBridgeScript = resolve(import.meta.dir, "../mcp/mcpBridge.ts");
      const mcpServers =
        agent.runtimeType === "acp_stdio"
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
                  BOT_FACTORY_TOKEN: this.runtimeCfg.sessionToken,
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
      });
      this.sessionHandles.set(session.id, handle);
      if (handle.pid) {
        this.db.runAtomicWrite(() => this.db.updateAgentStatus(agent.id, "working", { pid: handle!.pid }));
      }
    }

    const history = this.db
      .listAgentTimeline(agent.id, 24)
      .filter((m) => m.kind === "message" && (m.role === "user" || m.role === "assistant"))
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const ephemeralContext = this.memory.prefetch(opts.namespace);
    let finalText = "";

    try {
      for await (const evt of runtime.sendTurn(handle, {
        userText,
        ephemeralContext: ephemeralContext || undefined,
        history,
        imageDataUrl: opts.imageDataUrl,
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
            this.db.runAtomicWrite(() => this.db.appendMessage(item));
            this.core.emitDirectEvent(opts.emitTopic, "timeline.item", item);
          }
        } else if (evt.type === "permission_escalated") {
          this.db.runAtomicWrite(() => {
            this.db.updateAgentStatus(agent.id, "requires_action", { lastSummary: evt.reason });
            this.db.addInboxNotice("action", `Permission escalated for ${agent.name}: ${evt.reason}`, {
              projectId: agent.projectId ?? undefined,
              agentId: agent.id,
            });
          });
          this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
        } else if (evt.type === "done") {
          finalText = evt.finalText;
        } else if (evt.type === "error") {
          finalText = `Error: ${evt.message}`;
        }
      }

      const assistantItem: TimelineItem = {
        id: newId("msg"),
        agentId: agent.id,
        sessionId: session.id,
        seq: 0,
        kind: "message",
        role: "assistant",
        content: finalText || "(no output)",
        createdAt: Date.now(),
      };

      this.db.runAtomicWrite(() => {
        this.db.appendMessage(assistantItem);
        this.db.updateAdmissionStatus(admission.id, "terminal");
        const latest = this.db.getAgent(agent.id);
        if (!latest || latest.status === "working" || latest.status === "idle") {
          this.db.updateAgentStatus(agent.id, "idle", { lastSummary: (finalText || "Idle").slice(0, 90) });
        }
      });

      this.core.emitDirectEvent(opts.emitTopic, opts.emitTopic === "chat:meta" ? "chat.message" : "timeline.item", assistantItem);
      this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());

      // Non-blocking memory pre-warm for next turn
      this.memory.queuePrefetch(opts.namespace, `${userText}\n${finalText}`);
      return finalText;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.db.runAtomicWrite(() => {
        this.db.updateAdmissionStatus(admission.id, "terminal");
        const latest = this.db.getAgent(agent.id);
        if (!latest || (latest.status !== "paused" && latest.status !== "stopped")) {
          this.db.updateAgentStatus(agent.id, "error", { lastSummary: msg.slice(0, 90) });
        }
      });
      throw err;
    }
  }

  // --- MCP Bridge Tool Handler (for external ACP bots) ---

  public async handleMcpToolCall(toolName: string, body: { projectId: string; agentId: string; args?: Record<string, unknown> }) {
    const args = body.args ?? {};
    const project = this.db.getProject(body.projectId);
    const ns = project ? `project:${project.slug}` : "global";

    switch (toolName) {
      case "bf_task_list": {
        const tasks = this.db.listTasks(body.projectId);
        const status = args.status ? String(args.status) : null;
        return { tasks: status ? tasks.filter((t) => t.status === status) : tasks };
      }
      case "bf_task_claim": {
        const claimingAgent = this.db.getAgent(body.agentId);
        if (!claimingAgent) return { error: "agent_not_found" };
        const requestedId = args.taskId ? String(args.taskId) : "";
        let task = requestedId ? this.db.getTask(requestedId) : null;
        if (!requestedId) {
          task = this.db.listTasks(body.projectId).find((t) => t.status === "ready") ?? null;
        }
        if (!task) return { error: requestedId ? "task_not_found" : "no_ready_tasks" };
        if (project && task.projectId !== project.id) return { error: "task_project_mismatch" };
        if (task.status !== "ready" && task.status !== "backlog") return { error: `task_not_claimable:${task.status}` };
        const updated: TaskRecord = { ...task, status: "claimed", assignedAgentId: claimingAgent.id, updatedAt: Date.now() };
        this.db.runAtomicWrite(() => this.db.upsertTask(updated));
        this.core.emitDirectEvent(`project:${task.projectId}:board`, "task.updated", updated);
        return { task: updated };
      }
      case "bf_task_update": {
        const task = this.db.getTask(String(args.taskId ?? ""));
        if (!task) return { error: "task_not_found" };
        if (project && task.projectId !== project.id) return { error: "task_project_mismatch" };
        const updated: TaskRecord = {
          ...task,
          status: (args.status as TaskRecord["status"]) ?? task.status,
          updatedAt: Date.now(),
        };
        this.db.runAtomicWrite(() => this.db.upsertTask(updated));
        this.core.emitDirectEvent(`project:${task.projectId}:board`, "task.updated", updated);
        return { task: updated };
      }
      case "bf_handoff_write": {
        if (!project) return { error: "project_not_found" };
        const taskId = String(args.taskId ?? newId("tsk"));
        const path = writeTaskHandoff(project.rootPath, taskId, {
          title: String(args.title ?? taskId),
          summary: String(args.summary ?? args.content ?? ""),
          changedFiles: Array.isArray(args.changedFiles) ? args.changedFiles.map(String) : [],
          testsRun: Array.isArray(args.testsRun) ? args.testsRun.map(String) : [],
          notes: args.notes ? String(args.notes) : undefined,
        });
        return { handoffPath: path };
      }
      case "bf_memory_search": {
        const scope = args.scope === "global" ? "global" : ns;
        return this.memory.search(scope, String(args.query ?? ""), Number(args.limit ?? 8));
      }
      case "bf_fix_tasks_list": {
        const annotations = this.db.listAnnotations(body.projectId).filter((a) => a.status === "open" || a.status === "in_progress");
        return { annotations };
      }
      case "bf_fix_task_resolve": {
        const annId = args.annotationId ? String(args.annotationId) : "";
        const linkedTaskId = args.taskId ? String(args.taskId) : "";
        const ann =
          (annId ? this.db.getAnnotation(annId) : null) ??
          (linkedTaskId ? this.db.listAnnotations(body.projectId).find((a) => a.linkedTaskId === linkedTaskId) ?? null : null);
        if (!ann) return { error: "annotation_not_found" };
        if (project && ann.projectId !== project.id) return { error: "annotation_project_mismatch" };
        const updated: AnnotationRecord = { ...ann, status: "resolved_pending_review", updatedAt: Date.now() };
        this.db.runAtomicWrite(() => this.db.upsertAnnotation(updated));
        this.core.emitDirectEvent(`project:${ann.projectId}:previews`, "annotation.updated", updated);
        return { annotation: updated };
      }
      case "bf_debate_post": {
        if (!project) return { error: "project_not_found" };
        if (typeof args.debateId !== "string" || typeof args.position !== "string") {
          return { error: "invalid_debate_post_args" };
        }
        const parsed = RpcCommandSchema.safeParse({
          commandId: newId("cmd"),
          type: "debate.post",
          debateId: args.debateId,
          agentId: body.agentId,
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
    const nextStatus: TaskRecord["status"] =
      report.verdict === "pass" ? "verified" : report.verdict === "fail" ? "blocked" : "in_review";
    const updatedTask: TaskRecord = { ...task, status: nextStatus, updatedAt: Date.now() };

    this.db.runAtomicWrite(() => {
      this.db.upsertVerification(report);
      this.db.upsertTask(updatedTask);
      this.db.addInboxNotice(
        report.verdict === "pass" ? "info" : "action",
        `Verifier [${report.verifierProvider}/${report.verifierModel}${report.crossFamily ? " · cross-family" : ""}]: '${task.title}' → ${report.verdict.toUpperCase()}`,
        { projectId: project.id },
      );
    });

    this.core.emitDirectEvent(`project:${project.id}:debates`, "verification.completed", report);
    this.core.emitDirectEvent(`project:${project.id}:board`, "task.updated", updatedTask);
    this.core.emitDirectEvent("global:status", "status.updated", this.getQuietStatusProjection());
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
    const nextRound = debate.roundCount + 1;
    const hitCap = nextRound >= debate.maxRounds;
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
    await this.runAgentTurn(
      pm.id,
      `Escalated Debate (${debate.id}): ${debate.topic}\nReason: ${debate.reason}\nRounds (${debate.roundCount}/${debate.maxRounds}):\n${summaryLines}\n\nProvide a clear tie-breaking recommendation for the operator/team.`,
      { emitTopic: `bot:${pm.id}:timeline`, namespace: `project:${project.slug}` },
    );
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

  private handleSelfModPromote(cmd: Extract<RpcCommand, { type: "selfmod.promote" }>) {
    const existing = this.db.getSelfModProposal(cmd.proposalId);
    if (!existing) throw new Error(`Self-mod proposal not found: ${cmd.proposalId}`);
    const candidate: SelfModProposalRecord = { ...existing };
    // Enforces selfModRequiresStagingAndVerifier + single-read SHA-256 integrity + creates live backup before swap
    this.selfMod.promoteProposal(candidate);

    try {
      return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
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

    return this.core.commitCommand(cmd.commandId, cmd.type, () => ({
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
  }

  // --- Read Projections for Scoped Subscriptions ---

  public getQuietStatusProjection(): QuietStatusProjection {
    const projects = this.db.listProjects().filter((p) => p.status === "active");
    const agents = this.db.listAgents();
    const tasks = this.db.listTasks();
    const annotations = this.db.listAnnotations();
    const debates = this.db.listDebates();
    const selfMods = this.db.listSelfModProposals();

    return {
      activeProjects: projects.length,
      runningBots: agents.filter((a) => a.scope !== "global" && a.status === "working").length,
      waitingReviews: tasks.filter((t) => t.status === "in_review").length,
      openAnnotations: annotations.filter((a) => a.status === "open" || a.status === "in_progress").length,
      activeDebates: debates.filter((d) => d.status === "open" || d.status === "escalated").length,
      stagedSelfMods: selfMods.filter((p) => p.status === "staged" || p.status === "verifying" || p.status === "verified").length,
      inboxNotices: this.db.listInboxNotices(15),
    };
  }

  public getGlobalSnapshot() {
    return {
      status: this.getQuietStatusProjection(),
      projects: this.db.listProjects(),
      agents: this.db.listAgents(),
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

  public getProjectBoardSnapshot(projectId: string) {
    return {
      project: this.db.getProject(projectId),
      agents: this.db.listAgents(projectId),
      tasks: this.db.listTasks(projectId),
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
      verifications: this.db.listVerifications().filter((v) => v.targetKind === "selfmod"),
    };
  }

  public getBotTimelineSnapshot(agentId: string) {
    return {
      agent: this.db.getAgent(agentId),
      timeline: this.db.listAgentTimeline(agentId, 150),
    };
  }
}
