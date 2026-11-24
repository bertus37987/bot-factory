import type {
  AgentRecord,
  ProjectRecord,
  TaskRecord,
  TaskStatus,
  TeamGoalRecord,
  VerificationReportRecord,
} from "@bot-factory/shared";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  FileText,
  GitBranch,
  GitMerge,
  Layers,
  ListChecks,
  Lock,
  MessageSquare,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from "react";
import { BotAvatar, JobTitlePill, resolveBotRole } from "../components/BotAvatars";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import "./TodoBoardView.css";

export type TodoViewMode = "all" | "by_bot" | "by_status";
export type TodoFilterMode = "all" | "active" | "review" | "done";
type PendingTaskOp = "dispatch" | "verify" | "merge";

export interface TodoCreateInput {
  title: string;
  specMd: string;
  priority: number;
  dependsOn: string[];
  assignedAgentId?: string;
}

export interface TodoBoardViewProps {
  project: ProjectRecord;
  tasks: TaskRecord[];
  agents: AgentRecord[];
  goals: TeamGoalRecord[];
  verifications: VerificationReportRecord[];
  busyAction?: boolean;
  onCreateTask: (input: TodoCreateInput) => Promise<void>;
  onDispatchTask: (taskId: string, agentId?: string) => Promise<void>;
  onVerifyTask: (taskId: string) => Promise<void>;
  onMergeTask: (taskId: string) => Promise<void>;
  onSelectBot?: (agentId: string) => void;
  onOpenBrowserItem?: (
    projectId: string,
    kind: "doc" | "image" | "model_3d" | "code" | "diff",
    target: string,
    label?: string,
  ) => void;
}

const PRIORITY_LABELS: Record<number, string> = {
  1: "P1 Critical",
  2: "P2 High",
  3: "P3 Normal",
  4: "P4 Low",
  5: "P5 Backlog",
};

const STATUS_META: Record<
  TaskStatus,
  { label: string; tone: "neutral" | "active" | "warning" | "danger" | "success" }
> = {
  backlog: { label: "Backlog", tone: "neutral" },
  ready: { label: "Ready", tone: "neutral" },
  claimed: { label: "In Progress", tone: "active" },
  in_review: { label: "In Review", tone: "warning" },
  blocked: { label: "Blocked", tone: "danger" },
  verified: { label: "Verified", tone: "success" },
  merged: { label: "Merged", tone: "success" },
};

const STATUS_GROUPS: ReadonlyArray<{
  id: string;
  label: string;
  statuses: ReadonlyArray<TaskStatus>;
  sampleStatus: TaskStatus;
}> = [
  { id: "in_progress", label: "In Progress", statuses: ["claimed"], sampleStatus: "claimed" },
  {
    id: "review",
    label: "Needs Attention / Review",
    statuses: ["in_review", "blocked"],
    sampleStatus: "in_review",
  },
  { id: "ready", label: "Ready / Backlog", statuses: ["ready", "backlog"], sampleStatus: "ready" },
  {
    id: "verified",
    label: "Verified (Ready to Merge)",
    statuses: ["verified"],
    sampleStatus: "verified",
  },
  { id: "merged", label: "Merged to Main", statuses: ["merged"], sampleStatus: "merged" },
];

const FILTER_OPTIONS: ReadonlyArray<{ id: TodoFilterMode; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

function isDoneStatus(status: TaskStatus): boolean {
  return status === "verified" || status === "merged";
}

function matchesFilter(task: TaskRecord, filter: TodoFilterMode): boolean {
  switch (filter) {
    case "active":
      return task.status === "backlog" || task.status === "ready" || task.status === "claimed";
    case "review":
      return task.status === "in_review" || task.status === "blocked";
    case "done":
      return isDoneStatus(task.status);
    case "all":
      return true;
  }
}

function sortTasks(list: ReadonlyArray<TaskRecord>): TaskRecord[] {
  return [...list].sort((a, b) => a.priority - b.priority || b.createdAt - a.createdAt);
}

function isDispatchablePeer(agent: AgentRecord): boolean {
  return (
    (agent.scope === "peer" || agent.scope === "sidekick") &&
    agent.status !== "stopped" &&
    agent.status !== "paused" &&
    agent.status !== "error" &&
    agent.status !== "working"
  );
}

function toneClass(tone: "neutral" | "active" | "warning" | "danger" | "success" | "accent"): string {
  switch (tone) {
    case "active":
      return "is-active";
    case "warning":
      return "is-warning";
    case "danger":
      return "is-danger";
    case "success":
      return "is-success";
    case "accent":
      return "is-accent";
    default:
      return "";
  }
}

function StatusDot({ status }: { status: TaskStatus }): JSX.Element {
  const tone = STATUS_META[status].tone;
  const color =
    tone === "success"
      ? "var(--status-success-ink)"
      : tone === "active"
        ? "var(--accent-orange)"
        : tone === "warning"
          ? "var(--status-warning-ink)"
          : tone === "danger"
            ? "var(--status-danger-ink)"
            : "var(--ink-faint)";

  return (
    <span
      aria-hidden="true"
      style={{
        width: 8,
        height: 8,
        borderRadius: "9999px",
        background: color,
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}

function TaskStatusIndicator({
  status,
  onClick,
  expanded,
}: {
  status: TaskStatus;
  onClick: () => void;
  expanded: boolean;
}): JSX.Element {
  const meta = STATUS_META[status];
  const isDone = isDoneStatus(status);

  return (
    <button
      type="button"
      className="todo-board-status-indicator"
      onClick={onClick}
      aria-label={`Status: ${meta.label}. Toggle details`}
      aria-expanded={expanded}
      title={`${meta.label} — click to ${expanded ? "collapse" : "inspect"}`}
    >
      {(status === "ready" || status === "backlog") && (
        <span className={`todo-board-ring-idle ${status === "backlog" ? "is-backlog" : ""}`.trim()} />
      )}

      {status === "claimed" && (
        <span className="todo-board-ring-claimed" aria-hidden="true">
          <span className="todo-board-ring-spinner" />
          <span className="todo-board-ring-core" />
        </span>
      )}

      {status === "in_review" && (
        <span className="todo-board-ring-review" aria-hidden="true">
          <svg viewBox="0 0 18 18" className="todo-board-check-svg" aria-hidden="true">
            <circle
              cx="9"
              cy="9"
              r="7.25"
              fill="var(--status-warning-bg)"
              stroke="var(--status-warning-ink)"
              strokeWidth="1.5"
            />
            <path d="M9 2 A7 7 0 0 0 9 16 Z" fill="var(--status-warning-ink)" />
          </svg>
        </span>
      )}

      {status === "blocked" && (
        <span className="todo-board-ring-blocked" aria-hidden="true">
          !
        </span>
      )}

      {isDone && (
        <span key="done-check" className="todo-board-ring-done" aria-hidden="true">
          <svg viewBox="0 0 18 18" className="todo-board-check-svg" aria-hidden="true">
            <circle
              cx="9"
              cy="9"
              r="7.5"
              fill={status === "merged" ? "var(--status-success-ink)" : "var(--status-success-bg)"}
              stroke="var(--status-success-ink)"
              strokeWidth="1.5"
            />
            <path
              className="todo-board-check-path"
              d="M5.4 9.3 L7.9 11.7 L12.8 6.5"
              fill="none"
              stroke={status === "merged" ? "var(--bg-canvas)" : "var(--status-success-ink)"}
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
    </button>
  );
}

interface TodoRowProps {
  project: ProjectRecord;
  task: TaskRecord;
  rowIndex: number;
  expanded: boolean;
  highlighted: boolean;
  assignedBot: AgentRecord | null;
  taskById: Map<string, TaskRecord>;
  dependentCount: number;
  latestVerification: VerificationReportRecord | null;
  dispatchCandidates: AgentRecord[];
  allProjectBots: AgentRecord[];
  selectedDispatchBotId: string;
  pendingOp: PendingTaskOp | null;
  disabled: boolean;
  onToggleExpand: (taskId: string) => void;
  onJumpToTask: (taskId: string) => void;
  onChangeDispatchBot: (taskId: string, agentId: string) => void;
  onDispatch: (taskId: string, agentId?: string) => void;
  onVerify: (taskId: string) => void;
  onMerge: (taskId: string) => void;
  onSelectBot?: (agentId: string) => void;
  onOpenBrowserItem?: TodoBoardViewProps["onOpenBrowserItem"];
}

function TodoRow({
  project,
  task,
  rowIndex,
  expanded,
  highlighted,
  assignedBot,
  taskById,
  dependentCount,
  latestVerification,
  dispatchCandidates,
  allProjectBots,
  selectedDispatchBotId,
  pendingOp,
  disabled,
  onToggleExpand,
  onJumpToTask,
  onChangeDispatchBot,
  onDispatch,
  onVerify,
  onMerge,
  onSelectBot,
  onOpenBrowserItem,
}: TodoRowProps): JSX.Element {
  const statusMeta = STATUS_META[task.status];
  const assignedMeta = assignedBot ? resolveBotRole(assignedBot) : null;
  const deps = (task.dependsOn ?? []).map((id) => ({ id, depTask: taskById.get(id) ?? null }));
  const unmetDeps = deps.filter((d) => !d.depTask || !isDoneStatus(d.depTask.status));
  const canDispatch = (task.status === "ready" || task.status === "backlog") && unmetDeps.length === 0;
  const canVerify = task.status === "in_review" || task.status === "blocked" || task.status === "verified";
  const canMerge = task.status === "verified";
  const suggestedIdleBot = dispatchCandidates[0] ?? null;
  const handoffPath = task.handoffPath;

  const rowClasses = [
    "todo-board-row",
    expanded ? "is-expanded" : "",
    highlighted ? "is-highlight" : "",
    task.status === "merged" ? "is-merged" : "",
    task.status === "verified" ? "is-verified" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const priorityClass =
    task.priority <= 1
      ? "is-p1"
      : task.priority === 2
        ? "is-p2"
        : task.priority >= 4
          ? "is-p4"
          : "";

  const verChipTone =
    latestVerification?.verdict === "pass"
      ? "success"
      : latestVerification?.verdict === "fail"
        ? "danger"
        : "warning";

  const verChipLabel =
    latestVerification?.verdict === "pass"
      ? "PASS"
      : latestVerification?.verdict === "fail"
        ? "FAIL"
        : "NEEDS HUMAN";

  return (
    <div
      id={`todo-row-${task.id}`}
      className={rowClasses}
      style={{ animationDelay: `${Math.min(rowIndex, 10) * 24}ms` }}
    >
      <div className="todo-board-row-main">
        <div className="todo-board-row-left">
          <button
            type="button"
            className="todo-board-chevron-btn"
            onClick={() => onToggleExpand(task.id)}
            aria-label={expanded ? `Collapse ${task.title}` : `Expand ${task.title}`}
            aria-expanded={expanded}
          >
            <ChevronRight
              size={14}
              strokeWidth={1.8}
              className={`todo-board-chevron-icon ${expanded ? "is-open" : ""}`.trim()}
            />
          </button>

          <TaskStatusIndicator
            status={task.status}
            expanded={expanded}
            onClick={() => onToggleExpand(task.id)}
          />

          <button
            type="button"
            className="todo-board-title-btn"
            onClick={() => onToggleExpand(task.id)}
            title={task.title}
          >
            <span className="todo-board-title-text">{task.title}</span>
          </button>

          {task.sourceAnnotationId && (
            <span className="todo-board-pill is-accent" title={`Created from annotation ${task.sourceAnnotationId}`}>
              Annotation
            </span>
          )}
        </div>

        <div className="todo-board-row-meta">
          {unmetDeps.length > 0 ? (
            <span
              className="todo-board-pill is-warning"
              title={`Waiting on ${unmetDeps.length} prerequisite task${unmetDeps.length === 1 ? "" : "s"}`}
            >
              <Lock size={10} strokeWidth={1.8} />
              <span>
                Blocked by {unmetDeps.length} dep{unmetDeps.length === 1 ? "" : "s"}
              </span>
            </span>
          ) : deps.length > 0 ? (
            <span className="todo-board-pill is-success" title="All prerequisite dependencies satisfied">
              <Check size={10} strokeWidth={2} />
              <span>{deps.length} dep{deps.length === 1 ? "" : "s"}</span>
            </span>
          ) : null}

          {latestVerification && (
            <span
              className={`todo-board-pill ${toneClass(verChipTone)}`.trim()}
              title={`Latest verification (${latestVerification.verifierProvider}/${latestVerification.verifierModel}): ${latestVerification.verdict}`}
            >
              <ShieldCheck size={10} strokeWidth={1.8} />
              <span>{verChipLabel}</span>
            </span>
          )}

          {assignedBot && assignedMeta ? (
            <button
              type="button"
              className="todo-board-bot-pill"
              disabled={!onSelectBot}
              onClick={() => onSelectBot?.(assignedBot.id)}
              title={
                onSelectBot
                  ? `Open chat with ${assignedBot.name} (${assignedMeta.jobTitle})`
                  : `${assignedBot.name} · ${assignedMeta.jobTitle}`
              }
            >
              <BotAvatar
                role={assignedMeta.role}
                size={24}
                active={task.status === "claimed" || assignedBot.status === "working"}
              />
              <span className="todo-board-bot-name">{assignedBot.name}</span>
            </button>
          ) : (
            <span className="todo-board-pill" style={{ color: "var(--ink-faint)" }}>
              Unassigned
            </span>
          )}

          <span className={`todo-board-priority ${priorityClass}`.trim()}>P{task.priority}</span>

          <span className={`todo-board-pill ${toneClass(statusMeta.tone)}`.trim()}>{statusMeta.label}</span>

          {canDispatch && (
            <button
              type="button"
              className="todo-board-btn is-xs is-primary"
              disabled={disabled}
              onClick={() => onDispatch(task.id, selectedDispatchBotId || undefined)}
              title={
                selectedDispatchBotId
                  ? "Dispatch to selected bot"
                  : suggestedIdleBot
                    ? `Dispatch to ${suggestedIdleBot.name} (auto)`
                    : "Auto-assign / spawn peer bot"
              }
            >
              <Play size={10} strokeWidth={1.9} />
              <span>{pendingOp === "dispatch" ? "Dispatching…" : "Dispatch"}</span>
            </button>
          )}

          {(task.status === "in_review" || task.status === "blocked") && (
            <button
              type="button"
              className="todo-board-btn is-xs is-accent"
              disabled={disabled}
              onClick={() => onVerify(task.id)}
              title="Run independent cross-family verification"
            >
              <ShieldCheck size={10} strokeWidth={1.9} />
              <span>{pendingOp === "verify" ? "Verifying…" : "Verify"}</span>
            </button>
          )}

          {canMerge && (
            <button
              type="button"
              className="todo-board-btn is-xs is-success"
              disabled={disabled}
              onClick={() => onMerge(task.id)}
              title="Merge verified branch into main"
            >
              <GitMerge size={10} strokeWidth={1.9} />
              <span>{pendingOp === "merge" ? "Merging…" : "Merge"}</span>
            </button>
          )}
        </div>
      </div>

      {/* Expandable Details Drawer */}
      <div className={`todo-board-drawer-wrap ${expanded ? "is-open" : ""}`.trim()}>
        <div className="todo-board-drawer-inner">
          {expanded && (
            <div className="todo-board-drawer-body">
              <div className="todo-board-spec-box">
                {task.specMd.trim() ? (
                  <MarkdownRenderer content={task.specMd} />
                ) : (
                  <span className="todo-board-spec-empty">No markdown specification provided.</span>
                )}
              </div>

              {(deps.length > 0 || dependentCount > 0) && (
                <div className="todo-board-deps-row">
                  {deps.length > 0 && (
                    <>
                      <span className="todo-board-deps-label">Prerequisites:</span>
                      {deps.map((d) => {
                        const met = Boolean(d.depTask && isDoneStatus(d.depTask.status));
                        return (
                          <button
                            key={d.id}
                            type="button"
                            className={`todo-board-dep-btn ${met ? "is-met" : "is-unmet"}`.trim()}
                            onClick={() => d.depTask && onJumpToTask(d.depTask.id)}
                            disabled={!d.depTask}
                            title={
                              d.depTask
                                ? `Jump to ${d.depTask.title} (${d.depTask.status})`
                                : `Missing prerequisite ${d.id}`
                            }
                          >
                            {met ? <Check size={10} strokeWidth={2} /> : <Lock size={10} strokeWidth={1.8} />}
                            <span>{d.depTask?.title ?? d.id}</span>
                            <span style={{ opacity: 0.72 }}>[{d.depTask?.status ?? "missing"}]</span>
                          </button>
                        );
                      })}
                    </>
                  )}
                  {dependentCount > 0 && (
                    <span className="todo-board-pill">
                      Blocks {dependentCount} downstream todo{dependentCount === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
              )}

              {latestVerification && (
                <div className="todo-board-verify-box">
                  <div className="todo-board-verify-head">
                    <span className={`todo-board-pill ${toneClass(verChipTone)}`.trim()}>
                      <ShieldCheck size={11} strokeWidth={1.8} />
                      <span>Verification: {verChipLabel}</span>
                    </span>
                    <div className="todo-board-verify-meta">
                      <span>
                        {latestVerification.verifierProvider}/{latestVerification.verifierModel}
                      </span>
                      {latestVerification.crossFamily && <span>· cross-family</span>}
                      {latestVerification.checks.length > 0 && (
                        <span>
                          · {latestVerification.checks.filter((c) => c.passed).length}/
                          {latestVerification.checks.length} checks passed
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="todo-board-verify-summary">{latestVerification.summary}</div>
                  {latestVerification.findings.length > 0 && (
                    <ul className="todo-board-findings">
                      {latestVerification.findings.map((finding, idx) => (
                        <li key={`${latestVerification.id}-f-${idx}`}>{finding}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="todo-board-drawer-actions">
                <div className="todo-board-action-group">
                  {(task.status === "ready" || task.status === "backlog") &&
                    (unmetDeps.length === 0 ? (
                      <>
                        <select
                          className="todo-board-select"
                          aria-label={`Select bot for ${task.title}`}
                          value={selectedDispatchBotId}
                          disabled={disabled}
                          onChange={(e) => onChangeDispatchBot(task.id, e.target.value)}
                        >
                          <option value="">
                            {suggestedIdleBot
                              ? `Auto (suggest: ${suggestedIdleBot.name})`
                              : "Auto / Spawn Peer Bot"}
                          </option>
                          {allProjectBots
                            .filter((b) => b.scope === "peer" || b.scope === "sidekick")
                            .map((bot) => {
                              const avail = isDispatchablePeer(bot);
                              return (
                                <option key={bot.id} value={bot.id} disabled={!avail}>
                                  {bot.name} ({bot.status} · {bot.model})
                                </option>
                              );
                            })}
                        </select>
                        <button
                          type="button"
                          className="todo-board-btn is-primary"
                          disabled={disabled}
                          onClick={() => onDispatch(task.id, selectedDispatchBotId || undefined)}
                        >
                          <Play size={12} strokeWidth={1.8} />
                          <span>{pendingOp === "dispatch" ? "Dispatching…" : "Dispatch"}</span>
                        </button>
                      </>
                    ) : (
                      <button type="button" className="todo-board-btn" disabled>
                        <Lock size={12} strokeWidth={1.8} />
                        <span>
                          Waiting on {unmetDeps.length} dep{unmetDeps.length === 1 ? "" : "s"}
                        </span>
                      </button>
                    ))}

                  {task.status === "claimed" && (
                    <button
                      type="button"
                      className="todo-board-btn"
                      disabled
                      title="Verification unlocks once the bot submits work for review"
                    >
                      <ShieldCheck size={12} strokeWidth={1.8} />
                      <span>Verify (Awaiting Review)</span>
                    </button>
                  )}

                  {canVerify && (
                    <button
                      type="button"
                      className={`todo-board-btn ${task.status === "verified" ? "" : "is-accent"}`.trim()}
                      disabled={disabled}
                      onClick={() => onVerify(task.id)}
                    >
                      <ShieldCheck size={12} strokeWidth={1.8} />
                      <span>
                        {pendingOp === "verify"
                          ? "Verifying…"
                          : task.status === "verified"
                            ? "Re-Verify"
                            : "Verify"}
                      </span>
                    </button>
                  )}

                  {canMerge && (
                    <button
                      type="button"
                      className="todo-board-btn is-success"
                      disabled={disabled}
                      onClick={() => onMerge(task.id)}
                    >
                      <GitMerge size={12} strokeWidth={1.8} />
                      <span>{pendingOp === "merge" ? "Merging…" : "Merge to Main"}</span>
                    </button>
                  )}

                  {handoffPath && onOpenBrowserItem && (
                    <button
                      type="button"
                      className="todo-board-btn"
                      onClick={() =>
                        onOpenBrowserItem(
                          project.id,
                          "doc",
                          handoffPath,
                          handoffPath.split("/").pop() ?? "Handoff",
                        )
                      }
                    >
                      <FileText size={12} strokeWidth={1.8} />
                      <span>View Handoff</span>
                    </button>
                  )}

                  {assignedBot && onSelectBot && (
                    <button
                      type="button"
                      className="todo-board-btn is-ghost"
                      onClick={() => onSelectBot(assignedBot.id)}
                    >
                      <MessageSquare size={12} strokeWidth={1.8} />
                      <span>Open {assignedBot.name}</span>
                    </button>
                  )}
                </div>

                {task.worktreeBranch && (
                  <span className="todo-board-branch-tag" title={`Worktree branch: ${task.worktreeBranch}`}>
                    <GitBranch size={10} strokeWidth={1.7} style={{ marginRight: 4, verticalAlign: "middle" }} />
                    {task.worktreeBranch}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function TodoBoardView(props: TodoBoardViewProps): JSX.Element {
  const {
    project,
    tasks,
    agents,
    goals,
    verifications,
    busyAction = false,
    onCreateTask,
    onDispatchTask,
    onVerifyTask,
    onMergeTask,
    onSelectBot,
    onOpenBrowserItem,
  } = props;

  const [viewMode, setViewMode] = useState<TodoViewMode>("all");
  const [filterMode, setFilterMode] = useState<TodoFilterMode>("all");

  // Quick-add state
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<number>(3);
  const [quickBotId, setQuickBotId] = useState<string>("");
  const [specMd, setSpecMd] = useState("");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [showSpecDrawer, setShowSpecDrawer] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Row & group interaction state
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [completedOpenOverride, setCompletedOpenOverride] = useState<boolean | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [dispatchBotByTask, setDispatchBotByTask] = useState<Record<string, string>>({});
  const [pendingByTask, setPendingByTask] = useState<Record<string, PendingTaskOp>>({});
  const [highlightedTaskId, setHighlightedTaskId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevProjectIdRef = useRef(project.id);

  useEffect(() => {
    if (prevProjectIdRef.current === project.id) return;
    prevProjectIdRef.current = project.id;
    setTitle("");
    setPriority(3);
    setQuickBotId("");
    setSpecMd("");
    setDependsOn([]);
    setShowSpecDrawer(false);
    setExpandedIds(new Set());
    setCompletedOpenOverride(null);
    setCollapsedSections({});
    setDispatchBotByTask({});
    setHighlightedTaskId(null);
    setLocalError(null);
  }, [project.id]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  const projectAgents = useMemo(
    () => agents.filter((a) => a.projectId === project.id),
    [agents, project.id],
  );

  const agentById = useMemo(() => {
    const map = new Map<string, AgentRecord>();
    for (const a of agents) map.set(a.id, a);
    return map;
  }, [agents]);

  const dispatchCandidates = useMemo(
    () => projectAgents.filter((a) => isDispatchablePeer(a)),
    [projectAgents],
  );

  const taskById = useMemo(() => {
    const map = new Map<string, TaskRecord>();
    for (const t of tasks) map.set(t.id, t);
    return map;
  }, [tasks]);

  const quickHasUnmetDeps = useMemo(
    () =>
      dependsOn.some((depId) => {
        const dep = taskById.get(depId);
        return !dep || !isDoneStatus(dep.status);
      }),
    [dependsOn, taskById],
  );

  const dependentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tasks) {
      for (const depId of t.dependsOn ?? []) {
        counts.set(depId, (counts.get(depId) ?? 0) + 1);
      }
    }
    return counts;
  }, [tasks]);

  const latestVerificationByTask = useMemo(() => {
    const map = new Map<string, VerificationReportRecord>();
    for (const v of verifications) {
      if (v.targetKind !== "task") continue;
      const existing = map.get(v.targetId);
      if (!existing || v.createdAt > existing.createdAt) {
        map.set(v.targetId, v);
      }
    }
    return map;
  }, [verifications]);

  const activeGoal = useMemo(
    () => goals.find((g) => g.status === "active") ?? goals[0] ?? null,
    [goals],
  );

  const stats = useMemo(() => {
    let done = 0;
    let active = 0;
    let review = 0;
    let running = 0;
    for (const t of tasks) {
      if (isDoneStatus(t.status)) done += 1;
      if (t.status === "backlog" || t.status === "ready" || t.status === "claimed") active += 1;
      if (t.status === "in_review" || t.status === "blocked") review += 1;
      if (t.status === "claimed") running += 1;
    }
    const total = tasks.length;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    return { total, done, active, review, running, pct, allDone: total > 0 && done === total };
  }, [tasks]);

  const filteredTasks = useMemo(
    () => sortTasks(tasks.filter((t) => matchesFilter(t, filterMode))),
    [tasks, filterMode],
  );

  const openTasks = useMemo(
    () => filteredTasks.filter((t) => !isDoneStatus(t.status)),
    [filteredTasks],
  );

  const completedTasks = useMemo(
    () => filteredTasks.filter((t) => isDoneStatus(t.status)),
    [filteredTasks],
  );

  const isCompletedOpen =
    filterMode === "done"
      ? true
      : (completedOpenOverride ?? completedTasks.length <= 3);

  const botGroups = useMemo(() => {
    const byBotId = new Map<string, TaskRecord[]>();
    const unassigned: TaskRecord[] = [];
    for (const t of filteredTasks) {
      if (t.assignedAgentId && agentById.has(t.assignedAgentId)) {
        const list = byBotId.get(t.assignedAgentId) ?? [];
        list.push(t);
        byBotId.set(t.assignedAgentId, list);
      } else {
        unassigned.push(t);
      }
    }

    const groups: Array<{ key: string; bot: AgentRecord | null; tasks: TaskRecord[] }> = [];
    if (unassigned.length > 0) {
      groups.push({ key: "__unassigned__", bot: null, tasks: unassigned });
    }

    const seen = new Set<string>();
    for (const bot of projectAgents) {
      const botTasks = byBotId.get(bot.id) ?? [];
      if (botTasks.length > 0 || (filterMode === "all" && (bot.scope === "peer" || bot.scope === "sidekick"))) {
        groups.push({ key: bot.id, bot, tasks: botTasks });
        seen.add(bot.id);
      }
    }

    for (const [botId, list] of byBotId.entries()) {
      if (!seen.has(botId)) {
        groups.push({ key: botId, bot: agentById.get(botId) ?? null, tasks: list });
      }
    }

    return groups;
  }, [filteredTasks, agentById, projectAgents, filterMode]);

  const statusGroups = useMemo(
    () =>
      STATUS_GROUPS.map((group) => ({
        ...group,
        tasks: filteredTasks.filter((t) => group.statuses.includes(t.status)),
      })).filter((g) => g.tasks.length > 0),
    [filteredTasks],
  );

  const toggleExpand = (taskId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const jumpToTask = (taskId: string) => {
    setExpandedIds((prev) => new Set(prev).add(taskId));
    setHighlightedTaskId(taskId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedTaskId(null), 1600);
    const el = document.getElementById(`todo-row-${taskId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const toggleDependency = (depId: string) => {
    setDependsOn((prev) => (prev.includes(depId) ? prev.filter((id) => id !== depId) : [...prev, depId]));
  };

  const toggleSection = (key: string) => {
    setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleQuickAdd = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busyAction || submitting) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      await onCreateTask({
        title: trimmed,
        specMd: specMd.trim() || trimmed,
        priority,
        dependsOn,
        ...(quickBotId ? { assignedAgentId: quickBotId } : {}),
      });
      setTitle("");
      setPriority(3);
      setQuickBotId("");
      setSpecMd("");
      setDependsOn([]);
      setShowSpecDrawer(false);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const runTaskOp = async (taskId: string, op: PendingTaskOp, fn: () => Promise<void>) => {
    if (busyAction || pendingByTask[taskId]) return;
    setPendingByTask((prev) => ({ ...prev, [taskId]: op }));
    setLocalError(null);
    try {
      await fn();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingByTask((prev) => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
    }
  };

  const renderTaskRow = (task: TaskRecord, index: number) => {
    const assignedBot = task.assignedAgentId ? agentById.get(task.assignedAgentId) ?? null : null;
    const pendingOp = pendingByTask[task.id] ?? null;
    return (
      <TodoRow
        key={task.id}
        project={project}
        task={task}
        rowIndex={index}
        expanded={expandedIds.has(task.id)}
        highlighted={highlightedTaskId === task.id}
        assignedBot={assignedBot}
        taskById={taskById}
        dependentCount={dependentCounts.get(task.id) ?? 0}
        latestVerification={latestVerificationByTask.get(task.id) ?? null}
        dispatchCandidates={dispatchCandidates}
        allProjectBots={projectAgents}
        selectedDispatchBotId={dispatchBotByTask[task.id] ?? ""}
        pendingOp={pendingOp}
        disabled={busyAction || pendingOp !== null}
        onToggleExpand={toggleExpand}
        onJumpToTask={jumpToTask}
        onChangeDispatchBot={(id, agentId) =>
          setDispatchBotByTask((prev) => ({ ...prev, [id]: agentId }))
        }
        onDispatch={(id, agentId) =>
          void runTaskOp(id, "dispatch", () => onDispatchTask(id, agentId))
        }
        onVerify={(id) => void runTaskOp(id, "verify", () => onVerifyTask(id))}
        onMerge={(id) => void runTaskOp(id, "merge", () => onMergeTask(id))}
        onSelectBot={onSelectBot}
        onOpenBrowserItem={onOpenBrowserItem}
      />
    );
  };

  return (
    <div className="todo-board-root">
      {localError && (
        <div className="todo-board-error" role="alert">
          <span className="todo-board-error-text">
            <AlertCircle size={13} strokeWidth={1.7} />
            <span>{localError}</span>
          </span>
          <button
            type="button"
            className="todo-board-btn is-xs is-ghost"
            onClick={() => setLocalError(null)}
            aria-label="Dismiss error"
          >
            <X size={12} strokeWidth={1.8} />
          </button>
        </div>
      )}

      {/* Animated Progress Header */}
      <header className="todo-board-header">
        <div className="todo-board-header-top">
          <div className="todo-board-goal-block">
            <div className="todo-board-goal-eyebrow">
              <Target size={12} strokeWidth={1.8} color="var(--accent-orange)" />
              {activeGoal ? (
                <>
                  <span className={`todo-board-goal-chip is-${activeGoal.status}`}>
                    Goal · {activeGoal.status}
                  </span>
                  {goals.length > 1 && <span>{goals.length} project goals</span>}
                </>
              ) : (
                <span>{project.name} · All-Bots Todo Queue</span>
              )}
            </div>
            <h2 className="todo-board-goal-title" title={activeGoal?.goal ?? project.name}>
              {activeGoal ? activeGoal.goal : `${project.name} Todos`}
            </h2>
          </div>

          <div className="todo-board-stats-col">
            <div className={`todo-board-ratio ${stats.allDone ? "is-complete" : ""}`.trim()}>
              {stats.allDone && <Sparkles size={13} strokeWidth={1.8} />}
              <span>
                {stats.done} / {stats.total} done
              </span>
              <span className="todo-board-pct">{stats.pct}%</span>
            </div>
            <div className="todo-board-mini-counts">
              <span>{stats.running} running</span>
              <span>·</span>
              <span>{stats.review} review</span>
              <span>·</span>
              <span>{stats.active} active</span>
            </div>
          </div>
        </div>

        <div
          className="todo-board-progress-track"
          role="progressbar"
          aria-valuenow={stats.pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Todo completion progress"
        >
          <div
            className={`todo-board-progress-fill ${stats.allDone ? "is-complete" : ""}`.trim()}
            style={{ width: `${stats.pct}%` }}
          />
        </div>

        {/* View Mode Switcher + Filter Pills */}
        <div className="todo-board-toolbar">
          <div className="todo-board-segmented" role="tablist" aria-label="Todo board grouping">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "all"}
              className={`todo-board-tab ${viewMode === "all" ? "is-active" : ""}`.trim()}
              onClick={() => setViewMode("all")}
            >
              <ListChecks size={12} strokeWidth={1.8} />
              <span>All</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "by_bot"}
              className={`todo-board-tab ${viewMode === "by_bot" ? "is-active" : ""}`.trim()}
              onClick={() => setViewMode("by_bot")}
            >
              <Users size={12} strokeWidth={1.8} />
              <span>By Bot</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "by_status"}
              className={`todo-board-tab ${viewMode === "by_status" ? "is-active" : ""}`.trim()}
              onClick={() => setViewMode("by_status")}
            >
              <Layers size={12} strokeWidth={1.8} />
              <span>By Status</span>
            </button>
          </div>

          <div className="todo-board-filters">
            {FILTER_OPTIONS.map((opt) => {
              const count =
                opt.id === "all"
                  ? stats.total
                  : opt.id === "active"
                    ? stats.active
                    : opt.id === "review"
                      ? stats.review
                      : stats.done;
              return (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={filterMode === opt.id}
                  className={`todo-board-filter-pill ${filterMode === opt.id ? "is-active" : ""}`.trim()}
                  onClick={() => setFilterMode(opt.id)}
                >
                  <span>{opt.label}</span>
                  <span className="todo-board-filter-count">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* Sleek Inline Quick-Add Bar */}
      <form className="todo-board-quickadd" onSubmit={(e) => void handleQuickAdd(e)}>
        <div className="todo-board-quickadd-row">
          <span className="todo-board-quickadd-icon" aria-hidden="true">
            <Plus size={12} strokeWidth={2} />
          </span>

          <input
            type="text"
            className="todo-board-quickadd-input"
            data-testid="todo-quick-add-input"
            aria-label="Add a todo for the bots"
            placeholder="Add a todo for the bots..."
            value={title}
            disabled={busyAction || submitting}
            onChange={(e) => setTitle(e.target.value)}
          />

          <select
            className="todo-board-select"
            aria-label="Todo priority"
            value={priority}
            disabled={busyAction || submitting}
            onChange={(e) => setPriority(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5].map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>

          <select
            className="todo-board-select"
            aria-label="Assign bot"
            value={quickBotId}
            disabled={busyAction || submitting}
            onChange={(e) => setQuickBotId(e.target.value)}
            title="Optional bot assignee"
          >
            <option value="">Auto / Any Peer</option>
            {projectAgents
              .filter((a) => a.scope === "peer" || a.scope === "sidekick")
              .map((bot) => (
                <option key={bot.id} value={bot.id} disabled={!isDispatchablePeer(bot)}>
                  {bot.name} ({bot.status})
                </option>
              ))}
          </select>

          <button
            type="button"
            className="todo-board-btn"
            onClick={() => setShowSpecDrawer((v) => !v)}
            aria-expanded={showSpecDrawer}
          >
            <span>Spec &amp; DAG</span>
            {(dependsOn.length > 0 || specMd.trim().length > 0) && (
              <span className="todo-board-section-count">
                {dependsOn.length > 0 ? dependsOn.length : "1"}
              </span>
            )}
          </button>

          <button
            type="submit"
            className="todo-board-btn is-accent"
            disabled={busyAction || submitting || !title.trim()}
          >
            <Plus size={13} strokeWidth={2} />
            <span>
              {submitting
                ? "Adding…"
                : quickBotId && !quickHasUnmetDeps
                  ? "Add & Dispatch"
                  : "Add Todo"}
            </span>
          </button>
        </div>

        {showSpecDrawer && (
          <div className="todo-board-quickadd-drawer">
            <textarea
              className="todo-board-textarea"
              rows={3}
              aria-label="Todo specification markdown"
              placeholder="Markdown specification, acceptance criteria, or file hints (optional)..."
              value={specMd}
              disabled={busyAction || submitting}
              onChange={(e) => setSpecMd(e.target.value)}
            />
            {tasks.length > 0 && (
              <div className="todo-board-dag-picker">
                <span className="todo-board-dag-label">
                  Blocking prerequisites (selected: {dependsOn.length})
                </span>
                <div className="todo-board-dag-chips">
                  {tasks.map((candidate) => {
                    const selected = dependsOn.includes(candidate.id);
                    return (
                      <button
                        key={candidate.id}
                        type="button"
                        className={`todo-board-dag-chip ${selected ? "is-selected" : ""}`.trim()}
                        onClick={() => toggleDependency(candidate.id)}
                      >
                        {selected && <Check size={10} strokeWidth={2.2} />}
                        <span>{candidate.title}</span>
                        <span style={{ opacity: 0.72 }}>[{candidate.status}]</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </form>

      {/* Main Content */}
      {tasks.length === 0 ? (
        <div className="todo-board-empty">
          <CheckCircle2 size={24} strokeWidth={1.5} color="var(--ink-faint)" />
          <div className="todo-board-empty-title">No todos in {project.name} yet</div>
          <p className="todo-board-empty-sub">
            Add a todo above to queue work for the Bear crew, or steer the Team Lead in Group Chat to
            decompose a goal automatically.
          </p>
        </div>
      ) : filteredTasks.length === 0 ? (
        <div className="todo-board-empty">
          <div className="todo-board-empty-title">No matching todos for "{filterMode}"</div>
          <p className="todo-board-empty-sub">
            Switch filters to view active, review, or completed items.
          </p>
          <button
            type="button"
            className="todo-board-btn"
            onClick={() => setFilterMode("all")}
          >
            Show all todos
          </button>
        </div>
      ) : (
        <div className="todo-board-list-stack">
          {viewMode === "all" && (
            <>
              {filterMode !== "done" && openTasks.length > 0 && (
                <section className="todo-board-section" aria-label="Open todos">
                  <div className="todo-board-section-head">
                    <span className="todo-board-section-meta" style={{ fontWeight: 600, color: "var(--ink-secondary)" }}>
                      <span>Active &amp; Queued</span>
                      <span className="todo-board-section-count">{openTasks.length}</span>
                    </span>
                  </div>
                  <div className="todo-board-rows-card">
                    {openTasks.map((task, idx) => renderTaskRow(task, idx))}
                  </div>
                </section>
              )}

              {filterMode !== "done" && openTasks.length === 0 && completedTasks.length > 0 && (
                <div className="todo-board-empty" style={{ padding: "18px 16px" }}>
                  <Sparkles size={18} strokeWidth={1.6} color="var(--status-success-ink)" />
                  <div className="todo-board-empty-title">All open todos are completed!</div>
                </div>
              )}

              {completedTasks.length > 0 && filterMode !== "active" && filterMode !== "review" && (
                <section className="todo-board-section" aria-label="Completed todos">
                  <div className="todo-board-section-head">
                    <button
                      type="button"
                      className="todo-board-section-toggle"
                      aria-expanded={isCompletedOpen}
                      onClick={() => setCompletedOpenOverride(!isCompletedOpen)}
                    >
                      <ChevronRight
                        size={13}
                        strokeWidth={2}
                        className={`todo-board-section-chevron ${isCompletedOpen ? "is-open" : ""}`.trim()}
                      />
                      <span>Completed ({completedTasks.length})</span>
                    </button>
                  </div>
                  {isCompletedOpen && (
                    <div className="todo-board-rows-card">
                      {completedTasks.map((task, idx) => renderTaskRow(task, idx))}
                    </div>
                  )}
                </section>
              )}
            </>
          )}

          {viewMode === "by_bot" &&
            botGroups.map((group) => {
              const sectionKey = `bot:${group.key}`;
              const isCollapsed = Boolean(collapsedSections[sectionKey]);
              const groupBot = group.bot;
              const meta = groupBot ? resolveBotRole(groupBot) : null;
              const doneInGroup = group.tasks.filter((t) => isDoneStatus(t.status)).length;
              return (
                <section key={sectionKey} className="todo-board-section">
                  <div className="todo-board-section-head">
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <button
                        type="button"
                        className="todo-board-section-toggle"
                        aria-expanded={!isCollapsed}
                        onClick={() => toggleSection(sectionKey)}
                      >
                        <ChevronRight
                          size={13}
                          strokeWidth={2}
                          className={`todo-board-section-chevron ${!isCollapsed ? "is-open" : ""}`.trim()}
                        />
                        {!groupBot && <span>Unassigned Queue</span>}
                      </button>

                      {groupBot && meta && (
                        <button
                          type="button"
                          className="todo-board-group-bot-btn"
                          disabled={!onSelectBot}
                          onClick={() => onSelectBot?.(groupBot.id)}
                        >
                          <BotAvatar
                            role={meta.role}
                            size={24}
                            active={groupBot.status === "working" || groupBot.status === "debating"}
                          />
                          <span>{groupBot.name}</span>
                          <JobTitlePill label={meta.jobTitle} />
                        </button>
                      )}

                      <span className="todo-board-section-count">
                        {doneInGroup}/{group.tasks.length}
                      </span>
                    </div>

                    {groupBot && (
                      <span className="todo-board-section-meta">
                        <span className="todo-board-pill">{groupBot.status}</span>
                      </span>
                    )}
                  </div>

                  {!isCollapsed && (
                    <div className="todo-board-rows-card">
                      {group.tasks.length === 0 ? (
                        <div className="todo-board-bot-empty-hint">
                          No todos assigned to {groupBot?.name ?? "this bot"} right now.
                        </div>
                      ) : (
                        group.tasks.map((task, idx) => renderTaskRow(task, idx))
                      )}
                    </div>
                  )}
                </section>
              );
            })}

          {viewMode === "by_status" &&
            statusGroups.map((group) => {
              const sectionKey = `status:${group.id}`;
              const isCollapsed = Boolean(collapsedSections[sectionKey]);
              return (
                <section key={sectionKey} className="todo-board-section">
                  <div className="todo-board-section-head">
                    <button
                      type="button"
                      className="todo-board-section-toggle"
                      aria-expanded={!isCollapsed}
                      onClick={() => toggleSection(sectionKey)}
                    >
                      <ChevronRight
                        size={13}
                        strokeWidth={2}
                        className={`todo-board-section-chevron ${!isCollapsed ? "is-open" : ""}`.trim()}
                      />
                      <StatusDot status={group.sampleStatus} />
                      <span>{group.label}</span>
                      <span className="todo-board-section-count">{group.tasks.length}</span>
                    </button>
                  </div>
                  {!isCollapsed && (
                    <div className="todo-board-rows-card">
                      {group.tasks.map((task, idx) => renderTaskRow(task, idx))}
                    </div>
                  )}
                </section>
              );
            })}
        </div>
      )}
    </div>
  );
}
