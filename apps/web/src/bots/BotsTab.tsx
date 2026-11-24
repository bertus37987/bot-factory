import type {
  AgentRecord,
  ArtifactEntry,
  CheckpointRecord,
  DebateMessageRecord,
  DebateRecord,
  GitDiffResponse,
  ProjectRecord,
  SelfModKind,
  SelfModProposalRecord,
  TaskRecord,
  TeamGoalRecord,
  TimelineItem,
  VerificationReportRecord,
} from "@bot-factory/shared";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  GitMerge,
  Kanban,
  OctagonX,
  Pause,
  Play,
  Plus,
  RotateCw,
  ShieldCheck,
  Target,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import type { ProviderSummary, RpcCommandInput } from "../client/useBotFactory";
import { BotAvatar, JobTitlePill, resolveBotRole } from "../components/BotAvatars";
import {
  PrecisionComposer,
  type AutonomyLevel,
  type ModelTargetSelection,
} from "../components/PrecisionComposer";
import type { ReasoningEffort } from "../components/ReasoningEffortSlider";
import { DebatesVerifierPanel, SelfModPanel } from "../phase3/Phase3Panels";
import { CheckpointsMergePanel } from "../studio/CheckpointsMergePanel";
import { BotChatStream } from "./BotChatStream";

export type BotsSubView = "chat_group" | "chat_single" | "board" | "checkpoints" | "debates" | "selfmod";

export interface BotsTabProps {
  isVisible: boolean;
  projects: ProjectRecord[];
  activeProject: ProjectRecord | null;
  agents: AgentRecord[];
  providers: ProviderSummary[];
  tasks: TaskRecord[];
  goals: TeamGoalRecord[];
  timelinesByAgent: Record<string, TimelineItem[]>;
  streamingBotTextByAgent: Record<string, string>;
  streamingBotThoughtByAgent: Record<string, string>;
  artifacts: ArtifactEntry[];
  debates: DebateRecord[];
  debateMessagesByDebate: Record<string, DebateMessageRecord[]>;
  verifications: VerificationReportRecord[];
  checkpoints: CheckpointRecord[];
  gitDiff: GitDiffResponse | null;
  activeSubView: "chat_group" | "chat_single" | "board" | "checkpoints" | "debates" | "selfmod";
  activeAgentId: string | null;
  selfModProposals: SelfModProposalRecord[];
  onSelectSubView: (view: BotsTabProps["activeSubView"], agentId?: string | null) => void;
  onSelectProject: (projectId: string) => void;
  onOpenProjectModal: () => void;
  onOpenBotSpawnModal: () => void;
  onOpenBrowserItem: (
    projectId: string,
    kind: "doc" | "image" | "model_3d" | "code" | "diff",
    target: string,
    label?: string,
  ) => void;
  onSendCommand: <T = unknown>(cmd: RpcCommandInput) => Promise<T>;
  onFetchCheckpoints: (projectId: string, agentId?: string) => Promise<CheckpointRecord[]>;
  onNotifyError: (msg: string) => void;
}

const BOARD_COLUMNS: Array<{
  id: string;
  label: string;
  matches: (status: TaskRecord["status"]) => boolean;
}> = [
  { id: "ready", label: "Backlog / Ready", matches: (s) => s === "backlog" || s === "ready" },
  { id: "claimed", label: "In Progress", matches: (s) => s === "claimed" },
  { id: "review", label: "In Review / Blocked", matches: (s) => s === "in_review" || s === "blocked" },
  { id: "verified", label: "Verified", matches: (s) => s === "verified" },
  { id: "merged", label: "Merged", matches: (s) => s === "merged" },
];

export function BotsTab(props: BotsTabProps): JSX.Element {
  const {
    isVisible,
    projects,
    activeProject,
    agents,
    providers,
    tasks,
    goals,
    timelinesByAgent,
    streamingBotTextByAgent,
    streamingBotThoughtByAgent,
    artifacts,
    debates,
    debateMessagesByDebate,
    verifications,
    checkpoints,
    gitDiff,
    activeSubView,
    activeAgentId,
    selfModProposals,
    onSelectSubView,
    onSelectProject,
    onOpenProjectModal,
    onOpenBotSpawnModal,
    onOpenBrowserItem,
    onSendCommand,
    onFetchCheckpoints,
    onNotifyError,
  } = props;

  const [effort, setEffort] = useState<ReasoningEffort>("high");
  const [autonomy, setAutonomy] = useState<AutonomyLevel>("medium");
  const [selectedTarget, setSelectedTarget] = useState<ModelTargetSelection | null>(null);
  const [mentionPrefix, setMentionPrefix] = useState<string | null>(null);
  const [controlTargetId, setControlTargetId] = useState<string | null>(null);

  // Task creation form state
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskSpec, setNewTaskSpec] = useState("");
  const [newTaskPriority, setNewTaskPriority] = useState<number>(3);
  const [newTaskDeps, setNewTaskDeps] = useState<string[]>([]);
  const [showTaskDetails, setShowTaskDetails] = useState(false);
  const [dispatchAgentByTask, setDispatchAgentByTask] = useState<Record<string, string>>({});

  const [uiError, setUiError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);

  const projectAgents = useMemo(
    () => (activeProject ? agents.filter((a) => a.projectId === activeProject.id) : []),
    [agents, activeProject],
  );

  const teamLead = useMemo(
    () => projectAgents.find((a) => a.scope === "project") ?? null,
    [projectAgents],
  );

  const activeAgent = useMemo(
    () =>
      (activeAgentId ? projectAgents.find((a) => a.id === activeAgentId) : null) ??
      teamLead ??
      projectAgents[0] ??
      null,
    [projectAgents, activeAgentId, teamLead],
  );

  const peerDispatchCandidates = useMemo(
    () =>
      projectAgents.filter(
        (a) =>
          (a.scope === "peer" || a.scope === "sidekick") &&
          a.status !== "stopped" &&
          a.status !== "paused" &&
          a.status !== "error" &&
          a.status !== "working",
      ),
    [projectAgents],
  );

  const controlTargetAgent = useMemo(() => {
    if (activeSubView === "chat_single") return activeAgent;
    if (controlTargetId) {
      const found = projectAgents.find((a) => a.id === controlTargetId);
      if (found) return found;
    }
    return (
      projectAgents.find((a) => a.status === "working" || a.status === "debating" || a.status === "requires_action") ??
      teamLead ??
      projectAgents[0] ??
      null
    );
  }, [activeSubView, activeAgent, controlTargetId, projectAgents, teamLead]);

  useEffect(() => {
    setNewTaskTitle("");
    setNewTaskSpec("");
    setNewTaskPriority(3);
    setNewTaskDeps([]);
    setShowTaskDetails(false);
    setSelectedTarget(null);
    setMentionPrefix(null);
    setUiError(null);
    setControlTargetId(null);
  }, [activeProject?.id]);

  // Gate checkpoints fetch strictly on visibility and active project
  useEffect(() => {
    if (!isVisible || !activeProject) return;
    if (activeSubView !== "checkpoints") return;
    void onFetchCheckpoints(activeProject.id).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      setUiError(msg);
      onNotifyError(msg);
    });
  }, [isVisible, activeProject?.id, activeSubView, onFetchCheckpoints, onNotifyError]);

  const runSafe = async (fn: () => Promise<void>) => {
    if (busyAction) return;
    setBusyAction(true);
    setUiError(null);
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setUiError(msg);
      onNotifyError(msg);
    } finally {
      setBusyAction(false);
    }
  };

  const mergedTimeline = useMemo(() => {
    if (activeSubView === "chat_group") {
      const all: TimelineItem[] = [];
      for (const a of projectAgents) {
        const items = timelinesByAgent[a.id] ?? [];
        all.push(...items);
      }
      return all.sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
    }
    return activeAgent ? timelinesByAgent[activeAgent.id] ?? [] : [];
  }, [activeSubView, activeAgent, projectAgents, timelinesByAgent]);

  const activeGoal = useMemo(
    () => goals.find((g) => g.status === "active") ?? goals[0] ?? null,
    [goals],
  );

  const taskById = useMemo(() => {
    const map = new Map<string, TaskRecord>();
    for (const t of tasks) map.set(t.id, t);
    return map;
  }, [tasks]);

  const agentById = useMemo(() => {
    const map = new Map<string, AgentRecord>();
    for (const a of projectAgents) map.set(a.id, a);
    return map;
  }, [projectAgents]);

  const verifiedCount = useMemo(() => tasks.filter((t) => t.status === "verified").length, [tasks]);

  const activeModelLabel = useMemo(() => {
    if (selectedTarget) return `${selectedTarget.provider}/${selectedTarget.model}`;
    const refAgent = activeSubView === "chat_single" ? activeAgent : teamLead ?? activeAgent;
    if (refAgent) return `${refAgent.provider}/${refAgent.model}`;
    const override = activeProject?.routingOverrides?.project_manager;
    if (override) return `${override.provider}/${override.model}`;
    return "mistral-hosted/mistral-large-4";
  }, [selectedTarget, activeSubView, activeAgent, teamLead, activeProject]);

  const handleSelectComposerTarget = async (target: ModelTargetSelection) => {
    setSelectedTarget(target);
    if (!activeProject) return;
    await runSafe(async () => {
      await onSendCommand({
        type: "routing.set_override",
        projectId: activeProject.id,
        intent: "project_manager",
        target,
      });
    });
  };

  const handleBotControl = async (agent: AgentRecord, action: "bot.pause" | "bot.resume" | "bot.stop") => {
    await runSafe(async () => {
      await onSendCommand({ type: action, agentId: agent.id });
    });
  };

  const handleCreateTask = async () => {
    if (!activeProject) return;
    const title = newTaskTitle.trim();
    if (!title) return;
    const specMd = newTaskSpec.trim() || title;
    await runSafe(async () => {
      await onSendCommand({
        type: "task.create",
        projectId: activeProject.id,
        title,
        specMd,
        priority: newTaskPriority,
        ...(newTaskDeps.length > 0 ? { dependsOn: newTaskDeps } : {}),
      });
      setNewTaskTitle("");
      setNewTaskSpec("");
      setNewTaskPriority(3);
      setNewTaskDeps([]);
      setShowTaskDetails(false);
    });
  };

  const handleSlash = (command: string) => {
    if (!activeProject) return;
    if (command === "/diff") {
      onOpenBrowserItem(activeProject.id, "diff", "diff://HEAD", "Git Diff");
    } else if (command === "/preview" || command === "/plan") {
      const doc = artifacts.find((a) => a.kind === "doc") ?? artifacts[0];
      if (doc) {
        const kind = doc.kind === "image" ? "image" : doc.kind === "model_3d" ? "model_3d" : "doc";
        onOpenBrowserItem(activeProject.id, kind, doc.relativePath, doc.name);
      } else {
        onOpenBrowserItem(activeProject.id, "diff", "diff://HEAD", "Git Diff");
      }
    } else if (command === "/spawn-bot") {
      onOpenBotSpawnModal();
    } else if (command === "/verify") {
      const target = tasks.find((t) => t.status === "in_review" || t.status === "blocked");
      if (target) {
        void runSafe(() =>
          onSendCommand({ type: "task.verify", projectId: activeProject.id, taskId: target.id }),
        );
      } else {
        onSelectSubView("debates");
      }
    }
  };

  const openDiff = () => {
    if (!activeProject) return;
    onOpenBrowserItem(activeProject.id, "diff", "diff://HEAD", "Git Diff");
  };

  const openFirstArtifactOrDiff = () => {
    if (!activeProject) return;
    const doc = artifacts.find((a) => a.kind === "doc") ?? artifacts[0];
    if (doc) {
      const kind = doc.kind === "image" ? "image" : doc.kind === "model_3d" ? "model_3d" : "doc";
      onOpenBrowserItem(activeProject.id, kind, doc.relativePath, doc.name);
      return;
    }
    openDiff();
  };

  const toggleDependency = (taskId: string) => {
    setNewTaskDeps((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId],
    );
  };

  return (
    <div className="bots-center-shell" data-density="compact">
      {/* Goal Status Strip + Explicit Target Bot Safety Controls in Chat Views */}
      {activeProject && (activeSubView === "chat_group" || activeSubView === "chat_single") && (
        <>
          {activeGoal && (
            <div className="goal-banner">
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <Target size={13} strokeWidth={1.6} color="var(--accent-orange)" style={{ flexShrink: 0 }} />
                <span
                  className={`pill ${
                    activeGoal.status === "completed"
                      ? "success"
                      : activeGoal.status === "blocked"
                        ? "danger"
                        : "active"
                  }`}
                >
                  Goal · {activeGoal.status}
                </span>
                <span
                  style={{
                    color: "var(--ink-primary)",
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={activeGoal.goal}
                >
                  {activeGoal.goal}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <span className="mono-tag">
                  {tasks.filter((t) => t.status === "verified" || t.status === "merged").length}/{tasks.length} done
                </span>
                <button
                  type="button"
                  className="btn xs"
                  onClick={() => onSelectSubView("board")}
                >
                  <Kanban size={11} strokeWidth={1.6} />
                  <span>Board</span>
                </button>
                {verifiedCount > 0 && (
                  <button
                    type="button"
                    className="btn xs primary"
                    onClick={() => onSelectSubView("checkpoints")}
                  >
                    <GitMerge size={11} strokeWidth={1.6} />
                    <span>Merge ({verifiedCount})</span>
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="group-target-strip">
            {activeSubView === "chat_single" && (
              <button
                type="button"
                className="btn xs"
                onClick={() => onSelectSubView("chat_group")}
                title="Back to multi-bot Group Chat"
              >
                <ArrowLeft size={11} strokeWidth={1.6} />
                <span>Group Chat</span>
              </button>
            )}

            {activeSubView === "chat_group" &&
              projectAgents.map((bot) => {
                const meta = resolveBotRole(bot);
                const selected = controlTargetAgent?.id === bot.id;
                return (
                  <button
                    key={bot.id}
                    type="button"
                    className="group-target-chip"
                    onClick={() => setControlTargetId(bot.id)}
                    style={{
                      cursor: "pointer",
                      borderColor: selected ? "var(--accent-orange)" : undefined,
                      background: selected ? "var(--accent-orange-soft)" : undefined,
                      color: selected ? "var(--ink-primary)" : undefined,
                      fontWeight: selected ? 600 : undefined,
                    }}
                    title={`Select ${bot.name} (${bot.scope} · ${bot.status}) for Pause/Resume/Stop`}
                  >
                    <BotAvatar role={meta.role} size={18} active={bot.status === "working" || bot.status === "debating"} />
                    <span>{bot.name}</span>
                    <span className="mono-tag" style={{ fontSize: "9.5px" }}>
                      {bot.status}
                    </span>
                  </button>
                );
              })}

            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
              {controlTargetAgent && (
                <>
                  <span className="mono-tag" title={`Confirmed control target: ${controlTargetAgent.name}`}>
                    Target: {controlTargetAgent.name} ({controlTargetAgent.status})
                  </span>
                  {(controlTargetAgent.status === "paused" ||
                    controlTargetAgent.status === "stopped" ||
                    controlTargetAgent.status === "error") && (
                    <button
                      type="button"
                      className="btn xs"
                      disabled={busyAction}
                      onClick={() => void handleBotControl(controlTargetAgent, "bot.resume")}
                      title={`Resume ${controlTargetAgent.name}`}
                    >
                      <RotateCw size={11} strokeWidth={1.6} />
                      <span>Resume</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn xs"
                    disabled={
                      busyAction ||
                      controlTargetAgent.status === "paused" ||
                      controlTargetAgent.status === "stopped"
                    }
                    onClick={() => void handleBotControl(controlTargetAgent, "bot.pause")}
                    title={`Pause ${controlTargetAgent.name}`}
                  >
                    <Pause size={11} strokeWidth={1.6} />
                    <span>Pause</span>
                  </button>
                  <button
                    type="button"
                    className="btn xs danger"
                    disabled={busyAction || controlTargetAgent.status === "stopped"}
                    onClick={() => void handleBotControl(controlTargetAgent, "bot.stop")}
                    title={`Hard-stop ${controlTargetAgent.name}`}
                  >
                    <OctagonX size={11} strokeWidth={1.6} />
                    <span>Stop</span>
                  </button>
                </>
              )}
              <button
                type="button"
                className="btn xs"
                disabled={busyAction}
                onClick={onOpenBotSpawnModal}
                title="Spawn a new project bot"
              >
                <Plus size={11} strokeWidth={1.6} />
                <span>Bot</span>
              </button>
            </div>
          </div>
        </>
      )}

      <div className="bots-center-scroll">
        {uiError && (
          <div style={{ padding: "10px 18px 0" }}>
            <div className="inline-error">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <AlertCircle size={13} strokeWidth={1.6} />
                <span>{uiError}</span>
              </span>
              <button type="button" className="btn xs ghost" onClick={() => setUiError(null)}>
                Dismiss
              </button>
            </div>
          </div>
        )}

        {!activeProject && activeSubView !== "selfmod" && (
          <div className="bots-empty-state">
            <div className="bots-empty-title">No Project Team Active</div>
            <p className="bots-empty-sub">
              Create a project workspace or attach a local Git repository — Bot-Factory provisions a Team Lead,
              isolated bot worktrees, and annotatable preview artifacts.
            </p>
            <button type="button" className="btn primary" disabled={busyAction} onClick={onOpenProjectModal}>
              <Plus size={14} strokeWidth={1.6} />
              <span>Create Project Workspace</span>
            </button>
          </div>
        )}

        {activeProject && (activeSubView === "chat_single" || activeSubView === "chat_group") && (
          <BotChatStream
            mode={activeSubView === "chat_group" ? "group" : "single"}
            project={activeProject}
            activeAgent={activeAgent}
            agents={projectAgents}
            timeline={mergedTimeline}
            streamingBotTextByAgent={streamingBotTextByAgent}
            streamingBotThoughtByAgent={streamingBotThoughtByAgent}
            tasks={tasks}
            debates={debates}
            debateMessages={debateMessagesByDebate}
            verifications={verifications}
            artifacts={artifacts}
            onOpenArtifactInBrowser={(art) => {
              const kind = art.kind === "image" ? "image" : art.kind === "model_3d" ? "model_3d" : "doc";
              onOpenBrowserItem(activeProject.id, kind, art.relativePath, art.name);
            }}
            onOpenDiffInBrowser={() => openDiff()}
            onVerifyTask={(taskId) =>
              runSafe(() => onSendCommand({ type: "task.verify", projectId: activeProject.id, taskId }))
            }
            onDispatchTask={(taskId) =>
              runSafe(() => onSendCommand({ type: "task.dispatch", projectId: activeProject.id, taskId }))
            }
            onMergeTask={(taskId) =>
              runSafe(() =>
                onSendCommand({
                  type: "task.merge",
                  projectId: activeProject.id,
                  taskId,
                  strategy: "squash",
                }),
              )
            }
            onSelectBot={(agentId) => onSelectSubView("chat_single", agentId)}
            onInsertMention={(botName) => setMentionPrefix(botName)}
            onOpenGroupRoom={() => onSelectSubView("chat_group")}
          />
        )}

        {activeProject && activeSubView === "board" && (
          <div className="bots-workbench-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Rich Task Creation Bar (title, specMd, priority, dependsOn) */}
            <div className="task-card" style={{ gap: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  className="field-input"
                  style={{ flex: 1, minWidth: 220 }}
                  placeholder="Create task on project board…"
                  value={newTaskTitle}
                  disabled={busyAction}
                  onChange={(e) => setNewTaskTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newTaskTitle.trim() && !showTaskDetails) {
                      void handleCreateTask();
                    }
                  }}
                />
                <select
                  className="field-input"
                  style={{ width: 128 }}
                  value={newTaskPriority}
                  disabled={busyAction}
                  onChange={(e) => setNewTaskPriority(Number(e.target.value))}
                  title="Task priority (1 = highest)"
                >
                  <option value={1}>P1 Critical</option>
                  <option value={2}>P2 High</option>
                  <option value={3}>P3 Normal</option>
                  <option value={4}>P4 Low</option>
                  <option value={5}>P5 Backlog</option>
                </select>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setShowTaskDetails((v) => !v)}
                >
                  <span>{showTaskDetails ? "Hide Spec & DAG" : "Spec & DAG"}</span>
                  {newTaskDeps.length > 0 && <span className="mono-tag">{newTaskDeps.length}</span>}
                </button>
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={busyAction || !newTaskTitle.trim()}
                  onClick={() => void handleCreateTask()}
                >
                  <Plus size={13} strokeWidth={1.6} />
                  <span>Create Task</span>
                </button>
              </div>

              {showTaskDetails && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}>
                  <textarea
                    className="field-textarea"
                    rows={3}
                    placeholder="Detailed specification / acceptance criteria (specMd)…"
                    value={newTaskSpec}
                    disabled={busyAction}
                    onChange={(e) => setNewTaskSpec(e.target.value)}
                  />
                  {tasks.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-secondary)", fontWeight: 500 }}>
                        Prerequisites (`dependsOn` DAG edges — selected: {newTaskDeps.length})
                      </span>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {tasks.map((candidate) => {
                          const selected = newTaskDeps.includes(candidate.id);
                          return (
                            <button
                              key={candidate.id}
                              type="button"
                              className={`btn xs ${selected ? "primary" : ""}`}
                              style={{ borderRadius: "var(--radius-pill)" }}
                              onClick={() => toggleDependency(candidate.id)}
                            >
                              {selected && <Check size={10} strokeWidth={2} />}
                              <span>{candidate.title}</span>
                              <span style={{ opacity: 0.72, fontSize: "10px" }}>[{candidate.status}]</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 5-Column Kanban Board */}
            <div className="kanban-grid">
              {BOARD_COLUMNS.map((col) => {
                const colTasks = tasks.filter((t) => col.matches(t.status));
                return (
                  <div key={col.id} className="kanban-col">
                    <div className="section-eyebrow">
                      <span>{col.label}</span>
                      <span className="mono-tag">{colTasks.length}</span>
                    </div>

                    {colTasks.length === 0 && (
                      <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-muted)", padding: "6px 4px" }}>
                        Empty
                      </div>
                    )}

                    {colTasks.map((t) => {
                      const assignee = t.assignedAgentId ? agentById.get(t.assignedAgentId) ?? null : null;
                      const assigneeMeta = assignee ? resolveBotRole(assignee) : null;
                      const deps = (t.dependsOn ?? []).map((id) => ({ id, task: taskById.get(id) ?? null }));
                      const unmetDeps = deps.filter(
                        (d) => !d.task || (d.task.status !== "verified" && d.task.status !== "merged"),
                      );
                      const chosenDispatchBot = dispatchAgentByTask[t.id] ?? "";

                      return (
                        <div key={t.id} className="task-card">
                          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 6 }}>
                            <div style={{ fontWeight: 600, fontSize: "var(--text-sm)", color: "var(--ink-primary)" }}>
                              {t.title}
                            </div>
                            <span className="mono-tag">P{t.priority}</span>
                          </div>

                          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                            <span
                              className={`pill ${
                                t.status === "verified" || t.status === "merged"
                                  ? "success"
                                  : t.status === "blocked"
                                    ? "danger"
                                    : t.status === "in_review"
                                      ? "active"
                                      : ""
                              }`}
                            >
                              {t.status === "verified" && <Check size={10} strokeWidth={1.8} />}
                              {t.status}
                            </span>

                            {assignee && assigneeMeta && (
                              <span
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 4,
                                  fontSize: "var(--text-2xs)",
                                  color: "var(--ink-secondary)",
                                }}
                              >
                                <BotAvatar role={assigneeMeta.role} size={16} active={assignee.status === "working"} />
                                <span>{assignee.name}</span>
                              </span>
                            )}
                          </div>

                          {t.sourceAnnotationId && (
                            <span className="pill warning">Fix for {t.sourceAnnotationId}</span>
                          )}

                          {deps.length > 0 && (
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              {deps.map((d) => {
                                const met =
                                  d.task && (d.task.status === "verified" || d.task.status === "merged");
                                return (
                                  <span
                                    key={d.id}
                                    className={`pill ${met ? "success" : "warning"}`}
                                    title={`Prerequisite ${d.id}: ${d.task?.status ?? "missing"}`}
                                  >
                                    Dep: {d.task?.title ?? d.id} ({d.task?.status ?? "?"})
                                  </span>
                                );
                              })}
                            </div>
                          )}

                          {t.handoffPath && (
                            <button
                              type="button"
                              className="mono-tag"
                              style={{ cursor: "pointer", textAlign: "left" }}
                              onClick={() =>
                                onOpenBrowserItem(
                                  activeProject.id,
                                  "doc",
                                  t.handoffPath!,
                                  t.handoffPath!.split("/").pop() ?? "Handoff",
                                )
                              }
                            >
                              Handoff: {t.handoffPath}
                            </button>
                          )}

                          {(t.status === "ready" || t.status === "backlog") && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                              {peerDispatchCandidates.length > 0 && (
                                <select
                                  className="field-input"
                                  style={{ padding: "4px 7px", fontSize: "var(--text-2xs)" }}
                                  value={chosenDispatchBot}
                                  disabled={busyAction}
                                  onChange={(e) =>
                                    setDispatchAgentByTask((prev) => ({ ...prev, [t.id]: e.target.value }))
                                  }
                                >
                                  <option value="">Auto-assign / Spawn Peer Bot</option>
                                  {peerDispatchCandidates.map((bot) => (
                                    <option key={bot.id} value={bot.id}>
                                      {bot.name} ({bot.model})
                                    </option>
                                  ))}
                                </select>
                              )}
                              <button
                                type="button"
                                className="btn sm primary"
                                disabled={busyAction || unmetDeps.length > 0}
                                title={
                                  unmetDeps.length > 0
                                    ? "Waiting on prerequisite tasks to verify or merge"
                                    : "Dispatch task to peer bot worktree"
                                }
                                onClick={() =>
                                  void runSafe(() =>
                                    onSendCommand({
                                      type: "task.dispatch",
                                      projectId: activeProject.id,
                                      taskId: t.id,
                                      ...(chosenDispatchBot ? { agentId: chosenDispatchBot } : {}),
                                    }),
                                  )
                                }
                              >
                                <Play size={12} strokeWidth={1.6} />
                                <span>{unmetDeps.length > 0 ? "Blocked by DAG" : "Dispatch"}</span>
                              </button>
                            </div>
                          )}

                          {(t.status === "in_review" || t.status === "blocked") && (
                            <button
                              type="button"
                              className="btn sm primary"
                              disabled={busyAction}
                              onClick={() =>
                                void runSafe(() =>
                                  onSendCommand({
                                    type: "task.verify",
                                    projectId: activeProject.id,
                                    taskId: t.id,
                                  }),
                                )
                              }
                              title="Run fresh cross-family independent verification"
                            >
                              <ShieldCheck size={12} strokeWidth={1.6} />
                              <span>Verify (Fresh)</span>
                            </button>
                          )}

                          {t.status === "verified" && (
                            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                              <button
                                type="button"
                                className="btn sm primary"
                                disabled={busyAction}
                                onClick={() =>
                                  void runSafe(() =>
                                    onSendCommand({
                                      type: "task.merge",
                                      projectId: activeProject.id,
                                      taskId: t.id,
                                      strategy: "squash",
                                    }),
                                  )
                                }
                              >
                                <GitMerge size={12} strokeWidth={1.6} />
                                <span>Merge</span>
                              </button>
                              <button
                                type="button"
                                className="btn sm"
                                onClick={() => onSelectSubView("checkpoints")}
                              >
                                <span>Options</span>
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeSubView === "checkpoints" && (
          <div className="bots-workbench-pad">
            <CheckpointsMergePanel
              project={activeProject}
              agents={projectAgents}
              tasks={tasks}
              checkpoints={checkpoints}
              verifications={verifications}
              onRefreshCheckpoints={onFetchCheckpoints}
              onSendCommand={onSendCommand}
              onOpenDiff={() => openDiff()}
              onNotifyError={onNotifyError}
            />
          </div>
        )}

        {activeProject && activeSubView === "debates" && (
          <div className="bots-workbench-pad">
            <DebatesVerifierPanel
              key={activeProject.id}
              projectId={activeProject.id}
              agents={projectAgents}
              debates={debates}
              debateMessages={debateMessagesByDebate}
              verifications={verifications}
              onOpenDebate={async (params) => {
                await onSendCommand({ type: "debate.open", ...params });
              }}
              onPostDebate={async (params) => {
                await onSendCommand({ type: "debate.post", ...params });
              }}
              onResolveDebate={async (params) => {
                await onSendCommand({ type: "debate.resolve", ...params });
              }}
            />
          </div>
        )}

        {activeSubView === "selfmod" && (
          <div className="bots-workbench-pad">
            <SelfModPanel
              proposals={selfModProposals}
              onPropose={async (params: {
                kind: SelfModKind;
                targetId: string;
                title: string;
                rationale: string;
                content: string;
                autoVerify: boolean;
              }) => {
                await onSendCommand({ type: "selfmod.propose", ...params });
              }}
              onVerify={async (proposalId) => {
                await onSendCommand({ type: "selfmod.verify", proposalId });
              }}
              onPromote={async (proposalId) => {
                await onSendCommand({ type: "selfmod.promote", proposalId });
              }}
              onRollback={async (proposalId, reason) => {
                await onSendCommand({
                  type: "selfmod.rollback",
                  proposalId,
                  ...(reason ? { reason } : {}),
                });
              }}
            />
          </div>
        )}
      </div>

      {/* Factory Precision Composer (Steer-to-Team Lead Dock) */}
      {activeProject && (
        <div className="bots-composer-wrap">
          {mentionPrefix && (
            <div style={{ maxWidth: 704, margin: "0 auto 6px", display: "flex", alignItems: "center", gap: 6 }}>
              <span className="mention-chip" onClick={() => setMentionPrefix(null)} title="Clear @mention target">
                <span>Addressing @{mentionPrefix}</span>
                <X size={10} strokeWidth={1.8} />
              </span>
            </div>
          )}
          <PrecisionComposer
            mode="steer"
            placeholder={
              mentionPrefix
                ? `Send steer mentioning @${mentionPrefix}… (/ for commands)`
                : "Steer the Team Lead… (/ for commands)"
            }
            busy={busyAction}
            activeProject={activeProject}
            projects={projects}
            onSelectProject={onSelectProject}
            activeModelLabel={activeModelLabel}
            providers={providers}
            selectedTarget={selectedTarget}
            onSelectTarget={(target) => void handleSelectComposerTarget(target)}
            gitDiff={gitDiff}
            showDiffTray={true}
            onViewDiff={openDiff}
            onOpenBrowser={openFirstArtifactOrDiff}
            effort={effort}
            onChangeEffort={setEffort}
            autonomy={autonomy}
            onChangeAutonomy={setAutonomy}
            onSubmit={async (msg) => {
              const finalMsg = mentionPrefix ? `@${mentionPrefix} ${msg}` : msg;
              await runSafe(async () => {
                await onSendCommand({
                  type: "steer.submit",
                  projectId: activeProject.id,
                  message: finalMsg,
                  reasoningEffort: effort,
                  autonomyLevel: autonomy,
                });
                setMentionPrefix(null);
              });
            }}
            onSlashAction={handleSlash}
          />
        </div>
      )}
    </div>
  );
}
