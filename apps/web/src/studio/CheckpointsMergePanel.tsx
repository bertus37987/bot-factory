import type {
  AgentRecord,
  CheckpointRecord,
  ProjectRecord,
  TaskRecord,
  VerificationReportRecord,
} from "@bot-factory/shared";
import {
  AlertTriangle,
  CheckCircle2,
  GitBranch,
  GitMerge,
  History,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import type { RpcCommandInput } from "../client/useBotFactory";
import { BotAvatar, resolveBotRole } from "../components/BotAvatars";
import { BotThinkingOrb } from "../components/BotThinkingOrb";

export interface CheckpointsMergePanelProps {
  project: ProjectRecord | null;
  agents: AgentRecord[];
  tasks: TaskRecord[];
  checkpoints: CheckpointRecord[];
  verifications: VerificationReportRecord[];
  onRefreshCheckpoints: (projectId: string, agentId?: string) => Promise<CheckpointRecord[]>;
  onSendCommand: <T = unknown>(cmd: RpcCommandInput) => Promise<T>;
  onOpenDiff: (agentId?: string | null) => void;
  onNotifyError: (msg: string) => void;
}

function formatTs(ts: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch {
    return "";
  }
}

export function CheckpointsMergePanel({
  project,
  agents,
  tasks,
  checkpoints,
  verifications,
  onRefreshCheckpoints,
  onSendCommand,
  onOpenDiff,
  onNotifyError,
}: CheckpointsMergePanelProps): JSX.Element {
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [confirmRollbackId, setConfirmRollbackId] = useState<string | null>(null);
  const [commitMessages, setCommitMessages] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<{ taskId: string; message: string; conflicts: string[] } | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  useEffect(() => {
    setSelectedAgentId("");
    setConfirmRollbackId(null);
    setMergeError(null);
    setStatusBanner(null);
  }, [project?.id]);

  useEffect(() => {
    if (!project) return;
    void onRefreshCheckpoints(project.id, selectedAgentId || undefined).catch((err) => {
      onNotifyError(err instanceof Error ? err.message : String(err));
    });
  }, [project?.id, selectedAgentId, onRefreshCheckpoints, onNotifyError]);

  const agentMap = useMemo(() => {
    const map = new Map<string, AgentRecord>();
    for (const a of agents) map.set(a.id, a);
    return map;
  }, [agents]);

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

  const verifiedTasks = useMemo(() => tasks.filter((t) => t.status === "verified"), [tasks]);
  const mergedTasks = useMemo(() => tasks.filter((t) => t.status === "merged"), [tasks]);

  const filteredCheckpoints = useMemo(() => {
    const list = selectedAgentId ? checkpoints.filter((c) => c.agentId === selectedAgentId) : checkpoints;
    return [...list].sort((a, b) => b.createdAt - a.createdAt || b.turnNum - a.turnNum);
  }, [checkpoints, selectedAgentId]);

  if (!project) {
    return (
      <div className="bots-empty-state">
        <div className="bots-empty-title">No Project Selected</div>
        <p className="bots-empty-sub">
          Select or create a project to manage verified branch merges and per-turn Git checkpoints.
        </p>
      </div>
    );
  }

  const handleMerge = async (task: TaskRecord, strategy: "squash" | "merge_commit") => {
    if (busyKey) return;
    setBusyKey(`merge-${task.id}`);
    setMergeError(null);
    setStatusBanner(null);
    try {
      const customMsg = commitMessages[task.id]?.trim();
      const result = await onSendCommand<{
        queued?: boolean;
        ok?: boolean;
        error?: string;
        conflicts?: string[];
      }>({
        type: "task.merge",
        projectId: project.id,
        taskId: task.id,
        strategy,
        ...(customMsg ? { commitMessage: customMsg } : {}),
      });
      if (result && result.ok === false) {
        const msg = result.error ?? "Merge failed";
        const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
        setMergeError({ taskId: task.id, message: msg, conflicts });
        onNotifyError(conflicts.length > 0 ? `${msg}: ${conflicts.join(", ")}` : msg);
      } else {
        setStatusBanner(
          `Queued ${strategy === "squash" ? "squash merge" : "merge commit"} for "${task.title}" into main.`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMergeError({ taskId: task.id, message: msg, conflicts: [] });
      onNotifyError(msg);
    } finally {
      setBusyKey(null);
    }
  };

  const handleRollback = async (cp: CheckpointRecord) => {
    if (busyKey) return;
    setBusyKey(`rb-${cp.id}`);
    setStatusBanner(null);
    try {
      await onSendCommand({
        type: "checkpoint.rollback",
        projectId: project.id,
        checkpointId: cp.id,
      });
      setConfirmRollbackId(null);
      setStatusBanner(`Rollback queued to checkpoint #${cp.turnNum} (${cp.commitSha.slice(0, 7)}).`);
      await onRefreshCheckpoints(project.id, selectedAgentId || undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onNotifyError(msg);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="checkpoints-panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {statusBanner && (
        <div
          className="pill success"
          style={{
            padding: "8px 12px",
            borderRadius: "var(--radius-sm)",
            justifyContent: "space-between",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <CheckCircle2 size={13} strokeWidth={1.6} />
            <span>{statusBanner}</span>
          </span>
          <button type="button" className="btn xs ghost" onClick={() => setStatusBanner(null)}>
            <X size={12} strokeWidth={1.6} />
          </button>
        </div>
      )}

      {mergeError && (
        <div className="task-card" style={{ borderColor: "var(--status-danger-border)", background: "var(--status-danger-bg)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: "var(--text-xs)",
                fontWeight: 600,
                color: "var(--status-danger-ink)",
              }}
            >
              <AlertTriangle size={13} strokeWidth={1.6} />
              <span>Merge Conflict / Error: {mergeError.message}</span>
            </span>
            <button type="button" className="btn xs ghost" onClick={() => setMergeError(null)}>
              <X size={12} strokeWidth={1.6} />
            </button>
          </div>
          {mergeError.conflicts.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
              <span style={{ fontSize: "var(--text-2xs)", color: "var(--status-danger-ink)", fontWeight: 500 }}>
                Conflicting files:
              </span>
              {mergeError.conflicts.map((path) => (
                <code
                  key={path}
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--status-danger-ink)",
                    background: "var(--bg-canvas)",
                    padding: "3px 7px",
                    borderRadius: "var(--radius-xs)",
                    border: "1px solid var(--status-danger-border)",
                  }}
                >
                  {path}
                </code>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="phase3-split">
        {/* Left: Verified Task Merge Queue */}
        <div className="kanban-col checkpoints-merge-col">
          <div className="section-eyebrow">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <GitMerge size={14} strokeWidth={1.6} />
              Verified Merge Queue ({verifiedTasks.length})
            </span>
            <span className="mono-tag">target: main</span>
          </div>

          {verifiedTasks.length === 0 ? (
            <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)", padding: "8px 4px", lineHeight: 1.5 }}>
              No verified tasks awaiting merge. Complete and verify a task on the Task Board before merging its
              worktree branch into <code>main</code>.
            </div>
          ) : (
            verifiedTasks.map((t) => {
              const assignee = t.assignedAgentId ? agentMap.get(t.assignedAgentId) ?? null : null;
              const branch = assignee?.worktreeBranch || t.worktreeBranch;
              const ver = latestVerificationByTask.get(t.id);
              const meta = assignee ? resolveBotRole(assignee) : null;
              const isMerging = busyKey === `merge-${t.id}`;
              const canMerge = Boolean(branch && branch !== "main");

              return (
                <div key={t.id} className="task-card checkpoints-merge-card">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: "var(--text-sm)", color: "var(--ink-primary)" }}>
                      {t.title}
                    </span>
                    <span className="pill success">
                      <ShieldCheck size={11} strokeWidth={1.7} />
                      verified
                    </span>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    {assignee && meta && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "var(--text-xs)" }}>
                        <BotAvatar role={meta.role} size={18} />
                        <span>{assignee.name}</span>
                      </span>
                    )}
                    {branch && (
                      <span className="mono-tag">
                        <GitBranch size={10} strokeWidth={1.6} style={{ marginRight: 3, verticalAlign: "middle" }} />
                        {branch}
                      </span>
                    )}
                    {ver && (
                      <span className="mono-tag">
                        {ver.verifierProvider}/{ver.verifierModel}
                        {ver.crossFamily ? " · cross-family" : ""}
                      </span>
                    )}
                  </div>

                  {!canMerge && (
                    <div style={{ fontSize: "var(--text-2xs)", color: "var(--status-warning-ink)" }}>
                      Missing isolated worktree branch for merge.
                    </div>
                  )}

                  <input
                    className="field-input"
                    placeholder={`feat(${project.slug}): ${t.title}`}
                    value={commitMessages[t.id] ?? ""}
                    disabled={busyKey !== null}
                    onChange={(e) => setCommitMessages((prev) => ({ ...prev, [t.id]: e.target.value }))}
                  />

                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={busyKey !== null || !canMerge}
                      onClick={() => void handleMerge(t, "squash")}
                    >
                      {isMerging ? <BotThinkingOrb activity="working" size={20} shell={false} /> : <GitMerge size={12} strokeWidth={1.6} />}
                      <span>Squash Merge</span>
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busyKey !== null || !canMerge}
                      onClick={() => void handleMerge(t, "merge_commit")}
                    >
                      <span>Merge Commit</span>
                    </button>
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => onOpenDiff(t.assignedAgentId)}
                    >
                      <span>View Diff</span>
                    </button>
                  </div>
                </div>
              );
            })
          )}

          {mergedTasks.length > 0 && (
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="section-eyebrow" style={{ padding: "4px 2px 0" }}>
                <span>Recently Merged ({mergedTasks.length})</span>
              </div>
              {mergedTasks.slice(0, 5).map((t) => (
                <div
                  key={t.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "6px 9px",
                    borderRadius: "var(--radius-sm)",
                    border: "var(--hairline)",
                    background: "var(--bg-canvas)",
                    fontSize: "var(--text-xs)",
                  }}
                >
                  <span style={{ color: "var(--ink-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.title}
                  </span>
                  <span className="pill success">merged</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: Hidden Git Checkpoints & Scoped Rollback */}
        <div className="kanban-col checkpoints-history-col">
          <div className="section-eyebrow">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <History size={14} strokeWidth={1.6} />
              Hidden Turn Checkpoints ({filteredCheckpoints.length})
            </span>
            <button
              type="button"
              className="btn xs"
              disabled={busyKey !== null}
              onClick={() =>
                void onRefreshCheckpoints(project.id, selectedAgentId || undefined).catch((err) =>
                  onNotifyError(err instanceof Error ? err.message : String(err)),
                )
              }
            >
              <RefreshCw size={11} strokeWidth={1.6} />
              <span>Refresh</span>
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <select
              className="field-input"
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value)}
            >
              <option value="">All project bots ({agents.length})</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.scope})
                </option>
              ))}
            </select>
          </div>

          {filteredCheckpoints.length === 0 ? (
            <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)", padding: "8px 4px", lineHeight: 1.5 }}>
              No hidden checkpoints recorded yet. Checkpoints are captured automatically per turn inside each bot's
              Git worktree.
            </div>
          ) : (
            filteredCheckpoints.map((cp) => {
              const bot = agentMap.get(cp.agentId) ?? null;
              const meta = bot ? resolveBotRole(bot) : null;
              const confirming = confirmRollbackId === cp.id;
              const isRollingBack = busyKey === `rb-${cp.id}`;

              return (
                <div key={cp.id} className="task-card checkpoints-item-card">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      {bot && meta && <BotAvatar role={meta.role} size={20} />}
                      <span style={{ fontWeight: 600, fontSize: "var(--text-xs)", color: "var(--ink-primary)" }}>
                        {bot?.name ?? cp.agentId}
                      </span>
                      <span className="pill">Turn #{cp.turnNum}</span>
                    </div>
                    <span className="mono-tag" title={cp.commitSha}>
                      {cp.commitSha.slice(0, 8)}
                    </span>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      fontSize: "var(--text-2xs)",
                      color: "var(--ink-muted)",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={cp.refName}
                    >
                      {cp.refName}
                    </span>
                    <span style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{formatTs(cp.createdAt)}</span>
                  </div>

                  {confirming ? (
                    <div
                      style={{
                        padding: "8px 9px",
                        borderRadius: "var(--radius-sm)",
                        background: "var(--status-warning-bg)",
                        border: "1px solid var(--status-warning-border)",
                        display: "flex",
                        flexDirection: "column",
                        gap: 7,
                      }}
                    >
                      <span style={{ fontSize: "var(--text-2xs)", color: "var(--status-warning-ink)", lineHeight: 1.4 }}>
                        Restore {bot?.name ?? "worktree"} to Turn #{cp.turnNum} ({cp.commitSha.slice(0, 7)})?
                        Subsequent uncommitted edits in this worktree will be reverted.
                      </span>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          type="button"
                          className="btn xs danger"
                          disabled={busyKey !== null}
                          onClick={() => void handleRollback(cp)}
                        >
                          {isRollingBack ? "Restoring…" : "Confirm Rollback"}
                        </button>
                        <button
                          type="button"
                          className="btn xs"
                          disabled={busyKey !== null}
                          onClick={() => setConfirmRollbackId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        className="btn xs"
                        disabled={busyKey !== null}
                        onClick={() => setConfirmRollbackId(cp.id)}
                      >
                        <RotateCcw size={11} strokeWidth={1.6} />
                        <span>Rollback</span>
                      </button>
                      <button
                        type="button"
                        className="btn xs ghost"
                        onClick={() => onOpenDiff(cp.agentId)}
                      >
                        <span>Inspect Diff</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
