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
  GitMerge,
  Kanban,
  OctagonX,
  Pause,
  Plus,
  RotateCw,
  Target,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import type { ProviderSummary, RpcCommandInput } from "../client/useBotFactory";
import { BotAvatar, resolveBotRole } from "../components/BotAvatars";
import {
  PrecisionComposer,
  type AutonomyLevel,
  type ComposerAttachment,
  type ModelTargetSelection,
} from "../components/PrecisionComposer";
import type { ReasoningEffort } from "../components/ReasoningEffortSlider";
import { SelfModPanel } from "../phase3/Phase3Panels";
import { CheckpointsMergePanel } from "../studio/CheckpointsMergePanel";
import { BotChatStream } from "./BotChatStream";
import { TeamSwitcher } from "./TeamSwitcher";
import { TodoBoardView, type TodoCreateInput } from "./TodoBoardView";
import "./BotsInbox.css";

export type BotsSubView = "chat_group" | "chat_single" | "board" | "checkpoints" | "selfmod";

export interface BotsTabProps {
  isVisible: boolean;
  projects: ProjectRecord[];
  activeProject: ProjectRecord | null;
  agents: AgentRecord[];
  metaAgentId?: string | null;
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
  activeSubView: BotsSubView;
  conversationKey: string;
  activeAgentId: string | null;
  selfModProposals: SelfModProposalRecord[];
  attachments?: ComposerAttachment[];
  onRemoveAttachment?: (id: string) => void;
  onClearAttachments?: (sent: ComposerAttachment[]) => void;
  onFocusPane?: () => void;
  compactSplit?: boolean;
  onSelectSubView: (view: BotsSubView, agentId?: string | null) => void;
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

export function BotsTab(props: BotsTabProps): JSX.Element {
  const {
    isVisible,
    projects,
    activeProject,
    agents,
    metaAgentId,
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
    conversationKey,
    activeAgentId,
    selfModProposals,
    attachments,
    onRemoveAttachment,
    onClearAttachments,
    onFocusPane,
    compactSplit = false,
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
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mentions, setMentions] = useState<Record<string, string | null>>({});
  const [sendingByConversation, setSendingByConversation] = useState<Record<string, boolean>>({});
  const mentionPrefix = mentions[conversationKey] ?? null;
  const setMentionPrefix = (name: string | null) =>
    setMentions((prev) => ({ ...prev, [conversationKey]: name }));
  const chatOpen = activeSubView === "chat_group" || activeSubView === "chat_single";
  const [controlTargetId, setControlTargetId] = useState<string | null>(null);

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
    setSelectedTarget(null);
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

  const verifiedCount = useMemo(() => tasks.filter((t) => t.status === "verified").length, [tasks]);

  const activeModelLabel = useMemo(() => {
    if (selectedTarget) return `${selectedTarget.provider}/${selectedTarget.model}`;
    const override = activeProject?.routingOverrides?.project_manager;
    if (override) return `${override.provider}/${override.model}`;
    return teamLead ? `${teamLead.provider}/${teamLead.model}` : "No Team Lead";
  }, [selectedTarget, teamLead, activeProject]);

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

  const handleCreateTodoTask = async (input: TodoCreateInput) => {
    if (!activeProject) return;
    await runSafe(async () => {
      const created = await onSendCommand<{ task?: TaskRecord }>({
        type: "task.create",
        projectId: activeProject.id,
        title: input.title,
        specMd: input.specMd,
        priority: input.priority,
        ...(input.dependsOn.length > 0 ? { dependsOn: input.dependsOn } : {}),
      });
      if (input.assignedAgentId && created?.task?.id) {
        await onSendCommand({
          type: "task.dispatch",
          projectId: activeProject.id,
          taskId: created.task.id,
          agentId: input.assignedAgentId,
        });
      }
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
        onSelectSubView("board");
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

  return (
    <div
      className="bots-center-shell"
      data-density="compact"
      onMouseDown={() => onFocusPane?.()}
      onFocusCapture={() => onFocusPane?.()}
    >
      {compactSplit && <div className="bots-inbox-header">
        <TeamSwitcher projects={projects} agents={agents} project={activeProject} onSelect={onSelectProject} />
        <div className="bots-room-label">
          {activeSubView === "chat_single" && activeAgent ? (
            <><strong>{activeAgent.name}</strong><small>{activeAgent.model}</small></>
          ) : (
            <strong>{({
              chat_group: "Group Chat",
              chat_single: "Bot activity",
              board: "Task Board",
              checkpoints: "Checkpoints & Merge",
              selfmod: "Self-Mod Sandbox",
            })[activeSubView]}</strong>
          )}
        </div>
      </div>}
      {/* Compact Subview Switcher when rendered inside Split-Chat */}
      {compactSplit && activeProject && (
        <div className="split-bots-bar">
          <div className="subview-tabs">
            <button
              type="button"
              className={`subview-tab ${activeSubView === "chat_group" ? "active" : ""}`}
              onClick={() => onSelectSubView("chat_group")}
            >
              <Users size={12} strokeWidth={1.6} />
              <span>Group</span>
            </button>
            <button
              type="button"
              className={`subview-tab ${activeSubView === "chat_single" ? "active" : ""}`}
              onClick={() => onSelectSubView("chat_single", activeAgent?.id ?? null)}
              disabled={!activeAgent}
            >
              <span>{activeAgent?.name ?? "Bot"}</span>
            </button>
            <button
              type="button"
              className={`subview-tab ${activeSubView === "board" ? "active" : ""}`}
              onClick={() => onSelectSubView("board")}
            >
              <Kanban size={12} strokeWidth={1.6} />
              <span>Todo Board</span>
            </button>
          </div>
          {activeSubView === "chat_single" && projectAgents.length > 1 && (
            <select
              className="todo-board-select"
              aria-label="Select bot chat"
              value={activeAgent?.id ?? ""}
              onChange={(e) => onSelectSubView("chat_single", e.target.value)}
            >
              {projectAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({resolveBotRole(a).jobTitle})
                </option>
              ))}
            </select>
          )}
        </div>
      )}

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

            <div className="group-target-actions">
              {controlTargetAgent && (
                <>
                  {activeSubView === "chat_group" ? (
                    <label className="bots-control-label">
                      Bot controls
                      <select
                        className="todo-board-select"
                        aria-label="Bot control target"
                        value={controlTargetAgent.id}
                        onChange={(e) => setControlTargetId(e.target.value)}
                      >
                        {projectAgents.map((bot) => (
                          <option key={bot.id} value={bot.id}>
                            {bot.name} ({bot.status.replaceAll("_", " ")})
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <span className="bots-control-label">Controls: {controlTargetAgent.name}</span>
                  )}
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
            key={conversationKey}
            mode={activeSubView === "chat_group" ? "group" : "single"}
            project={activeProject}
            activeAgent={activeAgent}
            metaAgentId={metaAgentId}
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
          <TodoBoardView
            project={activeProject}
            tasks={tasks}
            agents={projectAgents}
            goals={goals}
            verifications={verifications}
            busyAction={busyAction}
            onCreateTask={handleCreateTodoTask}
            onDispatchTask={(taskId, agentId) =>
              runSafe(() =>
                onSendCommand({
                  type: "task.dispatch",
                  projectId: activeProject.id,
                  taskId,
                  ...(agentId ? { agentId } : {}),
                }),
              )
            }
            onVerifyTask={(taskId) =>
              runSafe(() =>
                onSendCommand({
                  type: "task.verify",
                  projectId: activeProject.id,
                  taskId,
                }),
              )
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
            onOpenBrowserItem={onOpenBrowserItem}
          />
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
      {activeProject && chatOpen && (
        <div className="bots-composer-wrap">
          <div className="bots-compose-destination">
            {teamLead ? `Steer Team Lead: ${teamLead.name}` : "No Team Lead to steer"}
          </div>
          {mentionPrefix && (
            <div style={{ maxWidth: 704, margin: "0 auto 6px", display: "flex", alignItems: "center", gap: 6 }}>
              <button
                type="button"
                className="mention-chip"
                onClick={() => setMentionPrefix(null)}
                title="Clear @mention target"
              >
                <span>Addressing @{mentionPrefix}</span>
                <X size={10} strokeWidth={1.8} />
              </button>
            </div>
          )}
          <PrecisionComposer
            key={conversationKey}
            mode="steer"
            placeholder={
              mentionPrefix
                ? `Send steer mentioning @${mentionPrefix}… (/ for commands)`
                : "Steer the Team Lead… (/ for commands)"
            }
            busy={busyAction || sendingByConversation[conversationKey]}
            disabled={!teamLead}
            activeProject={activeProject}
            projects={projects}
            draft={drafts[conversationKey] ?? ""}
            onDraftChange={(text) => setDrafts((prev) => ({ ...prev, [conversationKey]: text }))}
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
            attachments={attachments}
            onRemoveAttachment={onRemoveAttachment}
            onClearAttachments={onClearAttachments}
            onSubmit={async (msg) => {
              const finalMsg = mentionPrefix ? `@${mentionPrefix} ${msg}` : msg;
              setSendingByConversation((prev) => ({ ...prev, [conversationKey]: true }));
              try {
                await onSendCommand({
                  type: "steer.submit",
                  projectId: activeProject.id,
                  message: finalMsg,
                  reasoningEffort: effort,
                  autonomyLevel: autonomy,
                });
                setMentionPrefix(null);
              } finally {
                setSendingByConversation((prev) => ({ ...prev, [conversationKey]: false }));
              }
            }}
            onSlashAction={handleSlash}
          />
        </div>
      )}
    </div>
  );
}
