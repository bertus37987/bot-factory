import type {
  AgentRecord,
  DebateMessageRecord,
  DebateRecord,
  SelfModKind,
  SelfModProposalRecord,
  VerificationReportRecord,
} from "@bot-factory/shared";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Layers,
  MessageSquareWarning,
  RotateCcw,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { BotThinkingOrb } from "../components/BotThinkingOrb";

export interface DebatesVerifierPanelProps {
  projectId: string;
  agents: AgentRecord[];
  debates: DebateRecord[];
  debateMessages: Record<string, DebateMessageRecord[]>;
  verifications: VerificationReportRecord[];
  onOpenDebate: (params: {
    projectId: string;
    taskId?: string;
    topic: string;
    reason: string;
    participantAgentIds: string[];
    maxRounds?: number;
  }) => Promise<void>;
  onPostDebate: (params: {
    debateId: string;
    agentId: string;
    position: string;
    evidence?: string;
  }) => Promise<void>;
  onResolveDebate: (params: { debateId: string; decision: string }) => Promise<void>;
}

export function DebatesVerifierPanel(props: DebatesVerifierPanelProps): JSX.Element {
  const { projectId, agents, debates, debateMessages, verifications } = props;
  const [topic, setTopic] = useState("");
  const [reason, setReason] = useState("");
  const [maxRounds, setMaxRounds] = useState(3);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>([]);
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [replyAgent, setReplyAgent] = useState<Record<string, string>>({});
  const [decisionText, setDecisionText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const selectableAgents = agents.filter((a) => a.scope !== "global");

  useEffect(() => {
    const validIds = new Set(selectableAgents.map((a) => a.id));
    setSelectedParticipantIds((prev) => {
      const kept = prev.filter((id) => validIds.has(id));
      if (kept.length > 0) return kept;
      const peers = selectableAgents.filter((a) => a.scope === "peer");
      const defaults = (peers.length >= 2 ? peers : selectableAgents).slice(0, 2).map((a) => a.id);
      return defaults;
    });
  }, [projectId, agents.map((a) => a.id).join(",")]);

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  const toggleParticipant = (agentId: string) => {
    setSelectedParticipantIds((prev) => {
      if (prev.includes(agentId)) {
        return prev.filter((id) => id !== agentId);
      }
      if (prev.length >= 6) return prev;
      return [...prev, agentId];
    });
  };

  const runAction = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await fn();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {errorMsg && <div className="inline-error">{errorMsg}</div>}
      <div className="phase3-split">
        {/* Left: Conflict Debates (participant multi-select + round cap + PM escalation) */}
        <div className="kanban-col">
          <div className="section-eyebrow">
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <MessageSquareWarning size={14} strokeWidth={1.6} color="var(--ink-secondary)" />
              Conflict Debates ({debates.length})
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
              {busy && <BotThinkingOrb activity="solving" size={20} />}
              <span className="mono-tag">escalation only</span>
            </span>
          </div>

          <div className="task-card">
            <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--ink-primary)" }}>
              Open Conflict Debate Thread
            </div>
            <input
              className="field-input"
              placeholder="Topic (e.g. API contract vs. latency budget)"
              value={topic}
              disabled={busy}
              onChange={(e) => setTopic(e.target.value)}
            />
            <input
              className="field-input"
              placeholder="Conflict or blocker reason"
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />

            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-secondary)", fontWeight: 500 }}>
                  Participants ({selectedParticipantIds.length}/6)
                </span>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--text-2xs)", color: "var(--ink-secondary)" }}>
                  <span>Max Rounds</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    className="field-input"
                    style={{ width: 64, padding: "3px 7px", fontSize: "var(--text-xs)" }}
                    value={maxRounds}
                    disabled={busy}
                    onChange={(e) => setMaxRounds(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                  />
                </label>
              </div>

              {selectableAgents.length === 0 ? (
                <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-muted)" }}>
                  Spawn at least one project bot to open a debate.
                </div>
              ) : (
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {selectableAgents.map((a) => {
                    const selected = selectedParticipantIds.includes(a.id);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        disabled={busy}
                        onClick={() => toggleParticipant(a.id)}
                        className={`btn xs ${selected ? "primary" : ""}`}
                        style={{ borderRadius: "var(--radius-pill)" }}
                      >
                        {selected && <Check size={10} strokeWidth={2} />}
                        <span>{a.name}</span>
                        <span style={{ opacity: 0.72, fontSize: "10px" }}>({a.scope})</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <button
              type="button"
              className="btn sm primary"
              disabled={busy || !topic.trim() || !reason.trim() || selectedParticipantIds.length === 0}
              onClick={() => {
                const nextTopic = topic.trim();
                const nextReason = reason.trim();
                const participants = [...selectedParticipantIds];
                void runAction(async () => {
                  await props.onOpenDebate({
                    projectId,
                    topic: nextTopic,
                    reason: nextReason,
                    participantAgentIds: participants,
                    maxRounds,
                  });
                  setTopic("");
                  setReason("");
                });
              }}
            >
              Start Debate ({selectedParticipantIds.length} participant{selectedParticipantIds.length === 1 ? "" : "s"} ·{" "}
              {maxRounds} max rounds)
            </button>
          </div>

          {debates.length === 0 && (
            <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)", padding: 6 }}>
              No active conflict debates. Standard coordination runs quietly on the Task Board.
            </div>
          )}

          {debates.map((d) => {
            const msgs = debateMessages[d.id] ?? [];
            const defaultSpeaker =
              d.participantAgentIds[d.roundCount % Math.max(1, d.participantAgentIds.length)] ??
              d.participantAgentIds[0] ??
              "";
            const chosenSpeaker = replyAgent[d.id] ?? defaultSpeaker;

            return (
              <div key={d.id} className="task-card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>{d.topic}</span>
                  <span
                    className={`pill ${
                      d.status === "escalated" ? "warning" : d.status === "resolved" ? "success" : "active"
                    }`}
                  >
                    {d.status} · Round {d.roundCount}/{d.maxRounds}
                  </span>
                </div>
                <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)" }}>{d.reason}</div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {d.participantAgentIds.map((pid) => (
                    <span key={pid} className="mono-tag">
                      {agentName(pid)}
                    </span>
                  ))}
                </div>

                {msgs.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {msgs.map((m) => (
                      <div key={m.id} className="debate-msg">
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            color: "var(--ink-muted)",
                            fontSize: "var(--text-2xs)",
                          }}
                        >
                          <b style={{ color: "var(--ink-secondary)" }}>{agentName(m.agentId)}</b>
                          <span>Round #{m.roundNum}</span>
                        </div>
                        <div style={{ marginTop: 3, color: "var(--ink-primary)" }}>{m.position}</div>
                        {m.evidence && (
                          <div
                            style={{
                              marginTop: 4,
                              fontSize: "var(--text-2xs)",
                              color: "var(--ink-muted)",
                              whiteSpace: "pre-wrap",
                            }}
                          >
                            Evidence: {m.evidence}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {d.status === "open" && d.participantAgentIds.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <select
                      className="field-input"
                      style={{ width: 150 }}
                      value={chosenSpeaker}
                      disabled={busy}
                      onChange={(e) => setReplyAgent((p) => ({ ...p, [d.id]: e.target.value }))}
                    >
                      {d.participantAgentIds.map((pid) => (
                        <option key={pid} value={pid}>
                          {agentName(pid)}
                        </option>
                      ))}
                    </select>
                    <input
                      className="field-input"
                      style={{ flex: 1, minWidth: 160 }}
                      placeholder="Add position or argument…"
                      value={replyText[d.id] ?? ""}
                      disabled={busy}
                      onChange={(e) => setReplyText((p) => ({ ...p, [d.id]: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy || !(replyText[d.id] ?? "").trim() || !chosenSpeaker}
                      onClick={() => {
                        const pos = (replyText[d.id] ?? "").trim();
                        void runAction(async () => {
                          await props.onPostDebate({ debateId: d.id, agentId: chosenSpeaker, position: pos });
                          setReplyText((p) => ({ ...p, [d.id]: "" }));
                        });
                      }}
                    >
                      Post
                    </button>
                  </div>
                )}

                {d.status !== "resolved" && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      className="field-input"
                      placeholder="Team Lead decision to resolve debate…"
                      value={decisionText[d.id] ?? ""}
                      disabled={busy}
                      onChange={(e) => setDecisionText((p) => ({ ...p, [d.id]: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={busy || !(decisionText[d.id] ?? "").trim()}
                      onClick={() => {
                        const dec = (decisionText[d.id] ?? "").trim();
                        void runAction(async () => {
                          await props.onResolveDebate({ debateId: d.id, decision: dec });
                          setDecisionText((p) => ({ ...p, [d.id]: "" }));
                        });
                      }}
                    >
                      Resolve
                    </button>
                  </div>
                )}

                {d.resolutionSummary && (
                  <div
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--status-success-ink)",
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 5,
                    }}
                  >
                    <CheckCircle2 size={12} strokeWidth={1.6} style={{ flexShrink: 0, marginTop: 2 }} />
                    <span>Resolution: {d.resolutionSummary}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Right: Independent Cross-Family Verifier Reports */}
        <div className="kanban-col">
          <div className="section-eyebrow">
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <ShieldCheck size={14} strokeWidth={1.6} color="var(--ink-secondary)" />
              Independent Verifier ({verifications.length})
            </span>
            <span className="mono-tag">fresh session · cross-family</span>
          </div>

          {verifications.length === 0 && (
            <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)", padding: 6 }}>
              No verification reports yet. Trigger <b>Verify (Fresh)</b> on an <code>in_review</code> or{" "}
              <code>blocked</code> task from the Task Board.
            </div>
          )}

          {verifications.map((v) => (
            <div key={v.id} className="task-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 600, fontSize: "var(--text-xs)" }}>
                  {v.targetKind}:{v.targetId}
                </span>
                <span
                  className={`pill ${
                    v.verdict === "pass"
                      ? "success"
                      : v.verdict === "fail"
                        ? "danger"
                        : v.verdict === "needs_human"
                          ? "warning"
                          : "active"
                  }`}
                >
                  {v.verdict.toUpperCase()}
                </span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span className="mono-tag">
                  {v.verifierProvider}/{v.verifierModel}
                </span>
                {v.crossFamily && (
                  <span className="mono-tag" style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                    cross-family <Check size={11} strokeWidth={1.8} />
                  </span>
                )}
                <span className="mono-tag">fresh:{v.verifierSessionId.slice(0, 10)}</span>
              </div>
              <div style={{ fontSize: "var(--text-xs)", lineHeight: "var(--leading-snug)", color: "var(--ink-primary)" }}>
                {v.summary}
              </div>
              {v.checks.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                    fontSize: "var(--text-2xs)",
                    color: "var(--ink-muted)",
                  }}
                >
                  {v.checks.map((c, idx) => (
                    <div key={`${v.id}-${idx}`} style={{ display: "flex", alignItems: "flex-start", gap: 5 }}>
                      {c.passed ? (
                        <Check
                          size={12}
                          strokeWidth={1.8}
                          color="var(--status-success-ink)"
                          style={{ flexShrink: 0, marginTop: 1 }}
                        />
                      ) : (
                        <X
                          size={12}
                          strokeWidth={1.8}
                          color="var(--status-danger-ink)"
                          style={{ flexShrink: 0, marginTop: 1 }}
                        />
                      )}
                      <span>
                        <b style={{ color: "var(--ink-secondary)" }}>{c.name}</b>: {c.detail}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {v.findings.length > 0 && (
                <div
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--status-warning-ink)",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 5,
                  }}
                >
                  <AlertTriangle size={11} strokeWidth={1.6} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>{v.findings.join(" · ")}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export interface SelfModPanelProps {
  proposals: SelfModProposalRecord[];
  onPropose: (params: {
    kind: SelfModKind;
    targetId: string;
    title: string;
    rationale: string;
    content: string;
    autoVerify: boolean;
  }) => Promise<void>;
  onVerify: (proposalId: string) => Promise<void>;
  onPromote: (proposalId: string) => Promise<void>;
  onRollback: (proposalId: string, reason?: string) => Promise<void>;
}

export function SelfModPanel(props: SelfModPanelProps): JSX.Element {
  const { proposals } = props;
  const [kind, setKind] = useState<SelfModKind>("plugin");
  const [targetId, setTargetId] = useState("clean-handoff-helper");
  const [title, setTitle] = useState("");
  const [rationale, setRationale] = useState("");
  const [content, setContent] = useState("");
  const [autoVerify, setAutoVerify] = useState(true);
  const [rollbackConfirmId, setRollbackConfirmId] = useState<string | null>(null);
  const [rollbackReason, setRollbackReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const runAction = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await fn();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {errorMsg && <div className="inline-error">{errorMsg}</div>}
      <div className="phase3-split selfmod">
        <div className="kanban-col">
          <div className="section-eyebrow">
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Layers size={14} strokeWidth={1.6} color="var(--ink-secondary)" />
              Self-Mod Staging (Sandbox)
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
              {busy && <BotThinkingOrb activity="solving" size={20} />}
              <span className="mono-tag">Verifier-Gated</span>
            </span>
          </div>

          <div className="task-card">
            <div className="subview-tabs" style={{ alignSelf: "flex-start" }}>
              <button
                type="button"
                className={`subview-tab ${kind === "plugin" ? "active" : ""}`}
                onClick={() => {
                  setKind("plugin");
                  if (targetId === "config") setTargetId("clean-handoff-helper");
                }}
              >
                Plugin
              </button>
              <button
                type="button"
                className={`subview-tab ${kind === "config_patch" ? "active" : ""}`}
                onClick={() => {
                  setKind("config_patch");
                  setTargetId("config");
                }}
              >
                Config Patch
              </button>
            </div>
            <input
              className="field-input"
              placeholder={kind === "plugin" ? "Plugin slug (e.g. clean-handoff-helper)" : "Target ID (config)"}
              value={targetId}
              disabled={busy}
              onChange={(e) => setTargetId(e.target.value)}
            />
            <input
              className="field-input"
              placeholder="Proposal title"
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
            <input
              className="field-input"
              placeholder="Rationale and expected effect"
              value={rationale}
              disabled={busy}
              onChange={(e) => setRationale(e.target.value)}
            />
            <textarea
              className="field-textarea mono"
              rows={5}
              placeholder={
                kind === "plugin"
                  ? "Plugin prompt markdown (<= 4000 chars)…"
                  : 'JSON patch for config.json (e.g. {"guardrails":{"maxDebateRounds":4}})'
              }
              value={content}
              disabled={busy}
              onChange={(e) => setContent(e.target.value)}
            />

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: "var(--radius-sm)",
                background: "var(--bg-surface)",
                border: "var(--hairline)",
                cursor: "pointer",
                fontSize: "var(--text-xs)",
                color: "var(--ink-secondary)",
              }}
            >
              <input
                type="checkbox"
                checked={autoVerify}
                disabled={busy}
                onChange={(e) => setAutoVerify(e.target.checked)}
                style={{ accentColor: "var(--accent-orange)" }}
              />
              <span>Auto-verify in fresh cross-family session immediately after staging</span>
            </label>

            <button
              type="button"
              className="btn sm primary"
              disabled={busy || !targetId.trim() || !title.trim() || !rationale.trim() || !content.trim()}
              onClick={() => {
                const payload = {
                  kind,
                  targetId: targetId.trim(),
                  title: title.trim(),
                  rationale: rationale.trim(),
                  content,
                  autoVerify,
                };
                void runAction(async () => {
                  await props.onPropose(payload);
                  setTitle("");
                  setRationale("");
                  setContent("");
                });
              }}
            >
              {autoVerify ? "Stage in Sandbox & Verify" : "Stage in Sandbox"}
            </button>
          </div>
        </div>

        <div className="kanban-col">
          <div className="section-eyebrow">
            <span>Self-Mod Pipeline ({proposals.length})</span>
            <span className="mono-tag">Stage -&gt; Verify -&gt; Promote -&gt; Rollback</span>
          </div>

          {proposals.length === 0 && (
            <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)", padding: 6 }}>
              No self-modification proposals yet. Every proposal is isolated in <code>system/staging/</code> and
              checked by the independent verifier before promotion.
            </div>
          )}

          {proposals.map((p) => {
            const confirmingRollback = rollbackConfirmId === p.id;
            return (
              <div key={p.id} className="task-card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>{p.title}</span>
                  <span
                    className={`pill ${
                      p.status === "promoted" || p.status === "verified"
                        ? "success"
                        : p.status === "rejected"
                          ? "danger"
                          : p.status === "rolled_back"
                            ? "warning"
                            : "active"
                    }`}
                  >
                    {p.status}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span className="mono-tag">{p.kind}</span>
                  <span className="mono-tag">{p.targetId}</span>
                  <span className="mono-tag">sha256:{p.contentSha256.slice(0, 10)}</span>
                </div>
                <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)" }}>{p.rationale}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span className="mono-tag" title={p.stagingPath}>
                    stage: {p.stagingPath.split(/[/\\]/).slice(-2).join("/")}
                  </span>
                  <span className="mono-tag" title={p.livePath}>
                    live: {p.livePath.split(/[/\\]/).slice(-2).join("/")}
                  </span>
                  {p.backupPath && (
                    <span className="mono-tag" title={p.backupPath}>
                      backup: ready
                    </span>
                  )}
                </div>
                {p.verificationSummary && (
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-primary)" }}>
                    Verifier: {p.verificationSummary}
                  </div>
                )}

                {confirmingRollback && (
                  <div
                    style={{
                      padding: "8px 9px",
                      borderRadius: "var(--radius-sm)",
                      background: "var(--status-warning-bg)",
                      border: "1px solid var(--status-warning-border)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    <span style={{ fontSize: "var(--text-2xs)", color: "var(--status-warning-ink)", fontWeight: 500 }}>
                      Confirm rollback for "{p.title}"? This restores the pre-promotion backup.
                    </span>
                    <input
                      className="field-input"
                      placeholder="Optional rollback reason…"
                      value={rollbackReason}
                      disabled={busy}
                      onChange={(e) => setRollbackReason(e.target.value)}
                    />
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        className="btn xs danger"
                        disabled={busy}
                        onClick={() => {
                          const reasonArg = rollbackReason.trim() || undefined;
                          void runAction(async () => {
                            await props.onRollback(p.id, reasonArg);
                            setRollbackConfirmId(null);
                            setRollbackReason("");
                          });
                        }}
                      >
                        Confirm Rollback
                      </button>
                      <button
                        type="button"
                        className="btn xs"
                        disabled={busy}
                        onClick={() => {
                          setRollbackConfirmId(null);
                          setRollbackReason("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(p.status === "staged" || p.status === "rejected") && (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() => void runAction(() => props.onVerify(p.id))}
                    >
                      <ShieldCheck size={12} strokeWidth={1.6} />
                      <span>Verify (Fresh)</span>
                    </button>
                  )}
                  {p.status === "verified" && (
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={busy}
                      onClick={() => void runAction(() => props.onPromote(p.id))}
                    >
                      <Upload size={12} strokeWidth={1.6} />
                      <span>Promote (with Backup)</span>
                    </button>
                  )}
                  {p.status === "promoted" && !confirmingRollback && (
                    <button
                      type="button"
                      className="btn sm danger"
                      disabled={busy}
                      onClick={() => {
                        setRollbackConfirmId(p.id);
                        setRollbackReason("");
                      }}
                    >
                      <RotateCcw size={12} strokeWidth={1.6} />
                      <span>Rollback</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
