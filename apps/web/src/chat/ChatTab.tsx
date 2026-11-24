import {
  ArrowUpRight,
  Brain,
  CheckCircle2,
  FolderPlus,
  GitMerge,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  GitDiffResponse,
  ProjectRecord,
  QuietStatusProjection,
  TaskRecord,
  TimelineItem,
} from "@bot-factory/shared";
import type { ArtifactCardEvent, ProviderSummary } from "../client/useBotFactory";
import { BotAvatar, JobTitlePill } from "../components/BotAvatars";
import { BrowserPaneIcon, DiffBranchIcon, DocTabIcon } from "../components/BotFactoryIcons";
import { BotThinkingOrb } from "../components/BotThinkingOrb";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { useFollowLatest } from "../components/useFollowLatest";
import {
  PrecisionComposer,
  type AutonomyLevel,
  type ComposerAttachment,
  type ModelTargetSelection,
} from "../components/PrecisionComposer";
import type { ReasoningEffort } from "../components/ReasoningEffortSlider";

interface ChatTabProps {
  messages: TimelineItem[];
  cards: ArtifactCardEvent[];
  streamingText: string;
  streamingThought: string;
  projects: ProjectRecord[];
  activeProject: ProjectRecord | null;
  tasksByProject: Record<string, TaskRecord[]>;
  quietStatus: QuietStatusProjection;
  activeModelLabel: string;
  providers: ProviderSummary[];
  selectedTarget: ModelTargetSelection | null;
  onSelectTarget: (target: ModelTargetSelection) => void;
  contextPercent?: number;
  contextTooltip?: string;
  memoryRecalledActive?: boolean;
  gitDiff: GitDiffResponse | null;
  effort: ReasoningEffort;
  autonomy: AutonomyLevel;
  onChangeEffort: (v: ReasoningEffort) => void;
  onChangeAutonomy: (v: AutonomyLevel) => void;
  attachments?: ComposerAttachment[];
  onRemoveAttachment?: (id: string) => void;
  onClearAttachments?: () => void;
  onFocusPane?: () => void;
  onSelectProject: (projectId: string) => void;
  onSendChat: (text: string) => Promise<void>;
  onOpenNewProjectModal: () => void;
  onOpenProjectPreview: (projectId: string, artifactPath?: string) => void;
  onOpenDiffInBrowser: (projectId?: string) => void;
  onOpenBrowser: () => void;
  onSwitchToBots: (projectId?: string) => void;
  onOpenMemoryStudio: () => void;
  onMergeTask: (projectId: string, taskId: string) => Promise<void>;
}

function formatTime(ts: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ts));
  } catch {
    return "";
  }
}

type StreamEntry =
  | { kind: "message"; ts: number; msg: TimelineItem }
  | { kind: "card"; ts: number; card: ArtifactCardEvent };

export function ChatTab({
  messages,
  cards,
  streamingText,
  streamingThought,
  projects,
  activeProject,
  tasksByProject,
  quietStatus,
  activeModelLabel,
  providers,
  selectedTarget,
  onSelectTarget,
  contextPercent,
  contextTooltip,
  memoryRecalledActive,
  gitDiff,
  effort,
  autonomy,
  onChangeEffort,
  onChangeAutonomy,
  attachments,
  onRemoveAttachment,
  onClearAttachments,
  onFocusPane,
  onSelectProject,
  onSendChat,
  onOpenNewProjectModal,
  onOpenProjectPreview,
  onOpenDiffInBrowser,
  onOpenBrowser,
  onSwitchToBots,
  onOpenMemoryStudio,
  onMergeTask,
}: ChatTabProps) {
  const [busy, setBusy] = useState(false);
  const [mergingTaskId, setMergingTaskId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { viewportRef, contentRef, following, jumpToLatest } = useFollowLatest();

  const isStreaming = streamingText.length > 0 || streamingThought.length > 0;

  const timeline = useMemo<StreamEntry[]>(() => {
    const combined: StreamEntry[] = [
      ...messages.map((msg) => ({ kind: "message" as const, ts: msg.createdAt, msg })),
      ...cards.map((card) => ({ kind: "card" as const, ts: card.createdAt, card })),
    ];
    combined.sort((a, b) => a.ts - b.ts);
    return combined;
  }, [messages, cards]);

  const handleSend = async (text: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await onSendChat(text);
    } finally {
      setBusy(false);
    }
  };

  const handleMerge = async (projectId: string, taskId: string) => {
    if (mergingTaskId) return;
    setMergingTaskId(taskId);
    setActionError(null);
    try {
      await onMergeTask(projectId, taskId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setMergingTaskId(null);
    }
  };

  const handleSlash = (command: string) => {
    if (command === "/diff") {
      onOpenDiffInBrowser(activeProject?.id);
    } else if (command === "/preview" || command === "/plan") {
      if (activeProject) onOpenProjectPreview(activeProject.id, "plans/roadmap.md");
      else onOpenBrowser();
    } else if (command === "/spawn-bot" || command === "/verify") {
      onSwitchToBots(activeProject?.id);
    }
  };

  const isEmpty = timeline.length === 0 && !isStreaming;

  return (
    <div
      className="chat-root"
      data-density="airy"
      onMouseDown={() => onFocusPane?.()}
      onFocusCapture={() => onFocusPane?.()}
    >
      <div className="chat-layout">
        {actionError && (
          <div className="inline-error" role="alert">
            <span>{actionError}</span>
            <button type="button" className="btn xs ghost" onClick={() => setActionError(null)}>
              Dismiss
            </button>
          </div>
        )}

        <div className="chat-stream-frame">
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable transcript needs a keyboard entry point. */}
        <div className="chat-stream" ref={viewportRef} tabIndex={0} role="region" aria-label="Main Agent conversation">
          <div className="chat-stream-content" ref={contentRef}>
          {isEmpty && (
            <div className="chat-empty">
              <div className="chat-empty-emblem">
                <BotAvatar
                  role="orchestrator"
                  size={64}
                  active={busy}
                  status={busy ? "working" : "idle"}
                  seed="main-agent"
                />
              </div>
              <h2 className="chat-empty-title">What are we building today?</h2>
              <p className="chat-empty-body">
                Coordinate calmly with the Main Agent. It creates project workspaces, delegates goals to
                engineering teams, verifies work in the background, and brings finished deliverables here for
                Diff Review and Merge.
              </p>
              <div className="chat-empty-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={onOpenNewProjectModal}
                >
                  <FolderPlus size={14} strokeWidth={1.6} />
                  <span>New Project</span>
                </button>
                {quietStatus.activeProjects > 0 && (
                  <button type="button" className="btn" onClick={() => onSwitchToBots(activeProject?.id)}>
                    <span>Open Engineering Teams ({quietStatus.runningBots} running)</span>
                    <ArrowUpRight size={13} strokeWidth={1.6} />
                  </button>
                )}
              </div>
            </div>
          )}

          {!isEmpty && (
            <div className="bcs-time-sep">
              <span>Today · Main Agent Channel</span>
            </div>
          )}

          {timeline.map((entry) => {
            if (entry.kind === "message") {
              const m = entry.msg;
              const isUser = m.role === "user";
              return (
                <div
                  key={m.id}
                  className={`chat-turn ${isUser ? "user msg-side-right" : "assistant msg-side-left"}`}
                >
                  {isUser ? (
                    <div className="chat-bubble-human">
                      <div>{m.content}</div>
                      <span className="chat-turn-time human">{formatTime(m.createdAt)}</span>
                    </div>
                  ) : (
                    <div className="chat-assistant-row">
                      <BotAvatar role="orchestrator" size={30} seed="main-agent" />
                      <div className="chat-assistant-body">
                        <div className="chat-turn-meta">
                          <span className="chat-speaker-name">Main Agent</span>
                          <JobTitlePill label="Orchestrator" role="orchestrator" />
                          {memoryRecalledActive && (
                            <button
                              type="button"
                              className="chat-memory-badge"
                              onClick={onOpenMemoryStudio}
                              title="Persistent L1/L2 memory active — click to inspect"
                            >
                              <Brain size={11} strokeWidth={1.6} />
                              <span>Memory recalled</span>
                            </button>
                          )}
                          <span className="chat-turn-time">{formatTime(m.createdAt)}</span>
                        </div>
                        <div className="chat-prose-assistant role-orchestrator">
                          <MarkdownRenderer content={m.content} />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            }

            const c = entry.card;
            const projectTasks = tasksByProject[c.projectId] ?? [];
            const verifiedTasksToMerge = projectTasks.filter(
              (t) =>
                t.status === "verified" &&
                (!c.verifiedTaskIds || c.verifiedTaskIds.length === 0 || c.verifiedTaskIds.includes(t.id)),
            );

            if (c.kind === "delegation") {
              return (
                <div key={c.id} className="delivery-card">
                  <div className="delivery-card-top">
                    <span className="inline-preview-icon">
                      <Sparkles size={15} strokeWidth={1.6} />
                    </span>
                    <div className="inline-preview-copy">
                      <span className="inline-preview-title">{c.title}</span>
                      <span className="inline-preview-sub">{c.subtitle}</span>
                    </div>
                    <span className="pill active">Delegated</span>
                  </div>
                  <div className="delivery-card-actions">
                    <button
                      type="button"
                      className="btn xs"
                      onClick={() => onSwitchToBots(c.projectId)}
                    >
                      <span>Watch Team</span>
                      <ArrowUpRight size={12} strokeWidth={1.6} />
                    </button>
                  </div>
                </div>
              );
            }

            if (c.kind === "review_merge" || c.kind === "blocked" || c.kind === "milestone") {
              const isBlocked = c.kind === "blocked";
              const isVerifiedReady = c.kind === "review_merge";
              return (
                <div
                  key={c.id}
                  className={`delivery-card ${isVerifiedReady ? "verified" : isBlocked ? "blocked" : ""}`.trim()}
                >
                  <div className="delivery-card-top">
                    <span className="inline-preview-icon">
                      {isBlocked ? (
                        <ShieldAlert size={15} strokeWidth={1.6} />
                      ) : (
                        <CheckCircle2 size={15} strokeWidth={1.6} />
                      )}
                    </span>
                    <div className="inline-preview-copy">
                      <span className="inline-preview-title">{c.title}</span>
                      <span className="inline-preview-sub">{c.subtitle}</span>
                    </div>
                    <span className={`pill ${isBlocked ? "warning" : isVerifiedReady ? "success" : "active"}`}>
                      {isBlocked ? "Needs Attention" : isVerifiedReady ? "Verified Delivery" : "Milestone"}
                    </span>
                  </div>
                  <div className="delivery-card-actions">
                    <button
                      type="button"
                      className="btn xs"
                      onClick={() => {
                        onSelectProject(c.projectId);
                        onOpenDiffInBrowser(c.projectId);
                      }}
                    >
                      <DiffBranchIcon size={12} />
                      <span>Review Diff</span>
                    </button>
                    {verifiedTasksToMerge.map((vt) => (
                      <button
                        key={vt.id}
                        type="button"
                        className="btn xs accent"
                        disabled={mergingTaskId !== null}
                        onClick={() => void handleMerge(c.projectId, vt.id)}
                      >
                        <GitMerge size={12} strokeWidth={1.6} />
                        <span>
                          {mergingTaskId === vt.id ? "Merging…" : `Merge to main (${vt.title})`}
                        </span>
                      </button>
                    ))}
                    <button
                      type="button"
                      className="btn xs ghost"
                      onClick={() => onSwitchToBots(c.projectId)}
                    >
                      <span>Open Team</span>
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <button
                key={c.id}
                type="button"
                className="inline-preview-card"
                onClick={() => onOpenProjectPreview(c.projectId, c.artifactPath)}
              >
                <span className="inline-preview-icon">
                  <DocTabIcon size={15} />
                </span>
                <span className="inline-preview-copy">
                  <span className="inline-preview-title">{c.title}</span>
                  <span className="inline-preview-sub">{c.subtitle}</span>
                </span>
                <span className="inline-preview-cta">
                  <BrowserPaneIcon size={13} />
                  <span>Open in Browser</span>
                </span>
              </button>
            );
          })}

          {isStreaming && (
            <div className="chat-turn assistant msg-side-left">
              <div className="chat-assistant-row">
                <BotAvatar role="orchestrator" size={30} active status="working" seed="main-agent" />
                <div className="chat-assistant-body">
                  <div className="chat-turn-meta">
                    <span className="chat-speaker-name">Main Agent</span>
                    <JobTitlePill label="Orchestrator" role="orchestrator" />
                    <BotThinkingOrb activity="composing" size={20} shell={false} />
                    <span className="chat-turn-time">Streaming…</span>
                  </div>
                  {streamingThought && (
                    <div className="chat-thought-pill">{streamingThought}</div>
                  )}
                  {streamingText && (
                    <div className="chat-prose-assistant role-orchestrator">
                      <MarkdownRenderer content={streamingText} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {busy && !isStreaming && (
            <div className="chat-thinking-row">
              <BotAvatar role="orchestrator" size={24} active status="working" seed="main-agent" />
              <BotThinkingOrb activity="composing" size={20} shell={false} />
              <span>Main Agent is thinking…</span>
            </div>
          )}
          </div>
        </div>
        {!following && (
          <button className="btn xs chat-jump-latest" type="button" onClick={jumpToLatest}>
            Jump to Latest
          </button>
        )}
        </div>

        <PrecisionComposer
          mode="chat"
          placeholder="Message the Main Agent… (/ for commands)"
          busy={busy}
          activeProject={activeProject}
          projects={projects}
          onSelectProject={onSelectProject}
          activeModelLabel={activeModelLabel}
          providers={providers}
          selectedTarget={selectedTarget}
          onSelectTarget={onSelectTarget}
          contextPercent={contextPercent}
          contextTooltip={contextTooltip}
          gitDiff={gitDiff}
          showDiffTray={true}
          onViewDiff={() => onOpenDiffInBrowser(activeProject?.id)}
          onOpenBrowser={onOpenBrowser}
          effort={effort}
          onChangeEffort={onChangeEffort}
          autonomy={autonomy}
          onChangeAutonomy={onChangeAutonomy}
          attachments={attachments}
          onRemoveAttachment={onRemoveAttachment}
          onClearAttachments={onClearAttachments}
          onSubmit={handleSend}
          onSlashAction={handleSlash}
        />
      </div>
    </div>
  );
}
