import { useCallback, useEffect, useRef, useState } from "react";
import {
  newId,
  type AgentRecord,
  type AnnotationRecord,
  type ArtifactEntry,
  type DebateMessageRecord,
  type DebateRecord,
  type GitDiffResponse,
  type ProjectRecord,
  type QuietStatusProjection,
  type RepoFileEntry,
  type RpcCommand,
  type SelfModProposalRecord,
  type SubscriptionTopic,
  type TaskRecord,
  type TimelineItem,
  type VerificationReportRecord,
  type WsServerMessage,
} from "@bot-factory/shared";

export interface ArtifactCardEvent {
  id: string;
  projectId: string;
  title: string;
  subtitle: string;
  artifactPath: string;
  createdAt: number;
}

export interface ProviderSummary {
  name: string;
  runtime: string;
  models: string[];
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RpcCommandInput = DistributiveOmit<RpcCommand, "commandId"> & { commandId?: string };

export function useBotFactory() {
  const wsRef = useRef<WebSocket | null>(null);
  const pendingAcks = useRef(
    new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>(),
  );
  const activeTopics = useRef(new Set<SubscriptionTopic>());

  const [connected, setConnected] = useState(false);
  const [quietStatus, setQuietStatus] = useState<QuietStatusProjection>({
    activeProjects: 0,
    runningBots: 0,
    waitingReviews: 0,
    openAnnotations: 0,
    activeDebates: 0,
    stagedSelfMods: 0,
    inboxNotices: [],
  });
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [chatMessages, setChatMessages] = useState<TimelineItem[]>([]);
  const [chatCards, setChatCards] = useState<ArtifactCardEvent[]>([]);
  const [tasksByProject, setTasksByProject] = useState<Record<string, TaskRecord[]>>({});
  const [artifactsByProject, setArtifactsByProject] = useState<Record<string, ArtifactEntry[]>>({});
  const [annotationsByProject, setAnnotationsByProject] = useState<Record<string, AnnotationRecord[]>>({});
  const [timelinesByAgent, setTimelinesByAgent] = useState<Record<string, TimelineItem[]>>({});
  const [debatesByProject, setDebatesByProject] = useState<Record<string, DebateRecord[]>>({});
  const [debateMessagesByDebate, setDebateMessagesByDebate] = useState<Record<string, DebateMessageRecord[]>>({});
  const [verificationsByProject, setVerificationsByProject] = useState<Record<string, VerificationReportRecord[]>>({});
  const [selfModProposals, setSelfModProposals] = useState<SelfModProposalRecord[]>([]);
  const [repoFilesByProject, setRepoFilesByProject] = useState<Record<string, RepoFileEntry[]>>({});
  const [gitDiffByProject, setGitDiffByProject] = useState<Record<string, GitDiffResponse>>({});

  const refreshProjectCodeContext = useCallback(async (projectId: string, agentId?: string | null) => {
    const qs = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
    const [filesRes, diffRes] = await Promise.all([
      fetch(`/api/projects/${encodeURIComponent(projectId)}/files${qs}`).catch(() => null),
      fetch(`/api/projects/${encodeURIComponent(projectId)}/diff${qs}`).catch(() => null),
    ]);
    if (filesRes && filesRes.ok) {
      const data = (await filesRes.json()) as { files?: RepoFileEntry[] };
      if (Array.isArray(data.files)) {
        setRepoFilesByProject((prev) => ({ ...prev, [projectId]: data.files! }));
      }
    }
    if (diffRes && diffRes.ok) {
      const diff = (await diffRes.json()) as GitDiffResponse;
      if (diff && typeof diff.filesChanged === "number") {
        setGitDiffByProject((prev) => ({ ...prev, [projectId]: diff }));
      }
    }
  }, []);

  const sendRaw = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const subscribe = useCallback(
    (topic: SubscriptionTopic, forceRefresh = false) => {
      if (!forceRefresh && activeTopics.current.has(topic)) return;
      activeTopics.current.add(topic);
      sendRaw({ kind: "subscribe", topic });
    },
    [sendRaw],
  );

  const unsubscribe = useCallback(
    (topic: SubscriptionTopic) => {
      if (!activeTopics.current.has(topic)) return;
      activeTopics.current.delete(topic);
      sendRaw({ kind: "unsubscribe", topic });
    },
    [sendRaw],
  );

  const sendCommand = useCallback(
    <T = unknown>(payload: RpcCommandInput): Promise<T> => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error(`Daemon WebSocket disconnected (${payload.type})`));
      }
      const commandId = payload.commandId ?? newId("cmd");
      const full = { ...payload, commandId } as RpcCommand;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingAcks.current.has(commandId)) {
            pendingAcks.current.delete(commandId);
            reject(new Error(`Command timeout: ${full.type}`));
          }
        }, 15_000);
        pendingAcks.current.set(commandId, {
          resolve: (v) => resolve(v as T),
          reject,
          timer,
        });
        sendRaw({ kind: "command", payload: full });
      });
    },
    [sendRaw],
  );

  useEffect(() => {
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        activeTopics.current.add("global:status");
        activeTopics.current.add("chat:meta");
        for (const topic of activeTopics.current) {
          ws.send(JSON.stringify({ kind: "subscribe", topic }));
        }
      };

      ws.onclose = () => {
        setConnected(false);
        for (const pending of pendingAcks.current.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Daemon WebSocket connection closed"));
        }
        pendingAcks.current.clear();
        if (!closed) {
          reconnectTimer = setTimeout(connect, 1200);
        }
      };

      ws.onmessage = (ev) => {
        let msg: WsServerMessage;
        try {
          msg = JSON.parse(String(ev.data)) as WsServerMessage;
        } catch {
          return;
        }

        if (msg.kind === "ack") {
          const pending = pendingAcks.current.get(msg.commandId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingAcks.current.delete(msg.commandId);
            if (msg.ok) pending.resolve(msg.result);
            else pending.reject(new Error(msg.error ?? "Command failed"));
          }
          return;
        }

        if (msg.kind === "snapshot") {
          if (!msg.data || typeof msg.data !== "object") return;
          if (msg.topic === "global:status") {
            const snap = msg.data as {
              status: QuietStatusProjection;
              projects: ProjectRecord[];
              agents: AgentRecord[];
              providers: ProviderSummary[];
            };
            setQuietStatus(snap.status);
            setProjects(snap.projects);
            setAgents(snap.agents);
            setProviders(snap.providers);
          } else if (msg.topic === "chat:meta") {
            const snap = msg.data as { messages: TimelineItem[]; cards?: ArtifactCardEvent[] };
            setChatMessages(snap.messages ?? []);
            if (snap.cards) {
              setChatCards(snap.cards);
            }
          } else if (msg.topic.endsWith(":board")) {
            const projectId = msg.topic.split(":")[1]!;
            const snap = msg.data as { tasks: TaskRecord[]; agents: AgentRecord[] };
            setTasksByProject((prev) => ({ ...prev, [projectId]: snap.tasks ?? [] }));
          } else if (msg.topic.endsWith(":previews")) {
            const projectId = msg.topic.split(":")[1]!;
            const snap = msg.data as { artifacts: ArtifactEntry[]; annotations: AnnotationRecord[] };
            setArtifactsByProject((prev) => ({ ...prev, [projectId]: snap.artifacts ?? [] }));
            setAnnotationsByProject((prev) => ({ ...prev, [projectId]: snap.annotations ?? [] }));
          } else if (msg.topic.endsWith(":debates")) {
            const projectId = msg.topic.split(":")[1]!;
            const snap = msg.data as {
              debates: DebateRecord[];
              messagesByDebate: Record<string, DebateMessageRecord[]>;
              verifications: VerificationReportRecord[];
            };
            setDebatesByProject((prev) => ({ ...prev, [projectId]: snap.debates ?? [] }));
            if (snap.messagesByDebate) {
              setDebateMessagesByDebate((prev) => ({ ...prev, ...snap.messagesByDebate }));
            }
            setVerificationsByProject((prev) => ({ ...prev, [projectId]: snap.verifications ?? [] }));
          } else if (msg.topic === "global:selfmod") {
            const snap = msg.data as { proposals: SelfModProposalRecord[] };
            setSelfModProposals(snap.proposals ?? []);
          } else if (msg.topic.endsWith(":timeline")) {
            const agentId = msg.topic.split(":")[1]!;
            const snap = msg.data as { timeline: TimelineItem[] };
            setTimelinesByAgent((prev) => ({ ...prev, [agentId]: snap.timeline ?? [] }));
          }
          return;
        }

        if (msg.kind === "event") {
          if (msg.topic === "global:status") {
            if (msg.eventType === "status.updated") {
              setQuietStatus(msg.data as QuietStatusProjection);
              subscribe("global:status", true);
            } else if (msg.eventType === "project.created" || msg.eventType === "agent.spawned") {
              subscribe("global:status", true);
            }
          } else if (msg.topic === "global:selfmod") {
            if (msg.eventType === "selfmod.updated") {
              const prop = msg.data as SelfModProposalRecord;
              setSelfModProposals((prev) => {
                const idx = prev.findIndex((p) => p.id === prop.id);
                return idx >= 0 ? prev.map((p) => (p.id === prop.id ? prop : p)) : [prop, ...prev];
              });
            }
          } else if (msg.topic === "chat:meta") {
            if (msg.eventType === "chat.message") {
              const item = msg.data as TimelineItem;
              setChatMessages((prev) => (prev.some((m) => m.id === item.id) ? prev : [...prev, item]));
            } else if (msg.eventType === "chat.artifact_card") {
              const card = msg.data as ArtifactCardEvent;
              setChatCards((prev) => (prev.some((c) => c.id === card.id) ? prev : [...prev, card]));
            }
          } else if (msg.topic.endsWith(":board")) {
            const projectId = msg.topic.split(":")[1]!;
            if (msg.eventType === "task.created" || msg.eventType === "task.updated") {
              const task = msg.data as TaskRecord;
              setTasksByProject((prev) => {
                const list = prev[projectId] ?? [];
                const idx = list.findIndex((t) => t.id === task.id);
                const next = idx >= 0 ? list.map((t) => (t.id === task.id ? task : t)) : [task, ...list];
                return { ...prev, [projectId]: next };
              });
            } else if (msg.eventType === "board.updated") {
              const snap = msg.data as { tasks: TaskRecord[] };
              setTasksByProject((prev) => ({ ...prev, [projectId]: snap.tasks ?? [] }));
            }
          } else if (msg.topic.endsWith(":previews")) {
            const projectId = msg.topic.split(":")[1]!;
            if (msg.eventType === "annotation.created" || msg.eventType === "annotation.updated") {
              const ann = msg.data as AnnotationRecord;
              setAnnotationsByProject((prev) => {
                const list = prev[projectId] ?? [];
                const idx = list.findIndex((a) => a.id === ann.id);
                const next = idx >= 0 ? list.map((a) => (a.id === ann.id ? ann : a)) : [ann, ...list];
                return { ...prev, [projectId]: next };
              });
            }
          } else if (msg.topic.endsWith(":debates")) {
            const projectId = msg.topic.split(":")[1]!;
            if (msg.eventType === "debate.updated") {
              const debate = msg.data as DebateRecord;
              setDebatesByProject((prev) => {
                const list = prev[projectId] ?? [];
                const idx = list.findIndex((d) => d.id === debate.id);
                const next = idx >= 0 ? list.map((d) => (d.id === debate.id ? debate : d)) : [debate, ...list];
                return { ...prev, [projectId]: next };
              });
            } else if (msg.eventType === "debate.message") {
              const dm = msg.data as DebateMessageRecord;
              setDebateMessagesByDebate((prev) => {
                const list = prev[dm.debateId] ?? [];
                if (list.some((m) => m.id === dm.id)) return prev;
                return { ...prev, [dm.debateId]: [...list, dm] };
              });
            } else if (msg.eventType === "verification.completed") {
              const report = msg.data as VerificationReportRecord;
              setVerificationsByProject((prev) => {
                const list = prev[projectId] ?? [];
                if (list.some((v) => v.id === report.id)) return prev;
                return { ...prev, [projectId]: [report, ...list] };
              });
            }
          } else if (msg.topic.endsWith(":timeline")) {
            const agentId = msg.topic.split(":")[1]!;
            if (msg.eventType === "timeline.item") {
              const item = msg.data as TimelineItem;
              setTimelinesByAgent((prev) => {
                const list = prev[agentId] ?? [];
                if (list.some((m) => m.id === item.id)) return prev;
                return { ...prev, [agentId]: [...list, item] };
              });
            } else if (msg.eventType === "agent.status") {
              const { status } = msg.data as { agentId: string; status: AgentRecord["status"] };
              setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, status } : a)));
            }
          }
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const pending of pendingAcks.current.values()) {
        clearTimeout(pending.timer);
      }
      pendingAcks.current.clear();
      wsRef.current?.close();
    };
  }, [subscribe]);

  return {
    connected,
    quietStatus,
    projects,
    agents,
    providers,
    chatMessages,
    chatCards,
    tasksByProject,
    artifactsByProject,
    annotationsByProject,
    timelinesByAgent,
    debatesByProject,
    debateMessagesByDebate,
    verificationsByProject,
    selfModProposals,
    repoFilesByProject,
    gitDiffByProject,
    refreshProjectCodeContext,
    subscribe,
    unsubscribe,
    sendCommand,
  };
}
