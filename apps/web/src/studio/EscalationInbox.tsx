import {
  AlertTriangle,
  Bell,
  Check,
  Clock,
  GitMerge,
  RefreshCw,
  ShieldAlert,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import type {
  AgentRecord,
  PermissionDecision,
  PermissionRequestRecord,
  ProjectRecord,
  QuietStatusProjection,
} from "@bot-factory/shared";

export interface EscalationInboxProps {
  open: boolean;
  onClose: () => void;
  quietStatus: QuietStatusProjection;
  pendingPermissions: PermissionRequestRecord[];
  agents: AgentRecord[];
  projects: ProjectRecord[];
  onPermissionRespond: (permissionId: string, decision: PermissionDecision) => Promise<void>;
  onResolveUnknown: (admissionId: string, expectedGeneration: number) => Promise<void>;
  onDismissNotice: (noticeId: string) => Promise<void>;
  onJumpToProjectMerge: (projectId: string) => void;
}

export function EscalationInbox({
  open,
  onClose,
  quietStatus,
  pendingPermissions,
  agents,
  projects,
  onPermissionRespond,
  onResolveUnknown,
  onDismissNotice,
  onJumpToProjectMerge,
}: EscalationInboxProps): JSX.Element | null {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || pendingPermissions.length === 0) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open, pendingPermissions.length]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-inbox-trigger='true']")) return;
      if (panelRef.current && !panelRef.current.contains(target)) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const unknownAdmissions = quietStatus.unknownAdmissions ?? [];
  const notices = quietStatus.inboxNotices ?? [];
  const hasAny =
    pendingPermissions.length > 0 || unknownAdmissions.length > 0 || notices.length > 0;

  const runAction = async (id: string, fn: () => Promise<void>) => {
    if (busyId) return;
    setBusyId(id);
    setErrorMsg(null);
    try {
      await fn();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      ref={panelRef}
      className="escalation-inbox"
      role="dialog"
      aria-label="Escalation Inbox"
    >
      <div className="escalation-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Bell size={14} strokeWidth={1.7} />
          <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>Escalation Inbox</span>
          {pendingPermissions.length > 0 && (
            <span className="pill accent">{pendingPermissions.length} action</span>
          )}
        </div>
        <button
          type="button"
          className="btn xs ghost"
          onClick={onClose}
          aria-label="Close escalation inbox"
        >
          <X size={13} strokeWidth={1.7} />
        </button>
      </div>

      <div className="escalation-scroll">
        {errorMsg && (
          <div className="inline-error" role="alert">
            <span>{errorMsg}</span>
            <button type="button" className="btn xs ghost" onClick={() => setErrorMsg(null)}>
              <X size={11} />
            </button>
          </div>
        )}

        {!hasAny && (
          <div style={{ padding: "20px 8px", textAlign: "center", color: "var(--ink-muted)", fontSize: "var(--text-xs)" }}>
            All clear — no pending ACP permission prompts, crash recoveries, or notices.
          </div>
        )}

        {pendingPermissions.length > 0 && (
          <div className="escalation-section">
            <div className="section-eyebrow">
              <span>ACP Permission Requests</span>
              <span className="mono-tag">{pendingPermissions.length}</span>
            </div>
            {pendingPermissions.map((perm) => {
              const agent = agents.find((a) => a.id === perm.agentId);
              const project = projects.find((p) => p.id === (perm.projectId ?? agent?.projectId));
              const remainingSec = Math.max(0, Math.ceil((perm.expiresAt - nowMs) / 1000));
              const isBusy = busyId === perm.id;
              return (
                <div key={perm.id} className="escalation-card urgent">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <ShieldAlert size={14} strokeWidth={1.7} color="var(--accent-orange-ink)" />
                      <span style={{ fontWeight: 600, fontSize: "var(--text-xs)" }}>
                        {perm.agentName ?? agent?.name ?? perm.agentId}
                      </span>
                      {project && <span className="mono-tag">{project.name}</span>}
                    </div>
                    <span className="escalation-countdown" title="Time remaining before timeout">
                      <Clock size={10} style={{ verticalAlign: "-1px", marginRight: 3 }} />
                      {remainingSec}s
                    </span>
                  </div>

                  <div style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--ink-primary)" }}>
                    {perm.title}
                  </div>
                  {perm.reason && (
                    <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-secondary)" }}>
                      {perm.reason}
                    </div>
                  )}
                  <div className="escalation-cmd">{perm.commandOrPath}</div>

                  <div className="escalation-actions">
                    <button
                      type="button"
                      className="btn xs accent"
                      disabled={isBusy}
                      onClick={() => void runAction(perm.id, () => onPermissionRespond(perm.id, "allow_once"))}
                    >
                      <Check size={11} strokeWidth={1.8} />
                      <span>Allow Once</span>
                    </button>
                    <button
                      type="button"
                      className="btn xs"
                      disabled={isBusy}
                      onClick={() => void runAction(perm.id, () => onPermissionRespond(perm.id, "allow_session"))}
                    >
                      <span>Allow Session</span>
                    </button>
                    <button
                      type="button"
                      className="btn xs danger"
                      disabled={isBusy}
                      onClick={() => void runAction(perm.id, () => onPermissionRespond(perm.id, "deny"))}
                    >
                      <span>Deny</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {unknownAdmissions.length > 0 && (
          <div className="escalation-section">
            <div className="section-eyebrow">
              <span>Crash Recovery (Unknown Admissions)</span>
              <span className="mono-tag">{unknownAdmissions.length}</span>
            </div>
            {unknownAdmissions.map((adm) => {
              const agent = agents.find((a) => a.id === adm.agentId);
              const isBusy = busyId === adm.id;
              return (
                <div key={adm.id} className="escalation-card">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: "var(--text-xs)" }}>
                      <AlertTriangle size={13} strokeWidth={1.7} color="var(--status-warning-ink)" />
                      <span>{agent?.name ?? adm.agentId}</span>
                    </span>
                    <span className="mono-tag">gen #{adm.executionGeneration}</span>
                  </div>
                  <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-secondary)" }}>
                    Session <code className="md-inline-code">{adm.sessionId}</code> had an in-flight turn when the
                    daemon restarted. Confirm recovery to reset agent state safely.
                  </div>
                  <div className="escalation-actions">
                    <button
                      type="button"
                      className="btn xs primary"
                      disabled={isBusy}
                      onClick={() =>
                        void runAction(adm.id, () => onResolveUnknown(adm.id, adm.executionGeneration))
                      }
                    >
                      <RefreshCw size={11} strokeWidth={1.7} />
                      <span>{isBusy ? "Resolving…" : "Resolve & Resume"}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {notices.length > 0 && (
          <div className="escalation-section">
            <div className="section-eyebrow">
              <span>Activity &amp; Notices</span>
              <span className="mono-tag">{notices.length}</span>
            </div>
            {notices.map((notice) => {
              const project = notice.projectId ? projects.find((p) => p.id === notice.projectId) : null;
              const isBusy = busyId === notice.id;
              return (
                <div key={notice.id} className="escalation-card">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span
                        className={`pill ${
                          notice.level === "action"
                            ? "danger"
                            : notice.level === "warn"
                              ? "warning"
                              : "active"
                        }`}
                      >
                        {notice.level}
                      </span>
                      {project && <span className="mono-tag">{project.name}</span>}
                    </div>
                    <button
                      type="button"
                      className="btn xs ghost"
                      disabled={isBusy}
                      aria-label="Dismiss notice"
                      onClick={() => void runAction(notice.id, () => onDismissNotice(notice.id))}
                    >
                      <X size={11} strokeWidth={1.7} />
                    </button>
                  </div>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-primary)", lineHeight: 1.45 }}>
                    {notice.message}
                  </div>
                  {notice.projectId && (
                    <div className="escalation-actions">
                      <button
                        type="button"
                        className="btn xs"
                        onClick={() => {
                          onJumpToProjectMerge(notice.projectId!);
                          onClose();
                        }}
                      >
                        <GitMerge size={11} strokeWidth={1.6} />
                        <span>Open Checkpoints &amp; Merge</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
