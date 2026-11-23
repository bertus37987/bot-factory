import { AlertCircle, Check, Play, Plus, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  AgentRecord,
  ArtifactEntry,
  DebateMessageRecord,
  DebateRecord,
  GitDiffResponse,
  ProjectRecord,
  SelfModKind,
  SelfModProposalRecord,
  SubscriptionTopic,
  TaskRecord,
  TimelineItem,
  VerificationReportRecord,
} from "@bot-factory/shared";
import { PrecisionComposer, type AutonomyLevel } from "../components/PrecisionComposer";
import type { ReasoningEffort } from "../components/ReasoningEffortSlider";
import { DebatesVerifierPanel, SelfModPanel } from "../phase3/Phase3Panels";
import { BotChatStream } from "./BotChatStream";

export type BotsSubView = "chat_single" | "chat_group" | "board" | "debates" | "selfmod";

interface BotsTabProps {
  projects: ProjectRecord[];
  agents: AgentRecord[];
  activeProject: ProjectRecord | null;
  activeAgent: AgentRecord | null;
  activeSubView: BotsSubView;
  tasksByProject: Record<string, TaskRecord[]>;
  artifactsByProject: Record<string, ArtifactEntry[]>;
  timelinesByAgent: Record<string, TimelineItem[]>;
  debatesByProject: Record<string, DebateRecord[]>;
  debateMessagesByDebate: Record<string, DebateMessageRecord[]>;
  verificationsByProject: Record<string, VerificationReportRecord[]>;
  selfModProposals: SelfModProposalRecord[];
  gitDiff: GitDiffResponse | null;
  effort: ReasoningEffort;
  autonomy: AutonomyLevel;
  onChangeEffort: (v: ReasoningEffort) => void;
  onChangeAutonomy: (v: AutonomyLevel) => void;
  onSelectProject: (id: string) => void;
  onChangeSubView: (view: BotsSubView) => void;
  onSubscribe: (topic: SubscriptionTopic) => void;
  onUnsubscribe: (topic: SubscriptionTopic) => void;
  onCreateProject: (name: string) => Promise<void>;
  onSpawnBot: (projectId: string) => Promise<void>;
  onSubmitSteer: (projectId: string, message: string) => Promise<void>;
  onCreateTask: (projectId: string, title: string) => Promise<void>;
  onDispatchTask: (projectId: string, taskId: string) => Promise<void>;
  onVerifyTask: (projectId: string, taskId: string) => Promise<void>;
  onOpenArtifactInBrowser: (artifact: ArtifactEntry) => void;
  onOpenDiffInBrowser: () => void;
  onOpenBrowser: () => void;
  onOpenDebate: (params: {
    projectId: string;
    taskId?: string;
    topic: string;
    reason: string;
    participantAgentIds: string[];
  }) => Promise<void>;
  onPostDebate: (params: { debateId: string; agentId: string; position: string; evidence?: string }) => Promise<void>;
  onResolveDebate: (params: { debateId: string; decision: string }) => Promise<void>;
  onProposeSelfMod: (params: {
    kind: SelfModKind;
    targetId: string;
    title: string;
    rationale: string;
    content: string;
    autoVerify: boolean;
  }) => Promise<void>;
  onVerifySelfMod: (proposalId: string) => Promise<void>;
  onPromoteSelfMod: (proposalId: string) => Promise<void>;
  onRollbackSelfMod: (proposalId: string) => Promise<void>;
}

export function BotsTab(props: BotsTabProps) {
  const {
    projects,
    agents,
    activeProject,
    activeAgent,
    activeSubView,
    tasksByProject,
    artifactsByProject,
    timelinesByAgent,
    debatesByProject,
    debateMessagesByDebate,
    verificationsByProject,
    selfModProposals,
    gitDiff,
    effort,
    autonomy,
    onChangeEffort,
    onChangeAutonomy,
    onSelectProject,
    onChangeSubView,
    onSubscribe,
    onUnsubscribe,
  } = props;

  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [uiError, setUiError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);

  const projectAgents = useMemo(
    () => (activeProject ? agents.filter((a) => a.projectId === activeProject.id) : []),
    [agents, activeProject],
  );

  useEffect(() => {
    setNewTaskTitle("");
    setUiError(null);
  }, [activeProject?.id]);

  // Subscribe to all bots in active project when in group room, or active agent in single view
  useEffect(() => {
    if (!activeProject) return;
    const boardTopic: SubscriptionTopic = `project:${activeProject.id}:board`;
    const previewTopic: SubscriptionTopic = `project:${activeProject.id}:previews`;
    const debatesTopic: SubscriptionTopic = `project:${activeProject.id}:debates`;
    onSubscribe(boardTopic);
    onSubscribe(previewTopic);
    onSubscribe(debatesTopic);
    return () => {
      onUnsubscribe(boardTopic);
      onUnsubscribe(previewTopic);
      onUnsubscribe(debatesTopic);
    };
  }, [activeProject?.id, onSubscribe, onUnsubscribe]);

  useEffect(() => {
    if (activeSubView !== "selfmod") return;
    onSubscribe("global:selfmod");
    return () => onUnsubscribe("global:selfmod");
  }, [activeSubView, onSubscribe, onUnsubscribe]);

  useEffect(() => {
    const targets = activeSubView === "chat_group" ? projectAgents : activeAgent ? [activeAgent] : [];
    const topics: SubscriptionTopic[] = targets.map((a) => `bot:${a.id}:timeline` as SubscriptionTopic);
    for (const t of topics) onSubscribe(t);
    return () => {
      for (const t of topics) onUnsubscribe(t);
    };
  }, [activeSubView, activeAgent?.id, projectAgents.map((a) => a.id).join(","), onSubscribe, onUnsubscribe]);

  const runSafe = async (fn: () => Promise<void>) => {
    if (busyAction) return;
    setBusyAction(true);
    setUiError(null);
    try {
      await fn();
    } catch (err) {
      setUiError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(false);
    }
  };

  const tasks = activeProject ? tasksByProject[activeProject.id] ?? [] : [];
  const artifacts = activeProject ? artifactsByProject[activeProject.id] ?? [] : [];
  const debates = activeProject ? debatesByProject[activeProject.id] ?? [] : [];
  const verifications = activeProject ? verificationsByProject[activeProject.id] ?? [] : [];

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

  const handleSlash = (command: string) => {
    if (!activeProject) return;
    if (command === "/diff") {
      props.onOpenDiffInBrowser();
    } else if (command === "/preview" || command === "/plan") {
      const doc = artifacts.find((a) => a.kind === "doc") ?? artifacts[0];
      if (doc) props.onOpenArtifactInBrowser(doc);
      else props.onOpenBrowser();
    } else if (command === "/spawn-bot") {
      void runSafe(() => props.onSpawnBot(activeProject.id));
    } else if (command === "/verify") {
      const target = tasks.find((t) => t.status === "in_review" || t.status === "blocked");
      if (target) void runSafe(() => props.onVerifyTask(activeProject.id, target.id));
      else onChangeSubView("debates");
    }
  };

  return (
    <div className="bots-center-shell" data-density="compact">
      <div className="bots-center-scroll">
        {uiError && (
          <div className="inline-error" style={{ marginBottom: 12 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <AlertCircle size={13} strokeWidth={1.6} />
              <span>{uiError}</span>
            </span>
            <button type="button" className="btn xs ghost" onClick={() => setUiError(null)}>
              Schließen
            </button>
          </div>
        )}

        {!activeProject && activeSubView !== "selfmod" && (
          <div className="bots-empty-state">
            <div className="bots-empty-title">Noch kein Projekt-Team aktiv</div>
            <p className="bots-empty-sub">
              Lege links ein neues Projekt an — Bot-Factory erstellt automatisch einen Project Manager (Chief Beaver)
              sowie annotierbare Plan-, Bild- und 3D-Previews.
            </p>
            <button
              type="button"
              className="btn primary"
              disabled={busyAction}
              onClick={() => void runSafe(() => props.onCreateProject(`Projekt-${projects.length + 1}`))}
            >
              <Plus size={14} strokeWidth={1.6} />
              <span>Neues Projekt-Team starten</span>
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
            tasks={tasks}
            debates={debates}
            debateMessages={debateMessagesByDebate}
            verifications={verifications}
            artifacts={artifacts}
            onOpenArtifactInBrowser={props.onOpenArtifactInBrowser}
            onOpenDiffInBrowser={props.onOpenDiffInBrowser}
            onVerifyTask={(taskId) => runSafe(() => props.onVerifyTask(activeProject.id, taskId))}
            onDispatchTask={(taskId) => runSafe(() => props.onDispatchTask(activeProject.id, taskId))}
            onOpenGroupRoom={() => onChangeSubView("chat_group")}
          />
        )}

        {activeProject && activeSubView === "board" && (
          <div className="bots-workbench-pad">
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input
                className="field-input"
                placeholder="Neuen Task fürs Projekt-Board anlegen…"
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newTaskTitle.trim()) {
                    const title = newTaskTitle.trim();
                    void runSafe(async () => {
                      await props.onCreateTask(activeProject.id, title);
                      setNewTaskTitle("");
                    });
                  }
                }}
              />
              <button
                type="button"
                className="btn primary"
                disabled={busyAction || !newTaskTitle.trim()}
                onClick={() => {
                  if (!newTaskTitle.trim()) return;
                  const title = newTaskTitle.trim();
                  void runSafe(async () => {
                    await props.onCreateTask(activeProject.id, title);
                    setNewTaskTitle("");
                  });
                }}
              >
                <Plus size={14} strokeWidth={1.6} />
                <span>Task</span>
              </button>
            </div>

            <div className="kanban-grid">
              {(["ready", "claimed", "in_review", "blocked", "merged"] as const).map((col) => {
                const colTasks = tasks.filter((t) =>
                  col === "ready"
                    ? t.status === "ready" || t.status === "backlog"
                    : col === "merged"
                      ? t.status === "merged" || t.status === "verified"
                      : t.status === col,
                );
                return (
                  <div key={col} className="kanban-col">
                    <div className="section-eyebrow">
                      <span>{col}</span>
                      <span className="mono-tag">{colTasks.length}</span>
                    </div>
                    {colTasks.map((t) => (
                      <div key={t.id} className="task-card">
                        <div style={{ fontWeight: 600, fontSize: "var(--text-sm)", color: "var(--ink-primary)" }}>
                          {t.title}
                        </div>
                        {t.status === "verified" && (
                          <span className="pill success">
                            <Check size={11} strokeWidth={1.8} />
                            verified
                          </span>
                        )}
                        {t.status === "blocked" && <span className="pill danger">blocked</span>}
                        {t.sourceAnnotationId && <span className="pill warning">Fix für {t.sourceAnnotationId}</span>}
                        {t.handoffPath && <span className="mono-tag">Handoff: {t.handoffPath}</span>}
                        {(t.status === "ready" || t.status === "backlog") && (
                          <button
                            type="button"
                            className="btn sm primary"
                            disabled={busyAction}
                            onClick={() => void runSafe(() => props.onDispatchTask(activeProject.id, t.id))}
                          >
                            <Play size={12} strokeWidth={1.6} />
                            <span>An Peer-Bot vergeben</span>
                          </button>
                        )}
                        {(t.status === "in_review" || t.status === "blocked") && (
                          <button
                            type="button"
                            className="btn sm primary"
                            disabled={busyAction}
                            onClick={() => void runSafe(() => props.onVerifyTask(activeProject.id, t.id))}
                            title="Kontextunabhängigen Cross-Family-Verifier in frischer Session starten"
                          >
                            <ShieldCheck size={12} strokeWidth={1.6} />
                            <span>Verify (Fresh)</span>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
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
              onOpenDebate={props.onOpenDebate}
              onPostDebate={props.onPostDebate}
              onResolveDebate={props.onResolveDebate}
            />
          </div>
        )}

        {activeSubView === "selfmod" && (
          <div className="bots-workbench-pad">
            <SelfModPanel
              proposals={selfModProposals}
              onPropose={props.onProposeSelfMod}
              onVerify={props.onVerifySelfMod}
              onPromote={props.onPromoteSelfMod}
              onRollback={props.onRollbackSelfMod}
            />
          </div>
        )}
      </div>

      {/* Factory Precision Composer (Steer-to-PM Dock — physically separated from Pause / Hard-Stop in top header) */}
      {activeProject && (
        <div className="bots-composer-wrap">
          <PrecisionComposer
            mode="steer"
            placeholder="Kurskorrektur an den Team Lead… (/ für Befehle)"
            busy={busyAction}
            activeProject={activeProject}
            projects={projects}
            onSelectProject={onSelectProject}
            activeModelLabel={activeAgent ? activeAgent.model : "mistral-large-4"}
            gitDiff={gitDiff}
            showDiffTray={true}
            onViewDiff={props.onOpenDiffInBrowser}
            onQuickReview={props.onOpenDiffInBrowser}
            onOpenBrowser={props.onOpenBrowser}
            effort={effort}
            onChangeEffort={onChangeEffort}
            autonomy={autonomy}
            onChangeAutonomy={onChangeAutonomy}
            onSubmit={async (msg) => {
              await runSafe(() => props.onSubmitSteer(activeProject.id, msg));
            }}
            onSlashAction={handleSlash}
          />
        </div>
      )}
    </div>
  );
}
