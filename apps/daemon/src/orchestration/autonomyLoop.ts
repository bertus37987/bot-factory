import {
  newId,
  type AgentRecord,
  type AutonomyLevel,
  type HubConfig,
  type ProjectRecord,
  type QuietStatusProjection,
  type ReasoningEffort,
  type SubscriptionTopic,
  type TaskRecord,
  type TeamGoalRecord,
  type TeamGoalStatus,
  type VerificationReportRecord,
} from "@bot-factory/shared";
import type { SecretScrubber } from "../config";
import type { CommandCore } from "../core/commandCore";
import type { StateDatabase } from "../db/database";

export interface GoalContext {
  goalId: string;
  projectId: string;
  goal: string;
  status: TeamGoalStatus;
  autonomyLevel?: AutonomyLevel;
  reasoningEffort?: ReasoningEffort;
  taskIds: string[];
  reported: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AutonomyLoopCallbacks {
  getConfig: () => HubConfig;
  getQuietStatusProjection: () => QuietStatusProjection;
  getProjectBoardSnapshot: (projectId: string) => unknown;
  spawnPeerBot: (params: {
    projectId: string;
    name: string;
    taskId?: string;
    autonomyLevel?: AutonomyLevel;
    reasoningEffort?: ReasoningEffort;
  }) => AgentRecord;
  dispatchTask: (params: {
    projectId: string;
    taskId: string;
    agentId?: string;
    autonomous: boolean;
  }) => void;
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
  onGoalReportFallback: (params: {
    project: ProjectRecord;
    goal: GoalContext;
    status: "milestone" | "completed" | "blocked";
    summary: string;
    verifiedTaskIds: string[];
    blockedReasons: string[];
  }) => Promise<void>;
}

const MAX_SPEC_RETRY_CHARS = 12_000;
const RETRY_SECTION_HEADING = "## Verifier Retry Feedback (Attempt ";

export function appendRetryFeedback(
  specMd: string,
  attempt: number,
  findingsText: string,
  maxChars = MAX_SPEC_RETRY_CHARS,
): string {
  const cleanFindings = findingsText.trim() || "Independent verifier flagged failures; check handoff and worktree diff.";
  const newBlock = `${RETRY_SECTION_HEADING}${attempt})\n${cleanFindings}`;

  const markerInline = `\n\n${RETRY_SECTION_HEADING}`;
  const markerIdx = specMd.startsWith(RETRY_SECTION_HEADING) ? 0 : specMd.indexOf(markerInline);
  const rawBaseSpec = (markerIdx === -1 ? specMd : specMd.slice(0, markerIdx)).trimEnd();
  const prevRetrySection =
    markerIdx === -1
      ? ""
      : specMd.slice(markerIdx === 0 ? 0 : markerIdx + 2).trim();
  const prevBlocks = prevRetrySection
    ? prevRetrySection
        .split(/\n\n(?=## Verifier Retry Feedback \(Attempt )/)
        .map((b) => b.trim())
        .filter(Boolean)
    : [];

  // Always preserve the original specMd head intact; only trim old retry blocks or excess spec tail if over budget.
  const minLatestBudget = Math.min(2000, Math.floor(maxChars * 0.35));
  const maxBaseBudget = Math.max(0, maxChars - minLatestBudget - 2);
  const baseSpec =
    rawBaseSpec.length <= maxBaseBudget
      ? rawBaseSpec
      : `${rawBaseSpec.slice(0, Math.max(0, maxBaseBudget - 18))}\n… [spec truncated]`;

  const remainingAfterBase = Math.max(0, maxChars - (baseSpec ? baseSpec.length + 2 : 0));
  const boundedNewBlock =
    newBlock.length <= remainingAfterBase
      ? newBlock
      : `${newBlock.slice(0, Math.max(0, remainingAfterBase - 14))}\n… [truncated]`;

  const keptPrev: string[] = [];
  let usedChars = (baseSpec ? baseSpec.length + 2 : 0) + boundedNewBlock.length;
  for (let i = prevBlocks.length - 1; i >= 0; i -= 1) {
    const prev = prevBlocks[i]!;
    if (usedChars + prev.length + 2 <= maxChars) {
      keptPrev.unshift(prev);
      usedChars += prev.length + 2;
    } else {
      break;
    }
  }

  return [baseSpec, ...keptPrev, boundedNewBlock].filter(Boolean).join("\n\n");
}

function formatVerifierRetryFeedback(
  report: VerificationReportRecord,
  scrub: (text: string) => string,
): string {
  const failedChecks = report.checks.filter((c) => !c.passed);
  const failedCheckNames = new Set(failedChecks.map((c) => c.name));
  const lines: string[] = [];

  for (const check of failedChecks) {
    lines.push(`- [Check Failed: ${check.name}] ${check.detail}`);
  }
  for (const finding of report.findings) {
    const checkPrefix = /^check_failed:([^:]+):/.exec(finding)?.[1];
    if (checkPrefix && failedCheckNames.has(checkPrefix)) continue;
    lines.push(`- [Finding] ${finding}`);
  }
  const summary = report.summary.trim();
  if (summary) {
    lines.push(`\nVerifier Summary:\n${summary.slice(0, 1200)}`);
  }

  const combined = lines.join("\n").trim();
  return scrub(combined || "Independent verifier flagged failures; check handoff and worktree diff.");
}

export class AutonomyLoop {
  private readonly goals = new Map<string, GoalContext>();
  private readonly activeGoalByProject = new Map<string, string>();
  private readonly autonomousTaskIds = new Set<string>();
  private readonly pendingCheckKeys = new Set<string>();

  constructor(
    private readonly db: StateDatabase,
    private readonly core: CommandCore,
    private readonly scrubber: SecretScrubber,
    private readonly callbacks: AutonomyLoopCallbacks,
  ) {
    this.rehydrateFromDatabase();
  }

  private rehydrateFromDatabase(): void {
    const tasks = this.db.listTasks();
    for (const stored of this.db.listTeamGoals()) {
      const taskIds = tasks.filter((t) => t.goalId === stored.goalId).map((t) => t.id);
      const ctx: GoalContext = {
        goalId: stored.goalId,
        projectId: stored.projectId,
        goal: stored.goal,
        status: stored.status,
        autonomyLevel: stored.autonomyLevel as AutonomyLevel | undefined,
        reasoningEffort: stored.reasoningEffort as ReasoningEffort | undefined,
        taskIds,
        reported: stored.reported,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
      };
      this.goals.set(ctx.goalId, ctx);
      for (const taskId of taskIds) this.autonomousTaskIds.add(taskId);
      if (ctx.status === "active") {
        const existingId = this.activeGoalByProject.get(ctx.projectId);
        const existing = existingId ? this.goals.get(existingId) : null;
        if (!existing || ctx.updatedAt >= existing.updatedAt) {
          this.activeGoalByProject.set(ctx.projectId, ctx.goalId);
        }
      }
    }
  }

  public persistGoalWithinTransaction(goal: GoalContext, taskIdsToLink: string[] = []): void {
    this.db.upsertTeamGoal({
      goalId: goal.goalId,
      projectId: goal.projectId,
      goal: goal.goal,
      status: goal.status,
      autonomyLevel: goal.autonomyLevel ?? null,
      reasoningEffort: goal.reasoningEffort ?? null,
      reported: goal.reported,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    });
    for (const taskId of taskIdsToLink) {
      const task = this.db.getTask(taskId);
      if (task && task.goalId !== goal.goalId) {
        this.db.upsertTask({ ...task, goalId: goal.goalId });
      }
    }
  }

  private persistGoal(goal: GoalContext, taskIdsToLink: string[] = []): void {
    this.db.runAtomicWrite(() => this.persistGoalWithinTransaction(goal, taskIdsToLink));
  }

  public startGoal(params: {
    projectId: string;
    goal: string;
    autonomyLevel?: AutonomyLevel;
    reasoningEffort?: ReasoningEffort;
    deferPersistence?: boolean;
  }): GoalContext {
    const now = Date.now();
    const goalId = newId("goal");
    const ctx: GoalContext = {
      goalId,
      projectId: params.projectId,
      goal: this.scrubber.scrub(params.goal),
      status: "active",
      autonomyLevel: params.autonomyLevel,
      reasoningEffort: params.reasoningEffort,
      taskIds: [],
      reported: false,
      createdAt: now,
      updatedAt: now,
    };
    this.goals.set(goalId, ctx);
    this.activeGoalByProject.set(params.projectId, goalId);
    if (!params.deferPersistence) {
      this.persistGoal(ctx);
    }
    return ctx;
  }

  public getGoal(goalId: string): GoalContext | null {
    return this.goals.get(goalId) ?? null;
  }

  public getActiveGoalForProject(projectId: string): GoalContext | null {
    const goalId = this.activeGoalByProject.get(projectId);
    if (!goalId) return null;
    const goal = this.goals.get(goalId);
    return goal && goal.status === "active" ? goal : null;
  }

  public hasActiveGoal(projectId: string): boolean {
    return this.getActiveGoalForProject(projectId) !== null;
  }

  public listGoals(projectId?: string): TeamGoalRecord[] {
    const out: TeamGoalRecord[] = [];
    for (const g of this.goals.values()) {
      if (projectId && g.projectId !== projectId) continue;
      out.push({
        goalId: g.goalId,
        projectId: g.projectId,
        goal: g.goal,
        status: g.status,
        taskIds: [...g.taskIds],
        updatedAt: g.updatedAt,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public attachTasks(projectId: string, taskIds: string[], goalId?: string, withinTransaction = false): GoalContext | null {
    for (const tid of taskIds) {
      this.autonomousTaskIds.add(tid);
    }
    const goal = (goalId ? this.goals.get(goalId) : null) ?? this.getActiveGoalForProject(projectId);
    if (!goal) return null;
    const existing = new Set(goal.taskIds);
    for (const tid of taskIds) {
      if (!existing.has(tid)) {
        goal.taskIds.push(tid);
        existing.add(tid);
      }
    }
    goal.reported = false;
    goal.status = "active";
    goal.updatedAt = Date.now();
    if (withinTransaction) {
      this.persistGoalWithinTransaction(goal, taskIds);
    } else {
      this.persistGoal(goal, taskIds);
    }
    return goal;
  }

  public markTaskAutonomous(taskId: string, projectId?: string): void {
    this.autonomousTaskIds.add(taskId);
    if (projectId) {
      const existingGoalId = this.db.getTask(taskId)?.goalId;
      const owningGoal = existingGoalId ? this.goals.get(existingGoalId) : null;
      const targetGoal = owningGoal ?? this.getActiveGoalForProject(projectId);
      if (targetGoal && !targetGoal.taskIds.includes(taskId)) {
        targetGoal.taskIds.push(taskId);
        targetGoal.updatedAt = Date.now();
        this.persistGoal(targetGoal, [taskId]);
      }
    }
  }

  public isAutonomousTask(taskId: string): boolean {
    return this.autonomousTaskIds.has(taskId);
  }

  public resumePersistedGoalsForProject(projectId: string): number {
    let dispatched = 0;
    const resumableGoals = [...this.goals.values()]
      .filter((goal) => goal.projectId === projectId && (goal.status === "active" || goal.status === "blocked"))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const goal of resumableGoals) {
      dispatched += this.dispatchUnblockedTasks(projectId, goal.goalId);
    }
    return dispatched;
  }

  public resumePersistedGoals(): number {
    let dispatched = 0;
    const projectIds = new Set(
      [...this.goals.values()].filter((goal) => goal.status === "active" || goal.status === "blocked").map((goal) => goal.projectId),
    );
    for (const projectId of projectIds) {
      try {
        dispatched += this.resumePersistedGoalsForProject(projectId);
      } catch {
        // Restart recovery must never prevent daemon boot.
      }
    }
    return dispatched;
  }

  public markGoalReported(projectId: string, status: "milestone" | "completed" | "blocked", goalId?: string): GoalContext | null {
    const goal = goalId
      ? (this.goals.get(goalId) ?? null)
      : (this.getActiveGoalForProject(projectId) ?? this.findLatestGoalForProject(projectId));
    if (!goal || goal.projectId !== projectId) return null;
    if (status === "completed") {
      goal.status = "completed";
      goal.reported = true;
    } else if (status === "blocked") {
      goal.status = "blocked";
      goal.reported = true;
    }
    goal.updatedAt = Date.now();
    this.persistGoal(goal);
    return goal;
  }

  private findLatestGoalForProject(projectId: string): GoalContext | null {
    const latestId = this.activeGoalByProject.get(projectId);
    if (latestId && this.goals.has(latestId)) {
      return this.goals.get(latestId)!;
    }
    let best: GoalContext | null = null;
    for (const g of this.goals.values()) {
      if (g.projectId === projectId && (!best || g.updatedAt > best.updatedAt)) {
        best = g;
      }
    }
    return best;
  }

  private findGoalForTask(taskId: string): GoalContext | null {
    for (const g of this.goals.values()) {
      if (g.taskIds.includes(taskId)) return g;
    }
    return null;
  }

  public onPeerTaskCompleted(projectId: string, taskId: string): void {
    if (!this.isAutonomousTask(taskId)) return;
    const task = this.db.getTask(taskId);
    if (!task || task.status !== "in_review") return;

    this.core.commitCommand(newId("cmd"), "autonomy.enqueue_verify", () => ({
      result: { taskId, queued: true },
      applyProjections: () => {
        this.db.addInboxNotice("info", `Auto-verifying completed autonomous task '${task.title}'`, {
          projectId,
          agentId: task.assignedAgentId ?? undefined,
        });
      },
      events: [{ topic: "global:status", eventType: "status.updated", payload: this.callbacks.getQuietStatusProjection() }],
      effects: [{ effectType: "task.verify.run", payload: { projectId, taskId, checks: [] } }],
    }));
  }

  public onPeerTaskFailed(projectId: string, taskId: string, errorMsg: string): void {
    if (!this.isAutonomousTask(taskId)) return;
    const task = this.db.getTask(taskId);
    if (!task || task.status === "merged") return;

    const maxRetries = this.callbacks.getConfig().guardrails.maxTaskAutoRetries;
    const nextRetry = (task.autoRetryCount ?? 0) + 1;
    if (nextRetry <= maxRetries) {
      this.requeueTaskForRetry(projectId, task, nextRetry, errorMsg);
      return;
    }

    this.releaseAuthorAgentIfIdleable(projectId, taskId, task.assignedAgentId, `Blocked after ${maxRetries} retries`);
    const goal = this.findGoalForTask(taskId) ?? this.getActiveGoalForProject(projectId);
    if (goal) {
      goal.status = "blocked";
      goal.updatedAt = Date.now();
      this.persistGoal(goal);
      this.resumePersistedGoalsForProject(projectId);
      this.enqueuePmGoalCheck(projectId, goal.goalId, "task_blocked", task.id, [errorMsg]);
    }
  }

  public onVerificationCompleted(projectId: string, taskId: string, report: VerificationReportRecord): void {
    if (!this.isAutonomousTask(taskId)) return;

    const task = this.db.getTask(taskId);
    const goal = this.findGoalForTask(taskId) ?? this.getActiveGoalForProject(projectId);

    if (report.verdict === "pass") {
      this.releaseAuthorAgentIfIdleable(projectId, taskId, task?.assignedAgentId ?? null, `Verified: ${task?.title.slice(0, 60) ?? taskId}`);
      if (goal) {
        this.resumePersistedGoalsForProject(projectId);
        this.checkGoalCompletion(projectId, goal);
      }
      return;
    }

    if (report.verdict === "fail" && task && task.status !== "merged") {
      const maxRetries = this.callbacks.getConfig().guardrails.maxTaskAutoRetries;
      const nextRetry = (task.autoRetryCount ?? 0) + 1;
      const findingsText = formatVerifierRetryFeedback(report, (t) => this.scrubber.scrub(t));

      if (nextRetry <= maxRetries) {
        this.requeueTaskForRetry(projectId, task, nextRetry, findingsText);
        return;
      }

      this.releaseAuthorAgentIfIdleable(projectId, taskId, task.assignedAgentId, `Blocked after ${maxRetries} retries`);
      if (goal) {
        goal.status = "blocked";
        goal.updatedAt = Date.now();
        this.persistGoal(goal);
        this.resumePersistedGoalsForProject(projectId);
        this.enqueuePmGoalCheck(projectId, goal.goalId, "task_blocked", task.id, report.findings);
      }
      return;
    }

    if (report.verdict === "needs_human" && goal) {
      this.releaseAuthorAgentIfIdleable(projectId, taskId, task?.assignedAgentId ?? null, `Needs review: ${task?.title.slice(0, 50) ?? taskId}`);
      this.resumePersistedGoalsForProject(projectId);
      this.enqueuePmGoalCheck(projectId, goal.goalId, "needs_human", taskId, report.findings);
    }
  }

  private releaseAuthorAgentIfIdleable(
    projectId: string,
    finishedTaskId: string,
    authorAgentId: string | null,
    summary: string,
  ): void {
    if (!authorAgentId) return;
    const author = this.db.getAgent(authorAgentId);
    if (!author || author.scope !== "peer") return;
    if (author.status !== "waiting_review" && author.status !== "error") return;

    const hasOtherActiveTask = this.db
      .listTasks(projectId)
      .some((t) => t.id !== finishedTaskId && t.assignedAgentId === author.id && (t.status === "claimed" || t.status === "in_review"));
    if (hasOtherActiveTask) return;

    this.db.runAtomicWrite(() => {
      const fresh = this.db.getAgent(author.id);
      if (fresh && (fresh.status === "waiting_review" || fresh.status === "error")) {
        this.db.updateAgentStatus(fresh.id, "idle", { lastSummary: this.scrubber.scrub(summary) });
      }
    });
    this.core.emitDirectEvent(`bot:${author.id}:timeline`, "agent.status", { agentId: author.id, status: "idle" });
    this.core.emitDirectEvent("global:status", "status.updated", this.callbacks.getQuietStatusProjection());
  }

  private requeueTaskForRetry(projectId: string, task: TaskRecord, nextRetry: number, findingsText: string): void {
    const cleanFeedback = this.scrubber.scrub(findingsText);
    const updatedTask: TaskRecord = {
      ...task,
      status: "ready",
      autoRetryCount: nextRetry,
      specMd: appendRetryFeedback(task.specMd, nextRetry, cleanFeedback),
      updatedAt: Date.now(),
    };

    const existingAuthor = task.assignedAgentId ? this.db.getAgent(task.assignedAgentId) : null;
    const canReuseAuthor =
      existingAuthor &&
      existingAuthor.projectId === projectId &&
      existingAuthor.scope === "peer" &&
      existingAuthor.status !== "stopped" &&
      existingAuthor.status !== "paused";

    this.db.runAtomicWrite(() => {
      this.db.upsertTask(updatedTask);
      if (canReuseAuthor && existingAuthor && (existingAuthor.status === "waiting_review" || existingAuthor.status === "error")) {
        this.db.updateAgentStatus(existingAuthor.id, "idle", {
          lastSummary: `Retrying '${task.title.slice(0, 50)}' (${nextRetry})`,
        });
      }
      this.db.addInboxNotice("info", `Auto-retrying '${task.title}' (attempt ${nextRetry}) after verifier feedback`, {
        projectId,
        agentId: existingAuthor?.id,
      });
    });

    this.core.emitDirectEvent(`project:${projectId}:board`, "task.updated", updatedTask);
    this.core.emitDirectEvent("global:status", "status.updated", this.callbacks.getQuietStatusProjection());

    const dispatchAgentId = canReuseAuthor && existingAuthor && this.db.getAgent(existingAuthor.id)?.status === "idle"
      ? existingAuthor.id
      : undefined;
    try {
      this.callbacks.dispatchTask({
        projectId,
        taskId: task.id,
        agentId: dispatchAgentId,
        autonomous: true,
      });
    } catch {
      // If all peers are busy or at concurrency cap, dispatchUnblockedTasks will pick it up later
    }
  }

  public dispatchUnblockedTasks(projectId: string, goalId?: string): number {
    const goal =
      (goalId ? this.goals.get(goalId) : null) ??
      this.getActiveGoalForProject(projectId) ??
      this.findLatestGoalForProject(projectId);
    if (!goal || goal.status === "completed") return 0;

    const allTasks = this.db.listTasks(projectId);
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    const readyCandidates = goal.taskIds
      .map((id) => taskMap.get(id))
      .filter((t): t is TaskRecord => Boolean(t && t.status === "ready"))
      .filter((t) =>
        (t.dependsOn ?? []).every((depId) => {
          const dep = taskMap.get(depId);
          return dep ? dep.status === "verified" || dep.status === "merged" : false;
        }),
      )
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);

    if (readyCandidates.length === 0) return 0;

    const maxConcurrent = this.callbacks.getConfig().guardrails.maxConcurrentBotsPerProject;
    let dispatched = 0;

    for (const candidate of readyCandidates) {
      const chosenAgent = this.pickOrSpawnPeerForDispatch(projectId, candidate, maxConcurrent);
      if (!chosenAgent) break;
      try {
        this.callbacks.dispatchTask({
          projectId,
          taskId: candidate.id,
          agentId: chosenAgent.id,
          autonomous: true,
        });
        dispatched += 1;
      } catch {
        break;
      }
    }
    return dispatched;
  }

  private pickOrSpawnPeerForDispatch(
    projectId: string,
    task: TaskRecord,
    maxConcurrent: number,
  ): AgentRecord | null {
    const allAgents = this.db.listAgents(projectId);
    const crashBlockedAgentIds = new Set(this.db.listUnknownAdmissions().map((a) => a.agentId));
    const activePeers = allAgents.filter((a) => a.scope === "peer" && a.status !== "stopped");
    const selectablePeers = activePeers.filter((a) => !crashBlockedAgentIds.has(a.id));
    const idlePeers = selectablePeers.filter((a) => a.status === "idle");

    const allTasks = this.db.listTasks(projectId);
    const hasUnmergedWork = (agentId: string): boolean =>
      allTasks.some(
        (t) =>
          t.assignedAgentId === agentId &&
          (t.status === "claimed" || t.status === "in_review" || t.status === "verified"),
      );

    if (task.assignedAgentId) {
      const preferred = idlePeers.find((a) => a.id === task.assignedAgentId && !hasUnmergedWork(a.id));
      if (preferred) return preferred;
    }

    const cleanIdle = idlePeers.find((a) => !hasUnmergedWork(a.id));
    if (cleanIdle) return cleanIdle;

    if (activePeers.length < maxConcurrent) {
      return this.callbacks.spawnPeerBot({
        projectId,
        name: `Auto-Peer-${activePeers.length + 1}`,
        taskId: task.id,
        autonomyLevel: "high",
      });
    }

    return null;
  }

  private checkGoalCompletion(projectId: string, goal: GoalContext): void {
    if (goal.taskIds.length === 0) return;
    const allTasks = this.db.listTasks(projectId);
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    const goalTasks = goal.taskIds.map((id) => taskMap.get(id)).filter((t): t is TaskRecord => Boolean(t));
    if (goalTasks.length !== goal.taskIds.length) return;

    const allDone = goalTasks.every((t) => t.status === "verified" || t.status === "merged");
    if (!allDone) return;

    goal.status = "completed";
    goal.updatedAt = Date.now();
    this.persistGoal(goal);
    if (!goal.reported) {
      this.enqueuePmGoalCheck(projectId, goal.goalId, "all_verified");
    }
  }

  private enqueuePmGoalCheck(
    projectId: string,
    goalId: string,
    outcome: "all_verified" | "task_blocked" | "needs_human",
    taskId?: string,
    findings?: string[],
  ): void {
    const key = `${goalId}:${outcome}:${taskId ?? ""}`;
    if (this.pendingCheckKeys.has(key)) return;
    const pm = this.db.listAgents(projectId).find((a) => a.scope === "project" && a.status !== "stopped");
    if (!pm) return;

    this.pendingCheckKeys.add(key);
    this.core.commitCommand(newId("cmd"), "autonomy.pm_goal_check", () => ({
      result: { goalId, outcome, queued: true },
      applyProjections: () => {},
      events: [],
      effects: [
        {
          effectType: "pm.goal.check",
          payload: {
            projectId,
            pmAgentId: pm.id,
            goalId,
            outcome,
            ...(taskId ? { taskId } : {}),
            ...(findings && findings.length > 0 ? { findings } : {}),
            checkKey: key,
          },
        },
      ],
    }));
  }

  public async executePmGoalCheck(payload: {
    projectId: string;
    pmAgentId: string;
    goalId: string;
    outcome: "all_verified" | "task_blocked" | "needs_human";
    taskId?: string;
    findings?: string[];
    checkKey?: string;
  }): Promise<void> {
    if (payload.checkKey) {
      this.pendingCheckKeys.delete(payload.checkKey);
    }
    const project = this.db.getProject(payload.projectId);
    const goal = this.goals.get(payload.goalId);
    if (!project || !goal || goal.reported) return;

    const tasks = goal.taskIds.map((id) => this.db.getTask(id)).filter((t): t is TaskRecord => Boolean(t));
    const verifiedIds = tasks.filter((t) => t.status === "verified" || t.status === "merged").map((t) => t.id);
    const blockedTasks = tasks.filter((t) => t.status === "blocked");

    const statusLines = tasks.map((t) => `- [${t.status}] ${t.title} (${t.id})`).join("\n");
    const findingsBlock =
      payload.findings && payload.findings.length > 0
        ? `\nFindings:\n${payload.findings.map((f) => `- ${this.scrubber.scrub(f)}`).join("\n")}`
        : "";

    const prompt = [
      `Autonomous Goal Check (${goal.goalId}) — outcome: ${payload.outcome}`,
      `Goal: ${goal.goal}`,
      `Tasks:\n${statusLines || "(none)"}`,
      findingsBlock,
      payload.outcome === "all_verified"
        ? `All tasks passed independent verification! Call \`bf_report_to_manager\` with goalId='${goal.goalId}', status='completed', verifiedTaskIds, and a concise verified summary.`
        : `A task is blocked or needs review. Inspect/resolve if possible, or call \`bf_report_to_manager\` with goalId='${goal.goalId}', status='blocked', and blockedReasons.`,
    ]
      .filter(Boolean)
      .join("\n\n");

    await this.callbacks.runAgentTurn(payload.pmAgentId, prompt, {
      emitTopic: `bot:${payload.pmAgentId}:timeline`,
      namespace: `project:${project.slug}`,
      autonomyLevel: goal.autonomyLevel,
      reasoningEffort: goal.reasoningEffort,
    });

    // Deterministic safety net: if PM did not call bf_report_to_manager during its turn (e.g. offline mock),
    // report cleanly so Main Manager still wakes and posts a verified/blocked Review card.
    if (!goal.reported && (payload.outcome === "all_verified" || payload.outcome === "task_blocked")) {
      const reportStatus = payload.outcome === "all_verified" && blockedTasks.length === 0 ? "completed" : "blocked";
      const blockedReasons =
        reportStatus === "blocked"
          ? blockedTasks.map((t) => `${t.title} (${t.id}) blocked${payload.findings?.length ? `: ${payload.findings[0]}` : ""}`)
          : [];
      const summary =
        reportStatus === "completed"
          ? `All ${verifiedIds.length} autonomous task(s) for goal "${goal.goal}" passed independent verification.`
          : `Goal "${goal.goal}" blocked on ${blockedTasks.length} task(s): ${blockedReasons.join("; ")}`;

      await this.callbacks.onGoalReportFallback({
        project,
        goal,
        status: reportStatus,
        summary: this.scrubber.scrub(summary),
        verifiedTaskIds: verifiedIds,
        blockedReasons,
      });
    }
  }
}
