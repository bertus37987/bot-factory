import type {
  AgentRecord,
  ArtifactEntry,
  DebateMessageRecord,
  DebateRecord,
  ProjectRecord,
  TaskRecord,
  TimelineItem,
  VerificationReportRecord,
} from "@bot-factory/shared";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  BotAvatar,
  GroupAvatarCluster,
  JobTitlePill,
  resolveBotRole,
  type ResolvedBotMeta,
} from "../components/BotAvatars";
import {
  CodeTabIcon,
  Cube3DTabIcon,
  DocTabIcon,
  ImageTabIcon,
} from "../components/BotFactoryIcons";
import { BotThinkingOrb } from "../components/BotThinkingOrb";

export interface BotChatStreamProps {
  mode: "single" | "group";
  project: ProjectRecord;
  activeAgent: AgentRecord | null;
  agents: AgentRecord[];
  timeline: TimelineItem[];
  tasks: TaskRecord[];
  debates: DebateRecord[];
  debateMessages: Record<string, DebateMessageRecord[]>;
  verifications: VerificationReportRecord[];
  artifacts: ArtifactEntry[];
  onOpenArtifactInBrowser: (artifact: ArtifactEntry) => void;
  onOpenDiffInBrowser: () => void;
  onVerifyTask: (taskId: string) => Promise<void>;
  onDispatchTask: (taskId: string) => Promise<void>;
  onOpenGroupRoom?: () => void;
}

const TRACE_KINDS = new Set(["thought", "plan", "tool_call", "terminal", "status"]);
const SEP_GAP_MS = 45 * 60 * 1000;
const RIGHT_SIDE_ROLE = /lead|pm|verifier|manager|human/i;

const pad2 = (n: number) => String(n).padStart(2, "0");

function timeLabel(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function dayStamp(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function sepLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const t = timeLabel(ts);
  if (dayStamp(d) === dayStamp(now)) return `Heute ${t}`;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (dayStamp(d) === dayStamp(yesterday)) return `Gestern ${t}`;
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}. ${t}`;
}

function roleLabel(meta: ResolvedBotMeta | null, agent: AgentRecord | null): string {
  if (meta) return meta.jobTitle;
  switch (agent?.scope) {
    case "project":
      return "Team lead";
    case "verifier":
      return "Verifier";
    case "peer":
      return "Peer";
    case "sidekick":
      return "Sidekick";
    default:
      return "Bot";
  }
}

function artifactIcon(a: ArtifactEntry): JSX.Element {
  if (a.kind === "image" || /\.(png|jpe?g|svg|webp|gif|bmp)$/i.test(a.name)) {
    return <ImageTabIcon size={14} />;
  }
  if (a.kind === "model_3d" || /\.(glb|gltf|fbx|obj|stl)$/i.test(a.name)) {
    return <Cube3DTabIcon size={14} />;
  }
  if (a.kind === "other" || /\.(tsx?|jsx?|css|html?|json|py|rs|luau?|cs|c|cpp|sh)$/i.test(a.name)) {
    return <CodeTabIcon size={14} />;
  }
  return <DocTabIcon size={14} />;
}

const VERDICT_LABEL: Record<VerificationReportRecord["verdict"], string> = {
  pass: "PASS",
  fail: "FAIL",
  needs_human: "NEEDS_HUMAN",
};

interface SpeakerInfo {
  human: boolean;
  name: string;
  meta: ResolvedBotMeta | null;
  agent: AgentRecord | null;
}

type FeedNode =
  | { kind: "sep"; key: string; label: string }
  | {
      kind: "msg";
      key: string;
      ts: number;
      side: "left" | "right";
      speaker: SpeakerInfo;
      text: string;
      eyebrow?: string;
    }
  | { kind: "trace"; key: string; ts: number; items: TimelineItem[] }
  | { kind: "system"; key: string; ts: number; text: string }
  | { kind: "artifact"; key: string; ts: number; artifact: ArtifactEntry }
  | { kind: "verify"; key: string; ts: number; report: VerificationReportRecord };

type RawEvent =
  | { ts: number; ord: number; type: "timeline"; item: TimelineItem }
  | { ts: number; ord: number; type: "debate_msg"; msg: DebateMessageRecord; debate: DebateRecord }
  | { ts: number; ord: number; type: "system"; text: string }
  | { ts: number; ord: number; type: "verify"; report: VerificationReportRecord }
  | { ts: number; ord: number; type: "artifact"; artifact: ArtifactEntry };

const BCS_CSS = `
.bcs-root{display:flex;flex-direction:column;padding:6px 0 10px}
.bcs-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:64px 20px;text-align:center}
.bcs-empty-title{font-size:var(--text-lg);font-weight:var(--weight-semibold);letter-spacing:var(--tracking-snug);color:var(--ink-primary)}
.bcs-empty-sub{font-size:var(--text-sm);color:var(--ink-muted);max-width:380px;line-height:1.55}
.bcs-time-sep{display:flex;justify-content:center;margin:16px 0 14px}
.bcs-time-sep>span{font-family:var(--font-mono);font-size:var(--text-2xs);color:var(--ink-muted);background:var(--bg-surface);border:var(--hairline-subtle);border-radius:var(--radius-pill);padding:2px 10px;font-variant-numeric:tabular-nums}
.bcs-row{display:flex;align-items:flex-end;gap:9px;margin-bottom:14px}
.bcs-row.right{flex-direction:row-reverse}
.bcs-msg{display:flex;flex-direction:column;gap:4px;max-width:min(560px,80%);min-width:0}
.bcs-row.right .bcs-msg{align-items:flex-end}
.bcs-msg-head{display:flex;align-items:center;gap:7px;font-size:var(--text-xs);color:var(--ink-muted);min-width:0}
.bcs-msg-name{font-weight:var(--weight-medium);color:var(--ink-secondary);white-space:nowrap}
.bcs-msg-eyebrow{font-family:var(--font-mono);font-size:10px;color:var(--status-warning-ink);background:var(--status-warning-bg);border:1px solid var(--status-warning-border);border-radius:var(--radius-xs);padding:0 5px;white-space:nowrap}
.bcs-msg-time{font-family:var(--font-mono);font-size:10px;color:var(--ink-faint);font-variant-numeric:tabular-nums;flex:0 0 auto}
.bcs-bubble{padding:9px 13px;font-size:var(--text-base);line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.bcs-bubble.bot{background:#F4F4F5;border:1px solid #EBEBEB;color:var(--ink-primary);border-radius:16px;border-bottom-left-radius:4px}
.bcs-row.right .bcs-bubble.bot{border-radius:16px;border-bottom-right-radius:4px}
.bcs-bubble.human{background:#D95D22;color:#FFFFFF;border-radius:16px;border-bottom-right-radius:4px}
.bcs-avatar-fallback{width:28px;height:28px;border-radius:8px;background:var(--bg-surface-subtle);border:var(--hairline);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:var(--weight-semibold);color:var(--ink-muted);flex:0 0 auto}
.bcs-system{display:flex;justify-content:center;margin:8px 0 14px}
.bcs-system>span{font-family:var(--font-mono);font-size:var(--text-2xs);color:var(--ink-faint);text-align:center}
.bcs-trace{margin:0 0 14px}
.bcs-trace-head{display:flex;align-items:center;gap:6px;font-family:var(--font-mono);font-size:11px;color:var(--ink-muted);background:none;border:none;cursor:pointer;padding:3px 7px;border-radius:var(--radius-sm);font-variant-numeric:tabular-nums;transition:background var(--duration-fast) var(--ease-out-quiet),color var(--duration-fast) var(--ease-out-quiet)}
.bcs-trace-head:hover{background:var(--bg-hover);color:var(--ink-secondary)}
.bcs-chev{flex:0 0 auto;color:var(--ink-faint);transition:transform var(--duration-fast) var(--ease-out-quiet)}
.bcs-chev.open{transform:rotate(90deg)}
.bcs-trace-body{margin:4px 0 4px 10px;border-left:1px solid var(--border-hairline);padding:6px 2px 6px 12px;display:flex;flex-direction:column;gap:6px}
.bcs-trace-line{font-family:var(--font-mono);font-size:11px;color:var(--ink-secondary);line-height:1.55;white-space:pre-wrap;word-break:break-word;display:flex;gap:7px;align-items:baseline}
.bcs-trace-kind{color:var(--ink-faint);text-transform:uppercase;font-size:9.5px;letter-spacing:.06em;flex:0 0 auto}
.bcs-trace-diff{margin-left:auto;font-family:var(--font-mono);font-size:10px;color:var(--status-active-ink);background:var(--status-active-bg);border:1px solid var(--status-active-border);border-radius:var(--radius-xs);padding:0 5px;cursor:pointer;flex:0 0 auto}
.bcs-artifact{display:flex;align-items:center;gap:9px;max-width:440px;margin:0 0 14px;padding:8px 11px;background:var(--bg-canvas);border:var(--hairline);border-radius:var(--radius-md);cursor:pointer;text-align:left;transition:border-color var(--duration-fast) var(--ease-out-quiet),box-shadow var(--duration-fast) var(--ease-out-quiet)}
.bcs-artifact:hover{border-color:var(--border-strong);box-shadow:0 1px 3px rgba(23,23,23,.05)}
.bcs-artifact-ic{display:flex;color:var(--ink-muted);flex:0 0 auto}
.bcs-artifact-name{font-size:12.5px;font-weight:var(--weight-medium);color:var(--ink-primary);white-space:nowrap}
.bcs-artifact-path{font-family:var(--font-mono);font-size:11px;color:var(--ink-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.bcs-artifact-sep{color:var(--ink-faint);flex:0 0 auto}
.bcs-verify{display:flex;align-items:center;gap:8px;margin:0 0 14px;flex-wrap:wrap}
.bcs-verify-chip{font-family:var(--font-mono);font-size:10.5px;font-weight:var(--weight-medium);border-radius:var(--radius-sm);padding:2px 8px;border:1px solid;white-space:nowrap;font-variant-numeric:tabular-nums}
.bcs-verify[data-verdict="pass"] .bcs-verify-chip{color:var(--status-success-ink);background:var(--status-success-bg);border-color:var(--status-success-border)}
.bcs-verify[data-verdict="fail"] .bcs-verify-chip{color:var(--status-danger-ink);background:var(--status-danger-bg);border-color:var(--status-danger-border)}
.bcs-verify[data-verdict="needs_human"] .bcs-verify-chip{color:var(--status-warning-ink);background:var(--status-warning-bg);border-color:var(--status-warning-border)}
.bcs-verify-tag{font-family:var(--font-mono);font-size:10px;color:var(--status-active-ink);background:var(--status-active-bg);border:1px solid var(--status-active-border);border-radius:var(--radius-xs);padding:1px 5px;white-space:nowrap}
.bcs-verify-name{font-size:var(--text-2xs);color:var(--ink-secondary);white-space:nowrap}
.bcs-verify-sum{font-size:var(--text-2xs);color:var(--ink-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.bcs-progress{max-width:560px;margin:2px 0 16px;border:var(--hairline);border-radius:var(--radius-md);background:var(--bg-surface);overflow:hidden}
.bcs-progress-head{display:flex;align-items:center;gap:8px;width:100%;padding:8px 11px;font-size:12.5px;color:var(--ink-secondary);text-align:left;background:none;border:none;cursor:pointer;transition:background var(--duration-fast) var(--ease-out-quiet)}
.bcs-progress-head:hover{background:var(--bg-hover)}
.bcs-progress-head>svg{color:var(--ink-muted);flex:0 0 auto}
.bcs-progress-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.bcs-progress-count{margin-left:auto;font-family:var(--font-mono);font-size:11px;color:var(--ink-muted);font-variant-numeric:tabular-nums;flex:0 0 auto}
.bcs-progress-body{border-top:var(--hairline);padding:6px 8px;display:flex;flex-direction:column;gap:2px;background:var(--bg-canvas)}
.bcs-task{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:var(--radius-sm);font-size:var(--text-xs)}
.bcs-task:hover{background:var(--bg-surface)}
.bcs-task-status{font-family:var(--font-mono);font-size:10px;color:var(--ink-muted);background:var(--bg-surface-subtle);border:var(--hairline-subtle);border-radius:var(--radius-xs);padding:1px 5px;flex:0 0 auto;text-transform:uppercase;letter-spacing:.04em}
.bcs-task-status[data-status="verified"],.bcs-task-status[data-status="merged"]{color:var(--status-success-ink);background:var(--status-success-bg);border-color:var(--status-success-border)}
.bcs-task-status[data-status="in_review"]{color:var(--status-active-ink);background:var(--status-active-bg);border-color:var(--status-active-border)}
.bcs-task-status[data-status="blocked"]{color:var(--status-danger-ink);background:var(--status-danger-bg);border-color:var(--status-danger-border)}
.bcs-task-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-secondary);min-width:0}
.bcs-task-btn{display:inline-flex;align-items:center;gap:4px;font-size:var(--text-2xs);font-weight:var(--weight-medium);color:var(--ink-secondary);background:var(--bg-canvas);border:var(--hairline);border-radius:var(--radius-sm);padding:3px 8px;cursor:pointer;flex:0 0 auto;transition:all var(--duration-fast) var(--ease-out-quiet)}
.bcs-task-btn:hover:not(:disabled){border-color:var(--border-strong);background:var(--bg-hover);color:var(--ink-primary)}
.bcs-task-btn:disabled{opacity:.45;cursor:not-allowed}
.bcs-progress-foot{display:flex;justify-content:flex-end;padding:4px 4px 2px}
.bcs-team-pill-wrap{display:flex;justify-content:center;margin:16px 0}
.bcs-team-pill{display:inline-flex;align-items:center;gap:8px;padding:5px 13px;border-radius:var(--radius-pill);background:var(--bg-surface);border:var(--hairline);font-size:var(--text-xs);color:var(--ink-secondary);cursor:pointer;transition:all var(--duration-fast) var(--ease-out-quiet)}
.bcs-team-pill:hover{background:var(--bg-hover);border-color:var(--border-strong);color:var(--ink-primary)}
.bcs-team-pill>svg{color:var(--ink-faint)}
.bcs-live{display:flex;align-items:center;gap:9px;margin-top:4px;padding:9px 4px 2px;border-top:1px dashed var(--border-hairline)}
.bcs-live-text{font-size:var(--text-xs);color:var(--ink-muted)}
.bcs-live-more{display:flex;justify-content:flex-start;padding:2px 0 0 37px;font-family:var(--font-mono);font-size:10px;color:var(--ink-faint)}
`;

export function BotChatStream({
  mode,
  project,
  activeAgent,
  agents,
  timeline,
  tasks,
  debates,
  debateMessages,
  verifications,
  artifacts,
  onOpenArtifactInBrowser,
  onOpenDiffInBrowser,
  onVerifyTask,
  onDispatchTask,
  onOpenGroupRoom,
}: BotChatStreamProps): JSX.Element {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pendingTaskAction, setPendingTaskAction] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const toggle = (key: string) => setExpanded((m) => ({ ...m, [key]: !m[key] }));

  const agentById = useMemo(() => {
    const map = new Map<string, AgentRecord>();
    for (const a of agents) map.set(a.id, a);
    if (activeAgent && !map.has(activeAgent.id)) map.set(activeAgent.id, activeAgent);
    return map;
  }, [agents, activeAgent]);

  const speakerFor = (agentId: string | null, isHuman: boolean, steer: boolean): SpeakerInfo => {
    if (isHuman) {
      return {
        human: true,
        name: mode === "group" ? "Human" : steer ? "Steer → PM" : "Du",
        meta: null,
        agent: null,
      };
    }
    const agent = (agentId ? agentById.get(agentId) : undefined) ?? activeAgent;
    if (!agent) return { human: false, name: "Bot", meta: null, agent: null };
    let meta: ResolvedBotMeta | null = null;
    try {
      meta = resolveBotRole(agent);
    } catch {
      meta = null;
    }
    return { human: false, name: agent.name, meta, agent };
  };

  const sideFor = (speaker: SpeakerInfo): "left" | "right" => {
    if (speaker.human) return "right";
    if (mode === "single") return "left";
    const { agent, meta } = speaker;
    if (agent && (agent.scope === "verifier" || agent.scope === "project")) return "right";
    if (meta && RIGHT_SIDE_ROLE.test(meta.role)) return "right";
    return "left";
  };

  const feed = useMemo<FeedNode[]>(() => {
    const raw: RawEvent[] = [];
    let ord = 0;

    for (const item of timeline) {
      raw.push({ ts: item.createdAt, ord: ord++, type: "timeline", item });
    }

    if (mode === "group") {
      for (const d of debates) {
        raw.push({
          ts: d.createdAt,
          ord: ord++,
          type: "system",
          text: `Debatte geöffnet — ${d.topic}`,
        });
        for (const m of debateMessages[d.id] ?? []) {
          raw.push({ ts: m.createdAt, ord: ord++, type: "debate_msg", msg: m, debate: d });
        }
        if (d.status !== "open") {
          raw.push({
            ts: d.updatedAt,
            ord: ord++,
            type: "system",
            text:
              d.status === "resolved"
                ? `Debatte geschlossen — ${d.resolutionSummary ?? d.topic}`
                : `Debatte eskaliert — ${d.topic}`,
          });
        }
      }
    }

    for (const r of verifications) {
      raw.push({ ts: r.createdAt, ord: ord++, type: "verify", report: r });
    }
    for (const a of artifacts) {
      raw.push({ ts: a.updatedAt, ord: ord++, type: "artifact", artifact: a });
    }

    raw.sort((x, y) => (x.ts !== y.ts ? x.ts - y.ts : x.ord - y.ord));

    const nodes: FeedNode[] = [];
    let traceBuf: TimelineItem[] = [];
    let lastTs: number | null = null;
    let lastDay = "";

    const flushTrace = () => {
      if (traceBuf.length === 0) return;
      nodes.push({ kind: "trace", key: `trace-${traceBuf[0].id}`, ts: traceBuf[0].createdAt, items: traceBuf });
      traceBuf = [];
    };

    const maybeSep = (ts: number) => {
      const day = dayStamp(new Date(ts));
      if (lastTs === null || ts - lastTs > SEP_GAP_MS || day !== lastDay) {
        nodes.push({ kind: "sep", key: `sep-${ts}`, label: sepLabel(ts) });
      }
      lastTs = ts;
      lastDay = day;
    };

    for (const ev of raw) {
      if (ev.type === "timeline") {
        const item = ev.item;
        if (TRACE_KINDS.has(item.kind)) {
          maybeSep(ev.ts);
          traceBuf.push(item);
          continue;
        }
        flushTrace();
        maybeSep(ev.ts);
        if (item.kind === "handoff") {
          nodes.push({
            kind: "system",
            key: `sys-${item.id}`,
            ts: ev.ts,
            text: `Übergabe → ${item.title ?? item.content}`,
          });
        } else if (item.role === "system" && item.kind !== "steer") {
          nodes.push({ kind: "system", key: `sys-${item.id}`, ts: ev.ts, text: item.content });
        } else {
          const isHuman = item.role === "user" || item.kind === "steer";
          const speaker = speakerFor(item.agentId, isHuman, item.kind === "steer");
          nodes.push({
            kind: "msg",
            key: `msg-${item.id}`,
            ts: ev.ts,
            side: sideFor(speaker),
            speaker,
            text: item.content,
          });
        }
        continue;
      }

      flushTrace();
      maybeSep(ev.ts);
      if (ev.type === "debate_msg") {
        const speaker = speakerFor(ev.msg.agentId, false, false);
        nodes.push({
          kind: "msg",
          key: `dmsg-${ev.msg.id}`,
          ts: ev.ts,
          side: sideFor(speaker),
          speaker,
          text: ev.msg.position + (ev.msg.evidence ? `\n\nBeleg: ${ev.msg.evidence}` : ""),
          eyebrow: `Debatte · R${ev.msg.roundNum}`,
        });
      } else if (ev.type === "system") {
        nodes.push({ kind: "system", key: `sys-ev-${ev.ord}`, ts: ev.ts, text: ev.text });
      } else if (ev.type === "verify") {
        nodes.push({ kind: "verify", key: `ver-${ev.report.id}`, ts: ev.ts, report: ev.report });
      } else if (ev.type === "artifact") {
        nodes.push({ kind: "artifact", key: `art-${ev.artifact.relativePath}`, ts: ev.ts, artifact: ev.artifact });
      }
    }
    flushTrace();
    return nodes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, debates, debateMessages, verifications, artifacts, mode, agentById, activeAgent]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [feed.length]);

  const doneTasks = tasks.filter((t) => t.status === "verified" || t.status === "merged").length;
  const workingAgents =
    mode === "single"
      ? activeAgent?.status === "working"
        ? [activeAgent]
        : []
      : agents.filter((a) => a.status === "working");

  const runTaskAction = async (key: string, fn: () => Promise<void>) => {
    if (pendingTaskAction) return;
    setPendingTaskAction(key);
    try {
      await fn();
    } finally {
      setPendingTaskAction(null);
    }
  };

  const traceToolCalls = (items: TimelineItem[]) =>
    items.filter((i) => i.kind === "tool_call" || i.kind === "terminal").length;

  return (
    <div className="bcs-root">
      <style>{BCS_CSS}</style>

      {feed.length === 0 && (
        <div className="bcs-empty">
          <BotThinkingOrb
            activity="breathing"
            size={64}
            label={mode === "group" ? "Team-Raum bereit" : "Bot bereit"}
          />
          <div className="bcs-empty-title">
            {mode === "group" ? "Team-Raum" : (activeAgent?.name ?? "Bot")}
          </div>
          <div className="bcs-empty-sub">
            {mode === "group"
              ? "Noch keine Team-Aktivität — Nachrichten, Debatten und Verifier-Urteile erscheinen hier chronologisch."
              : "Noch keine Nachrichten — Timeline-Events und Antworten des Bots erscheinen hier."}
          </div>
        </div>
      )}

      {feed.map((node) => {
        if (node.kind === "sep") {
          return (
            <div key={node.key} className="bcs-time-sep">
              <span>{node.label}</span>
            </div>
          );
        }

        if (node.kind === "system") {
          return (
            <div key={node.key} className="bcs-system">
              <span>{node.text}</span>
            </div>
          );
        }

        if (node.kind === "msg") {
          const { speaker } = node;
          return (
            <div key={node.key} className={`bcs-row ${node.side}`}>
              {!speaker.human &&
                (speaker.meta ? (
                  <BotAvatar
                    role={speaker.meta.role}
                    size={28}
                    active={speaker.agent?.status === "working"}
                  />
                ) : (
                  <span className="bcs-avatar-fallback">
                    {speaker.name.charAt(0).toUpperCase()}
                  </span>
                ))}
              <div className="bcs-msg">
                <div className="bcs-msg-head">
                  <span className="bcs-msg-name">{speaker.name}</span>
                  {!speaker.human && (speaker.meta || speaker.agent) && (
                    <JobTitlePill label={roleLabel(speaker.meta, speaker.agent)} />
                  )}
                  {node.eyebrow && <span className="bcs-msg-eyebrow">{node.eyebrow}</span>}
                  <span className="bcs-msg-time">{timeLabel(node.ts)}</span>
                </div>
                <div className={`bcs-bubble ${speaker.human ? "human" : "bot"}`}>{node.text}</div>
              </div>
            </div>
          );
        }

        if (node.kind === "trace") {
          const open = Boolean(expanded[node.key]);
          const toolCalls = traceToolCalls(node.items);
          return (
            <div key={node.key} className="bcs-trace">
              <button
                type="button"
                className="bcs-trace-head"
                onClick={() => toggle(node.key)}
                aria-expanded={open}
              >
                <span>
                  {node.items.length} {node.items.length === 1 ? "Schritt" : "Schritte"}
                  {" · "}
                  {toolCalls} {toolCalls === 1 ? "Tool-Aufruf" : "Tool-Aufrufe"}
                </span>
                <ChevronRight size={11} strokeWidth={1.6} className={`bcs-chev ${open ? "open" : ""}`} />
              </button>
              {open && (
                <div className="bcs-trace-body">
                  {node.items.map((i) => (
                    <div key={i.id} className="bcs-trace-line">
                      <span className="bcs-trace-kind">{i.kind}</span>
                      <span>
                        {i.title ? `${i.title} — ` : ""}
                        {i.content}
                        {i.exitCode !== null && i.exitCode !== undefined
                          ? ` (exit ${i.exitCode})`
                          : ""}
                      </span>
                      {i.diffPreview && (
                        <button
                          type="button"
                          className="bcs-trace-diff"
                          onClick={onOpenDiffInBrowser}
                        >
                          Diff
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        }

        if (node.kind === "artifact") {
          const a = node.artifact;
          return (
            <button
              type="button"
              key={node.key}
              className="bcs-artifact"
              onClick={() => onOpenArtifactInBrowser(a)}
              title={`${a.relativePath} im Browser öffnen`}
            >
              <span className="bcs-artifact-ic">{artifactIcon(a)}</span>
              <span className="bcs-artifact-name">{a.name}</span>
              <span className="bcs-artifact-sep">·</span>
              <span className="bcs-artifact-path">{a.relativePath}</span>
              <ArrowUpRight size={12} strokeWidth={1.6} style={{ marginLeft: "auto", color: "var(--ink-faint)", flex: "0 0 auto" }} />
            </button>
          );
        }

        if (node.kind === "verify") {
          const r = node.report;
          const verifier = agentById.get(r.verifierAgentId);
          return (
            <div key={node.key} className="bcs-verify" data-verdict={r.verdict}>
              <span className="bcs-verify-chip">Verifier · {VERDICT_LABEL[r.verdict]}</span>
              {r.crossFamily && <span className="bcs-verify-tag">cross-family</span>}
              {verifier && <span className="bcs-verify-name">{verifier.name}</span>}
              {r.summary && <span className="bcs-verify-sum">{r.summary}</span>}
            </div>
          );
        }

        return null;
      })}

      {tasks.length > 0 && (
        <div className="bcs-progress">
          <button
            type="button"
            className="bcs-progress-head"
            onClick={() => toggle("bcs-progress")}
            aria-expanded={Boolean(expanded["bcs-progress"])}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
              <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M6 1a5 5 0 0 1 0 10z" fill="currentColor" />
            </svg>
            <span className="bcs-progress-title">{project.name} — Team-Fortschritt</span>
            <span className="bcs-progress-count">
              {doneTasks}/{tasks.length}
            </span>
            <ChevronRight
              size={11}
              strokeWidth={1.6}
              className={`bcs-chev ${expanded["bcs-progress"] ? "open" : ""}`}
            />
          </button>
          {expanded["bcs-progress"] && (
            <div className="bcs-progress-body">
              {tasks.map((t) => (
                <div key={t.id} className="bcs-task">
                  <span className="bcs-task-status" data-status={t.status}>
                    {t.status}
                  </span>
                  <span className="bcs-task-title">{t.title}</span>
                  {(t.status === "ready" || t.status === "backlog") && (
                    <button
                      type="button"
                      className="bcs-task-btn"
                      disabled={pendingTaskAction !== null}
                      onClick={() =>
                        void runTaskAction(`dispatch-${t.id}`, () => onDispatchTask(t.id))
                      }
                    >
                      Vergeben
                    </button>
                  )}
                  {t.status === "in_review" && (
                    <button
                      type="button"
                      className="bcs-task-btn"
                      disabled={pendingTaskAction !== null}
                      onClick={() =>
                        void runTaskAction(`verify-${t.id}`, () => onVerifyTask(t.id))
                      }
                    >
                      Verify (Fresh)
                    </button>
                  )}
                </div>
              ))}
              <div className="bcs-progress-foot">
                <button type="button" className="bcs-task-btn" onClick={onOpenDiffInBrowser}>
                  Diff im Browser
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {mode === "single" && agents.length > 1 && onOpenGroupRoom && (
        <div className="bcs-team-pill-wrap">
          <button type="button" className="bcs-team-pill" onClick={onOpenGroupRoom}>
            <span>{agents.length} Bots im Team</span>
            <GroupAvatarCluster
              roles={agents.slice(0, 4).map((a) => resolveBotRole(a).role)}
              size={18}
            />
            <span>Gruppenchat öffnen</span>
            <ArrowUpRight size={11} strokeWidth={1.6} />
          </button>
        </div>
      )}

      {workingAgents.slice(0, 3).map((a) => {
        let liveMeta: ResolvedBotMeta | null = null;
        try {
          liveMeta = resolveBotRole(a);
        } catch {
          liveMeta = null;
        }
        return (
          <div key={a.id} className="bcs-live">
            {liveMeta ? (
              <BotAvatar role={liveMeta.role} size={28} active />
            ) : (
              <span className="bcs-avatar-fallback">{a.name.charAt(0).toUpperCase()}</span>
            )}
            <BotThinkingOrb status="working" size={20} shell={false} />
            <span className="bcs-live-text">
              {a.name} arbeitet {a.worktreeBranch ? `auf ${a.worktreeBranch}` : "im Worktree"}…
            </span>
          </div>
        );
      })}
      {workingAgents.length > 3 && (
        <div className="bcs-live-more">+{workingAgents.length - 3} weitere arbeiten</div>
      )}

      <div ref={endRef} />
    </div>
  );
}
