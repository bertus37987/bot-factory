import type {
  AgentRecord,
  AnnotationRecord,
  ArtifactEntry,
  DebateMessageRecord,
  DebateRecord,
  ProjectRecord,
  TaskRecord,
  TimelineItem,
  VerificationReportRecord,
} from "@bot-factory/shared";
import { ArrowUpRight, AtSign, ChevronRight, CornerDownRight, GitMerge, Play, ShieldCheck } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  BotAvatar,
  GroupAvatarCluster,
  JobTitlePill,
  ROLE_META,
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
import { MarkdownRenderer } from "../components/MarkdownRenderer";

export interface BotChatStreamProps {
  mode: "single" | "group";
  project: ProjectRecord;
  activeAgent: AgentRecord | null;
  metaAgentId?: string | null;
  agents: AgentRecord[];
  timeline: TimelineItem[];
  streamingBotTextByAgent: Record<string, string>;
  streamingBotThoughtByAgent: Record<string, string>;
  tasks: TaskRecord[];
  annotations?: AnnotationRecord[];
  debates: DebateRecord[];
  debateMessages: Record<string, DebateMessageRecord[]>;
  verifications: VerificationReportRecord[];
  artifacts: ArtifactEntry[];
  onOpenArtifactInBrowser: (artifact: ArtifactEntry) => void;
  onOpenDiffInBrowser: (agentId?: string | null) => void;
  onVerifyTask: (taskId: string) => Promise<void>;
  onDispatchTask: (taskId: string) => Promise<void>;
  onMergeTask: (taskId: string) => Promise<void>;
  onSelectBot?: (agentId: string) => void;
  onInsertMention?: (botName: string) => void;
  onOpenGroupRoom?: () => void;
}

const TRACE_KINDS = new Set(["thought", "plan", "tool_call", "terminal", "status"]);
const SEP_GAP_MS = 45 * 60 * 1000;

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
  if (dayStamp(d) === dayStamp(now)) return `Today ${t}`;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (dayStamp(d) === dayStamp(yesterday)) return `Yesterday ${t}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${t}`;
}

function roleLabel(meta: ResolvedBotMeta | null, agent: AgentRecord | null): string {
  if (meta) return meta.jobTitle;
  switch (agent?.scope) {
    case "project":
      return "Team Lead";
    case "verifier":
      return "Verifier";
    case "peer":
      return "Peer";
    case "sidekick":
      return "Subagent";
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

function isSubagentMergeTrace(item: TimelineItem): boolean {
  const title = (item.title ?? "").toLowerCase();
  return title.includes("subagent patch") || title.includes("subagent merge");
}

function extractMentionedAgents(text: string, agents: AgentRecord[]): AgentRecord[] {
  if (!text.includes("@")) return [];
  const lower = text.toLowerCase();
  const matched: AgentRecord[] = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.id)) continue;
    const escaped = agent.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`@${escaped}(?![a-z0-9_-])`, "i");
    if (re.test(lower)) {
      seen.add(agent.id);
      matched.push(agent);
    }
  }
  return matched;
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

interface ReplyQuoteInfo {
  targetAgentId?: string | null;
  label: string;
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
      replyQuote?: ReplyQuoteInfo;
      diffAgentId?: string | null;
      hasDiff?: boolean;
      filePath?: string;
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

export function BotChatStream({
  mode,
  project,
  activeAgent,
  metaAgentId,
  agents,
  timeline,
  streamingBotTextByAgent,
  streamingBotThoughtByAgent,
  tasks,
  annotations = [],
  debates,
  debateMessages,
  verifications,
  artifacts,
  onOpenArtifactInBrowser,
  onOpenDiffInBrowser,
  onVerifyTask,
  onDispatchTask,
  onMergeTask,
  onSelectBot,
  onInsertMention,
  onOpenGroupRoom,
}: BotChatStreamProps): JSX.Element {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pendingTaskAction, setPendingTaskAction] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);

  const toggle = (key: string) => setExpanded((m) => ({ ...m, [key]: !m[key] }));

  const agentById = useMemo(() => {
    const map = new Map<string, AgentRecord>();
    for (const a of agents) map.set(a.id, a);
    if (activeAgent && !map.has(activeAgent.id)) map.set(activeAgent.id, activeAgent);
    return map;
  }, [agents, activeAgent]);

  const teamLead = useMemo(
    () => agents.find((a) => a.scope === "project") ?? null,
    [agents],
  );

  // In single-bot mode, scope verifications and artifacts strictly to the active bot
  const scopedVerifications = useMemo(() => {
    if (mode === "group") return verifications;
    if (!activeAgent) return [];
    const botTaskIds = new Set(tasks.filter((t) => t.assignedAgentId === activeAgent.id).map((t) => t.id));
    return verifications.filter(
      (r) =>
        r.verifierAgentId === activeAgent.id ||
        r.authorAgentId === activeAgent.id ||
        (r.targetKind === "task" && botTaskIds.has(r.targetId)),
    );
  }, [mode, verifications, activeAgent, tasks]);

  const scopedArtifacts = useMemo(() => {
    if (mode === "group") return artifacts;
    if (!activeAgent) return [];

    const botTasks = tasks.filter((t) => t.assignedAgentId === activeAgent.id);
    const botAnnotationIds = new Set(
      botTasks.map((t) => t.sourceAnnotationId).filter((id): id is string => Boolean(id)),
    );
    const linkedPaths = new Set<string>();
    for (const t of botTasks) {
      if (t.handoffPath) linkedPaths.add(t.handoffPath);
    }
    for (const ann of annotations) {
      if (botAnnotationIds.has(ann.id)) linkedPaths.add(ann.filePath);
    }
    for (const item of timeline) {
      if (item.filePath) linkedPaths.add(item.filePath);
    }

    const timelineHaystack = timeline
      .map((i) => `${i.title ?? ""}\n${i.content}`)
      .join("\n")
      .toLowerCase();
    const taskHaystack = botTasks.map((t) => `${t.title}\n${t.specMd}`).join("\n").toLowerCase();

    return artifacts.filter((a) => {
      if (linkedPaths.has(a.relativePath)) return true;
      if (activeAgent.scope === "project" && a.relativePath.startsWith("plans/")) return true;
      const relLower = a.relativePath.toLowerCase();
      return timelineHaystack.includes(relLower) || taskHaystack.includes(relLower);
    });
  }, [mode, artifacts, activeAgent, tasks, annotations, timeline]);

  const speakerFor = (agentId: string | null, isHuman: boolean, steer: boolean): SpeakerInfo => {
    if (isHuman) {
      return {
        human: true,
        name: mode === "group" ? "You" : steer ? "You (Steer)" : "You",
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

  // Classic Messenger Multi-Role Alignment:
  // Right: You (user / steer)
  // Left: Main Agent (Orchestrator) & all Engineering Bots / Subagent Cubs
  const sideFor = (speaker: SpeakerInfo): "left" | "right" => {
    return speaker.human ? "right" : "left";
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
          text: `Debate opened — ${d.topic}`,
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
                ? `Debate resolved — ${d.resolutionSummary ?? d.topic}`
                : `Debate escalated to Team Lead — ${d.topic}`,
          });
        }
      }
    }

    for (const r of scopedVerifications) {
      raw.push({ ts: r.createdAt, ord: ord++, type: "verify", report: r });
    }
    for (const a of scopedArtifacts) {
      raw.push({ ts: a.updatedAt, ord: ord++, type: "artifact", artifact: a });
    }

    raw.sort((x, y) => (x.ts !== y.ts ? x.ts - y.ts : x.ord - y.ord));

    const nodes: FeedNode[] = [];
    let traceBuf: TimelineItem[] = [];
    let lastTs: number | null = null;
    let lastDay = "";
    const lastMessageBySpeaker = new Map<string, { name: string; snippet: string }>();

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
            text: `Handoff -> ${item.title ?? item.content}`,
          });
        } else {
          const isOrchestrator =
            item.senderRole === "orchestrator" ||
            Boolean(metaAgentId && item.senderAgentId === metaAgentId) ||
            Boolean(item.title?.startsWith("Main Manager Delegation"));

          if (!isOrchestrator && item.role === "system" && item.kind !== "steer") {
            nodes.push({ kind: "system", key: `sys-${item.id}`, ts: ev.ts, text: item.content });
          } else {
            const isHuman =
              !isOrchestrator &&
              (item.senderRole === "user" || item.role === "user" || item.kind === "steer");
            const targetBot = agentById.get(item.agentId) ?? activeAgent;
            const speaker: SpeakerInfo = isOrchestrator
              ? {
                  human: false,
                  name: "Main Agent",
                  meta: { role: "orchestrator", ...ROLE_META.orchestrator },
                  agent: null,
                }
              : speakerFor(item.senderAgentId ?? item.agentId, isHuman, item.kind === "steer");

            const mentioned = extractMentionedAgents(item.content, agents);
            let eyebrow: string | undefined;
            if (isOrchestrator) {
              eyebrow = targetBot
                ? `Orchestrator -> ${targetBot.name}`
                : item.title || "Orchestrator -> Target Bot";
            }

            let replyQuote: ReplyQuoteInfo | undefined;
            if (isOrchestrator && item.title?.startsWith("Main Manager Delegation")) {
              replyQuote = {
                targetAgentId: targetBot?.id,
                label: item.title,
              };
            } else if (item.kind === "steer" && teamLead) {
              replyQuote = {
                targetAgentId: teamLead.id,
                label: `Steer -> @${teamLead.name}`,
              };
            } else if (mentioned.length > 0) {
              const firstTarget = mentioned[0]!;
              const prevMsg = lastMessageBySpeaker.get(firstTarget.id);
              replyQuote = {
                targetAgentId: firstTarget.id,
                label: prevMsg
                  ? `${firstTarget.name}: "${prevMsg.snippet}"`
                  : `Directed to @${firstTarget.name}`,
              };
            } else if (speaker.agent?.parentAgentId && speaker.agent.scope === "sidekick") {
              const parent = agentById.get(speaker.agent.parentAgentId);
              if (parent) {
                replyQuote = {
                  targetAgentId: parent.id,
                  label: `Subagent reporting to ${parent.name}`,
                };
              }
            }

            const snippet = item.content.replace(/\s+/g, " ").trim().slice(0, 76);
            if (speaker.agent && snippet) {
              lastMessageBySpeaker.set(speaker.agent.id, { name: speaker.name, snippet });
            }

            nodes.push({
              kind: "msg",
              key: `msg-${item.id}`,
              ts: ev.ts,
              side: sideFor(speaker),
              speaker,
              text: item.content,
              eyebrow,
              replyQuote,
              diffAgentId: item.agentId,
              hasDiff: Boolean(item.diffPreview),
              filePath: item.filePath,
            });
          }
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
          text: ev.msg.position + (ev.msg.evidence ? `\n\nEvidence: ${ev.msg.evidence}` : ""),
          eyebrow: `Debate · R${ev.msg.roundNum}`,
          replyQuote: {
            label: `Debate: ${ev.debate.topic}`,
          },
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
  }, [timeline, debates, debateMessages, scopedVerifications, scopedArtifacts, mode, agentById, activeAgent, agents, teamLead, metaAgentId]);

  // Active streaming bubbles
  const streamingEntries = useMemo(() => {
    const candidates = mode === "single" ? (activeAgent ? [activeAgent] : []) : agents;
    const out: Array<{ agent: AgentRecord; text: string; thought: string }> = [];
    for (const ag of candidates) {
      const text = streamingBotTextByAgent[ag.id] ?? "";
      const thought = streamingBotThoughtByAgent[ag.id] ?? "";
      if (text.trim().length > 0 || thought.trim().length > 0) {
        out.push({ agent: ag, text, thought });
      }
    }
    return out;
  }, [mode, activeAgent, agents, streamingBotTextByAgent, streamingBotThoughtByAgent]);

  const jumpToLatest = () => {
    const viewport = streamRef.current?.parentElement;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
    followingRef.current = true;
    setFollowing(true);
  };

  useLayoutEffect(() => {
    const stream = streamRef.current;
    const viewport = stream?.parentElement;
    if (!stream || !viewport) return;
    const follow = () => {
      if (followingRef.current) viewport.scrollTop = viewport.scrollHeight;
    };
    const onScroll = () => {
      if (!viewport.clientHeight) return;
      followingRef.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 56;
      setFollowing(followingRef.current);
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(stream);
    observer.observe(viewport);
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", onScroll);
    };
  }, []);

  const doneTasks = tasks.filter((t) => t.status === "verified" || t.status === "merged").length;
  const streamingIds = new Set(streamingEntries.map((e) => e.agent.id));
  const workingAgents =
    mode === "single"
      ? activeAgent?.status === "working" && !streamingIds.has(activeAgent.id)
        ? [activeAgent]
        : []
      : agents.filter((a) => a.status === "working" && !streamingIds.has(a.id));

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

  const traceSubagentMerges = (items: TimelineItem[]) =>
    items.filter((i) => isSubagentMergeTrace(i)).length;

  const handleMentionAction = (agent: AgentRecord) => {
    if (onSelectBot) {
      onSelectBot(agent.id);
    } else if (onInsertMention) {
      onInsertMention(agent.name);
    }
  };

  return (
    <div className="bcs-root" ref={streamRef}>
      {!following && (
        <div className="bots-jump-slot">
          <button type="button" className="btn xs" onClick={jumpToLatest}>Jump to Latest</button>
        </div>
      )}
      {feed.length === 0 && streamingEntries.length === 0 && (
        <div className="bcs-empty">
          <BotThinkingOrb
            activity="breathing"
            size={64}
            label={mode === "group" ? "Team channel ready" : "Bot ready"}
          />
          <div className="bcs-empty-title">
            {mode === "group" ? `${project.name} · Group Chat` : (activeAgent?.name ?? "Bot")}
          </div>
          <div className="bcs-empty-sub">
            {mode === "group"
              ? "No team messages yet — Team Lead steers, specialist replies, subagent merges, and verification verdicts appear here chronologically."
              : "No timeline events yet — messages, tool traces, and bot-scoped artifacts appear here."}
          </div>
        </div>
      )}

      {feed.map((node, index) => {
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
          const previous = feed[index - 1];
          const grouped =
            previous?.kind === "msg" &&
            previous.speaker.name === speaker.name &&
            previous.speaker.agent?.id === speaker.agent?.id &&
            previous.speaker.human === speaker.human &&
            previous.diffAgentId === node.diffAgentId &&
            node.ts - previous.ts < 120_000 &&
            !node.eyebrow && !previous.eyebrow &&
            !node.replyQuote && !previous.replyQuote &&
            !node.filePath && !previous.filePath &&
            !node.hasDiff && !previous.hasDiff;
          const mentionedBots = extractMentionedAgents(node.text, agents);
          const referencedArtifact = node.filePath
            ? artifacts.find((a) => a.relativePath === node.filePath) ?? null
            : null;
          const bubbleRoleClass = !speaker.human && speaker.meta ? `role-${speaker.meta.role}` : "";

          return (
            <div
              key={node.key}
              className={`group-msg-row ${node.side === "right" ? "side-right msg-side-right" : "side-left msg-side-left"}${grouped ? " bots-continuation" : ""}`}
            >
              {!speaker.human && !grouped &&
                (speaker.meta ? (
                  <button
                    type="button"
                    onClick={() => speaker.agent && onSelectBot?.(speaker.agent.id)}
                    title={
                      speaker.agent
                        ? `Open ${speaker.name} timeline`
                        : `${speaker.name} (${speaker.meta.jobTitle})`
                    }
                    style={{
                      padding: 0,
                      border: "none",
                      background: "transparent",
                      cursor: speaker.agent && onSelectBot ? "pointer" : "default",
                      flexShrink: 0,
                      display: "inline-flex",
                    }}
                  >
                    <BotAvatar
                      role={speaker.meta.role}
                      size={30}
                      active={speaker.agent?.status === "working"}
                      agentStatus={speaker.agent?.status}
                      seed={speaker.agent?.id ?? speaker.meta.role}
                    />
                  </button>
                ) : (
                  <span className="bcs-avatar-fallback" style={{ borderRadius: "9999px" }}>
                    {speaker.name.charAt(0).toUpperCase()}
                  </span>
                ))}

              <div className="group-msg-stack">
                {!grouped && <div className="bcs-msg-head">
                  <span className="bcs-msg-name">{speaker.name}</span>
                  {!speaker.human && (speaker.meta || speaker.agent) && (
                    <JobTitlePill
                      label={roleLabel(speaker.meta, speaker.agent)}
                      role={speaker.meta?.role}
                      tone={
                        speaker.meta?.role === "orchestrator" || speaker.agent?.scope === "project"
                          ? "accent"
                          : "neutral"
                      }
                    />
                  )}
                  {node.eyebrow && <span className="bcs-msg-eyebrow">{node.eyebrow}</span>}
                  <time className="bcs-msg-time" dateTime={new Date(node.ts).toISOString()}>{timeLabel(node.ts)}</time>
                  {!speaker.human && speaker.agent && onInsertMention && (
                    <button
                      type="button"
                      className="mention-chip"
                      onClick={() => onInsertMention(speaker.agent!.name)}
                      title={`Mention @${speaker.agent.name} in composer`}
                    >
                      <AtSign size={10} strokeWidth={1.8} />
                      <span>{speaker.agent.name}</span>
                    </button>
                  )}
                </div>}

                {node.replyQuote && (
                  <div
                    className="reply-quote-bar"
                    style={{ cursor: node.replyQuote.targetAgentId && onSelectBot ? "pointer" : "default" }}
                    onClick={() => {
                      if (node.replyQuote?.targetAgentId) {
                        onSelectBot?.(node.replyQuote.targetAgentId);
                      }
                    }}
                  >
                    <CornerDownRight size={11} strokeWidth={1.7} style={{ flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{node.replyQuote.label}</span>
                  </div>
                )}

                <div
                  className={`bcs-bubble ${speaker.human ? "human" : `bot ${bubbleRoleClass}`.trim()}`}
                  title={grouped ? `${speaker.name} · ${timeLabel(node.ts)}` : undefined}
                >
                  {grouped && <span className="bots-visually-hidden">{speaker.name}, {timeLabel(node.ts)}: </span>}
                  {speaker.human ? (
                    <div style={{ whiteSpace: "pre-wrap" }}>{node.text}</div>
                  ) : (
                    <MarkdownRenderer content={node.text} />
                  )}
                </div>

                {(mentionedBots.length > 0 || node.hasDiff || referencedArtifact) && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                    {mentionedBots.map((mBot) => (
                      <button
                        key={mBot.id}
                        type="button"
                        className="mention-chip"
                        onClick={() => handleMentionAction(mBot)}
                        title={onSelectBot ? `Jump to ${mBot.name}` : `Mention @${mBot.name}`}
                      >
                        @{mBot.name}
                      </button>
                    ))}
                    {node.hasDiff && (
                      <button
                        type="button"
                        className="bcs-trace-diff"
                        onClick={() => onOpenDiffInBrowser(node.diffAgentId)}
                      >
                        View Diff
                      </button>
                    )}
                    {referencedArtifact && (
                      <button
                        type="button"
                        className="bcs-task-btn"
                        onClick={() => onOpenArtifactInBrowser(referencedArtifact)}
                      >
                        {artifactIcon(referencedArtifact)}
                        <span>{referencedArtifact.name}</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        }

        if (node.kind === "trace") {
          const open = Boolean(expanded[node.key]);
          const toolCalls = traceToolCalls(node.items);
          const subagentMerges = traceSubagentMerges(node.items);
          return (
            <div key={node.key} className="bcs-trace">
              <button
                type="button"
                className="bcs-trace-head"
                onClick={() => toggle(node.key)}
                aria-expanded={open}
              >
                <span>
                  {node.items.length} {node.items.length === 1 ? "step" : "steps"}
                  {" · "}
                  {toolCalls} {toolCalls === 1 ? "tool call" : "tool calls"}
                  {subagentMerges > 0
                    ? ` · ${subagentMerges} subagent ${subagentMerges === 1 ? "merge" : "merges"}`
                    : ""}
                </span>
                <ChevronRight size={11} strokeWidth={1.6} className={`bcs-chev ${open ? "open" : ""}`} />
              </button>
              {open && (
                <div className="bcs-trace-body">
                  {node.items.map((i) => {
                    const isSubMerge = isSubagentMergeTrace(i);
                    return (
                      <div key={i.id} className="bcs-trace-line">
                        <span className="bcs-trace-kind">
                          {isSubMerge ? "subagent merge" : i.kind}
                        </span>
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
                            onClick={() => onOpenDiffInBrowser(i.agentId)}
                          >
                            Diff
                          </button>
                        )}
                      </div>
                    );
                  })}
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
              title={`Open ${a.relativePath} in In-App Browser`}
            >
              <span className="bcs-artifact-ic">{artifactIcon(a)}</span>
              <span className="bcs-artifact-name">{a.name}</span>
              <span className="bcs-artifact-sep">·</span>
              <span className="bcs-artifact-path">{a.relativePath}</span>
              <ArrowUpRight
                size={12}
                strokeWidth={1.6}
                style={{ marginLeft: "auto", color: "var(--ink-faint)", flex: "0 0 auto" }}
              />
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

      {/* Live Streaming Bot Bubbles */}
      {streamingEntries.map(({ agent, text, thought }) => {
        let meta: ResolvedBotMeta | null = null;
        try {
          meta = resolveBotRole(agent);
        } catch {
          meta = null;
        }
        const side = "side-left msg-side-left";
        const streamRoleClass = meta ? `role-${meta.role}` : "";
        return (
          <div key={`stream-${agent.id}`} className={`group-msg-row ${side}`}>
            {meta ? (
              <span style={{ display: "inline-flex", flexShrink: 0 }}>
                <BotAvatar
                  role={meta.role}
                  size={30}
                  active
                  agentStatus={agent.status}
                  seed={agent.id}
                />
              </span>
            ) : (
              <span className="bcs-avatar-fallback" style={{ borderRadius: "9999px" }}>
                {agent.name.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="group-msg-stack">
              <div className="bcs-msg-head">
                <span className="bcs-msg-name">{agent.name}</span>
                <JobTitlePill
                  label={roleLabel(meta, agent)}
                  role={meta?.role}
                  tone={agent.scope === "project" ? "accent" : "neutral"}
                />
                <BotThinkingOrb activity={text ? "composing" : "solving"} size={20} shell={false} />
                <span className="bcs-msg-time">streaming</span>
              </div>
              {thought.trim().length > 0 && (
                <details className="bots-live-activity">
                  <summary>Live activity</summary>
                  <div className="chat-thought-pill">{thought}</div>
                </details>
              )}
              {text.trim().length > 0 && (
                <div className={`bcs-bubble bot ${streamRoleClass}`.trim()}>
                  <MarkdownRenderer content={text} />
                </div>
              )}
            </div>
          </div>
        );
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
            <span className="bcs-progress-title">{project.name} — Team Progress</span>
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
                      <Play size={10} strokeWidth={1.6} />
                      <span>Dispatch</span>
                    </button>
                  )}
                  {(t.status === "in_review" || t.status === "blocked") && (
                    <button
                      type="button"
                      className="bcs-task-btn"
                      disabled={pendingTaskAction !== null}
                      onClick={() =>
                        void runTaskAction(`verify-${t.id}`, () => onVerifyTask(t.id))
                      }
                    >
                      <ShieldCheck size={10} strokeWidth={1.6} />
                      <span>Verify (Fresh)</span>
                    </button>
                  )}
                  {t.status === "verified" && (
                    <button
                      type="button"
                      className="bcs-task-btn"
                      disabled={pendingTaskAction !== null}
                      onClick={() =>
                        void runTaskAction(`merge-${t.id}`, () => onMergeTask(t.id))
                      }
                    >
                      <GitMerge size={10} strokeWidth={1.6} />
                      <span>Merge</span>
                    </button>
                  )}
                </div>
              ))}
              <div className="bcs-progress-foot">
                <button
                  type="button"
                  className="bcs-task-btn"
                  onClick={() => onOpenDiffInBrowser(activeAgent?.id)}
                >
                  View Diff in Browser
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {mode === "single" && agents.length > 1 && onOpenGroupRoom && (
        <div className="bcs-team-pill-wrap">
          <button type="button" className="bcs-team-pill" onClick={onOpenGroupRoom}>
            <span>{agents.length} bots on team</span>
            <GroupAvatarCluster
              roles={agents.slice(0, 4).map((a) => resolveBotRole(a).role)}
              size={18}
            />
            <span>Open Group Chat</span>
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
              <span style={{ display: "inline-flex", flexShrink: 0 }}>
                <BotAvatar
                  role={liveMeta.role}
                  size={28}
                  active
                  agentStatus={a.status}
                  seed={a.id}
                />
              </span>
            ) : (
              <span className="bcs-avatar-fallback" style={{ borderRadius: "9999px" }}>
                {a.name.charAt(0).toUpperCase()}
              </span>
            )}
            <BotThinkingOrb status="working" size={20} shell={false} />
            <span className="bcs-live-text">
              {a.name} is working {a.worktreeBranch ? `on ${a.worktreeBranch}` : "in worktree"}…
            </span>
          </div>
        );
      })}
      {workingAgents.length > 3 && (
        <div className="bcs-live-more">+{workingAgents.length - 3} more active</div>
      )}

    </div>
  );
}
