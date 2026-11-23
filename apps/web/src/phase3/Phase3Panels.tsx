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
import { useState } from "react";
import type {
  AgentRecord,
  DebateMessageRecord,
  DebateRecord,
  SelfModKind,
  SelfModProposalRecord,
  VerificationReportRecord,
} from "@bot-factory/shared";
import { BotThinkingOrb } from "../components/BotThinkingOrb";

interface DebatesVerifierPanelProps {
  projectId: string;
  agents: AgentRecord[];
  debates: DebateRecord[];
  debateMessages: Record<string, DebateMessageRecord[]>;
  verifications: VerificationReportRecord[];
  onOpenDebate: (params: {
    projectId: string;
    topic: string;
    reason: string;
    participantAgentIds: string[];
  }) => Promise<void>;
  onPostDebate: (params: { debateId: string; agentId: string; position: string; evidence?: string }) => Promise<void>;
  onResolveDebate: (params: { debateId: string; decision: string }) => Promise<void>;
}

export function DebatesVerifierPanel(props: DebatesVerifierPanelProps) {
  const { projectId, agents, debates, debateMessages, verifications } = props;
  const [topic, setTopic] = useState("");
  const [reason, setReason] = useState("");
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [decisionText, setDecisionText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const peerAgents = agents.filter((a) => a.scope === "peer");
  const eligibleAgents = peerAgents.length >= 2 ? peerAgents : agents.filter((a) => a.scope === "peer" || a.scope === "project");
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

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
        {/* Left: Conflict Debates (with round cap + PM escalation) */}
        <div className="kanban-col">
          <div className="section-eyebrow">
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <MessageSquareWarning size={14} strokeWidth={1.6} color="var(--ink-secondary)" /> Konflikt-Debates (
              {debates.length})
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
              {busy && <BotThinkingOrb activity="solving" size={20} />}
              <span className="mono-tag">nur bei Blocker/Konflikt</span>
            </span>
          </div>

          <div className="task-card">
            <div style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-semibold)", color: "var(--ink-primary)" }}>
              Neuen Debate-Thread eröffnen
            </div>
            <input
              className="field-input"
              placeholder="Thema (z. B. API-Contract vs. Performance)"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
            <input
              className="field-input"
              placeholder="Konflikt-/Blocker-Grund"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              className="btn sm primary"
              disabled={busy || !topic.trim() || !reason.trim() || eligibleAgents.length === 0}
              onClick={() => {
                const ids = eligibleAgents.slice(0, 2).map((a) => a.id);
                const nextTopic = topic.trim();
                const nextReason = reason.trim();
                void runAction(async () => {
                  await props.onOpenDebate({
                    projectId,
                    topic: nextTopic,
                    reason: nextReason,
                    participantAgentIds: ids,
                  });
                  setTopic("");
                  setReason("");
                });
              }}
            >
              Debate starten ({Math.min(eligibleAgents.length, 2)} Teilnehmer)
            </button>
          </div>

          {debates.length === 0 && (
            <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)", padding: 6 }}>
              Keine aktiven Konflikt-Debates. Standard-Koordination läuft ruhig über das Task-Board.
            </div>
          )}

          {debates.map((d) => {
            const msgs = debateMessages[d.id] ?? [];
            return (
              <div key={d.id} className="task-card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: "var(--weight-semibold)", fontSize: "var(--text-sm)" }}>{d.topic}</span>
                  <span
                    className={`pill ${
                      d.status === "escalated" ? "warning" : d.status === "resolved" ? "success" : "active"
                    }`}
                  >
                    {d.status} · Runde {d.roundCount}/{d.maxRounds}
                  </span>
                </div>
                <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)" }}>{d.reason}</div>

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
                          <span>Runde #{m.roundNum}</span>
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
                            Evidenz: {m.evidence}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {d.status === "open" && d.participantAgentIds[0] && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      className="field-input"
                      placeholder="Position / Argument hinzufügen..."
                      value={replyText[d.id] ?? ""}
                      onChange={(e) => setReplyText((p) => ({ ...p, [d.id]: e.target.value }))}
                    />
                    <button
                      className="btn sm"
                      disabled={busy || !(replyText[d.id] ?? "").trim()}
                      onClick={() => {
                        const pos = (replyText[d.id] ?? "").trim();
                        const nextSpeaker =
                          d.participantAgentIds[d.roundCount % d.participantAgentIds.length] ?? d.participantAgentIds[0]!;
                        void runAction(async () => {
                          await props.onPostDebate({ debateId: d.id, agentId: nextSpeaker, position: pos });
                          setReplyText((p) => ({ ...p, [d.id]: "" }));
                        });
                      }}
                    >
                      Posten
                    </button>
                  </div>
                )}

                {d.status !== "resolved" && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      className="field-input"
                      placeholder="PM-Entscheidung zur Auflösung..."
                      value={decisionText[d.id] ?? ""}
                      onChange={(e) => setDecisionText((p) => ({ ...p, [d.id]: e.target.value }))}
                    />
                    <button
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
                      PM-Entscheidung
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
                    <span>Beschluss: {d.resolutionSummary}</span>
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
              <ShieldCheck size={14} strokeWidth={1.6} color="var(--ink-secondary)" /> Independent Verifier (
              {verifications.length})
            </span>
            <span className="mono-tag">fresh session · cross-family</span>
          </div>

          {verifications.length === 0 && (
            <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)", padding: 6 }}>
              Noch keine Verifier-Reports. Starte im Task-Board bei einem <b>in_review</b>-Task „Verify (Fresh)“.
            </div>
          )}

          {verifications.map((v) => (
            <div key={v.id} className="task-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: "var(--weight-semibold)", fontSize: "var(--text-xs)" }}>
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

interface SelfModPanelProps {
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
  onRollback: (proposalId: string) => Promise<void>;
}

export function SelfModPanel(props: SelfModPanelProps) {
  const { proposals } = props;
  const [kind, setKind] = useState<SelfModKind>("plugin");
  const [targetId, setTargetId] = useState("clean-handoff-helper");
  const [title, setTitle] = useState("");
  const [rationale, setRationale] = useState("");
  const [content, setContent] = useState("");
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
              <Layers size={14} strokeWidth={1.6} color="var(--ink-secondary)" /> Self-Mod Staging (Sandbox)
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
              {busy && <BotThinkingOrb activity="solving" size={20} />}
              <span className="mono-tag">Verifier-Gated</span>
            </span>
          </div>

          <div className="task-card">
            <div className="subview-tabs" style={{ alignSelf: "flex-start" }}>
              <button
                className={`subview-tab ${kind === "plugin" ? "active" : ""}`}
                onClick={() => {
                  setKind("plugin");
                  if (targetId === "config") setTargetId("clean-handoff-helper");
                }}
              >
                Plugin
              </button>
              <button
                className={`subview-tab ${kind === "config_patch" ? "active" : ""}`}
                onClick={() => {
                  setKind("config_patch");
                  setTargetId("config");
                }}
              >
                Config-Update
              </button>
            </div>
            <input
              className="field-input"
              placeholder={kind === "plugin" ? "Plugin-Slug (z. B. clean-handoff-helper)" : "Target-ID (config)"}
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
            />
            <input
              className="field-input"
              placeholder="Titel der Selbstmodifikation"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <input
              className="field-input"
              placeholder="Begründung / Ziel"
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
            />
            <textarea
              className="field-textarea mono"
              rows={5}
              placeholder={
                kind === "plugin"
                  ? "Plugin-Inhalt (Markdown/Prompt-Block ≤4000 Zeichen oder JSON-Manifest)..."
                  : 'JSON Patch für config.json (z. B. {"guardrails":{"maxDebateRounds":4}})'
              }
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
            <button
              className="btn sm primary"
              disabled={busy || !targetId.trim() || !title.trim() || !rationale.trim() || !content.trim()}
              onClick={() => {
                const payload = {
                  kind,
                  targetId: targetId.trim(),
                  title: title.trim(),
                  rationale: rationale.trim(),
                  content,
                  autoVerify: true,
                };
                void runAction(async () => {
                  await props.onPropose(payload);
                  setTitle("");
                  setRationale("");
                  setContent("");
                });
              }}
            >
              In Staging-Sandbox ablegen & verifizieren
            </button>
          </div>
        </div>

        <div className="kanban-col">
          <div className="section-eyebrow">
            <span>Self-Mod Pipeline ({proposals.length})</span>
            <span className="mono-tag">Stage → Verify → Promote → Rollback</span>
          </div>

          {proposals.length === 0 && (
            <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)", padding: 6 }}>
              Noch keine Self-Modification Proposals. Jede Änderung wird zuerst in <code>system/staging/</code> isoliert
              und vom kontextunabhängigen Verifier geprüft.
            </div>
          )}

          {proposals.map((p) => (
            <div key={p.id} className="task-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: "var(--weight-semibold)", fontSize: "var(--text-sm)" }}>{p.title}</span>
                <span
                  className={`pill ${
                    p.status === "promoted" || p.status === "verified"
                      ? "success"
                      : p.status === "rejected"
                        ? "danger"
                        : p.status === "rolled_back"
                          ? "warning"
                          : p.status === "staged"
                            ? "active"
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
              {p.verificationSummary && (
                <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-primary)" }}>
                  Verifier: {p.verificationSummary}
                </div>
              )}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(p.status === "staged" || p.status === "rejected") && (
                  <button className="btn sm" disabled={busy} onClick={() => void runAction(() => props.onVerify(p.id))}>
                    <ShieldCheck size={12} strokeWidth={1.6} /> Verify (Fresh)
                  </button>
                )}
                {p.status === "verified" && (
                  <button className="btn sm primary" disabled={busy} onClick={() => void runAction(() => props.onPromote(p.id))}>
                    <Upload size={12} strokeWidth={1.6} /> Promote (mit Backup)
                  </button>
                )}
                {p.status === "promoted" && (
                  <button className="btn sm danger" disabled={busy} onClick={() => void runAction(() => props.onRollback(p.id))}>
                    <RotateCcw size={12} strokeWidth={1.6} /> Rollback
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
