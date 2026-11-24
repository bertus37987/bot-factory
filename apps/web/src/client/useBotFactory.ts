import { useCallback, useEffect, useRef, useState } from "react";
import {
  newId,
  type AgentRecord,
  type AnnotationRecord,
  type ArtifactEntry,
  type CheckpointRecord,
  type DebateMessageRecord,
  type DebateRecord,
  type GitDiffResponse,
  type HubConfig,
  type MemoryFactRecord,
  type PermissionRequestRecord,
  type ProjectRecord,
  type QuietStatusProjection,
  type RepoFileEntry,
  type RpcCommand,
  type SelfModProposalRecord,
  type SubscriptionTopic,
  type TaskRecord,
  type TeamGoalRecord,
  type TimelineItem,
  type VerificationReportRecord,
  type WsServerMessage,
} from "@bot-factory/shared";

export interface ArtifactCardEvent {
  id: string;
  projectId: string;
  title: string;
  subtitle: string;
  artifactPath?: string;
  kind?: "artifact" | "delegation" | "review_merge" | "blocked" | "milestone";
  goalId?: string | null;
  status?: string;
  verifiedTaskIds?: string[];
  blockedReasons?: string[];
  createdAt: number;
}

export interface ProviderSummary {
  name: string;
  runtime: string;
  models: string[];
}

export interface SecretPresenceEntry {
  key: string;
  present: boolean;
  source: string;
}

export interface L1MemoryEntry {
  target: string;
  projectId?: string | null;
  filePath?: string;
  content: string;
  usedChars: number;
  maxChars: number;
  gaugeHeader: string;
}

export interface MergeFailureNotice {
  projectId: string;
  taskId: string;
  error: string;
  conflicts: string[];
  preMergeRef: string | null;
  at: number;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RpcCommandInput = DistributiveOmit<RpcCommand, "commandId"> & { commandId?: string };

const INITIAL_QUIET_STATUS: QuietStatusProjection = {
  activeProjects: 0,
  runningBots: 0,
  waitingReviews: 0,
  openAnnotations: 0,
  activeDebates: 0,
  stagedSelfMods: 0,
  inboxNotices: [],
};

function upsertById<T extends { id: string }>(list: T[], item: T, prepend = false): T[] {
  const idx = list.findIndex((entry) => entry.id === item.id);
  if (idx >= 0) {
    return list.map((entry) => (entry.id === item.id ? item : entry));
  }
  return prepend ? [item, ...list] : [...list, item];
}

function mergeGoals(existing: TeamGoalRecord[], incoming: TeamGoalRecord[]): TeamGoalRecord[] {
  const map = new Map<string, TeamGoalRecord>();
  for (const g of existing) map.set(g.goalId, g);
  for (const g of incoming) map.set(g.goalId, g);
  return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function useBotFactory() {
  const wsRef = useRef<WebSocket | null>(null);
  const pendingAcks = useRef(
    new Map<
      string,
      { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
    >(),
  );
  const topicRefCounts = useRef(new Map<SubscriptionTopic, number>());
  const reconnectAttemptRef = useRef(0);
  const reconnectNowRef = useRef<(() => void) | null>(null);
  const activeCodeContextRef = useRef<{ projectId: string | null; agentId: string | null }>({
    projectId: null,
    agentId: null,
  });
  const contextRefreshTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const [connected, setConnected] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [reconnectingAttempt, setReconnectingAttempt] = useState(0);

  const [quietStatus, setQuietStatus] = useState<QuietStatusProjection>(INITIAL_QUIET_STATUS);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [chatMessages, setChatMessages] = useState<TimelineItem[]>([]);
  const [chatCards, setChatCards] = useState<ArtifactCardEvent[]>([]);
  const [streamingChatText, setStreamingChatText] = useState("");
  const [streamingChatThought, setStreamingChatThought] = useState("");
  const [streamingBotTextByAgent, setStreamingBotTextByAgent] = useState<Record<string, string>>({});
  const [streamingBotThoughtByAgent, setStreamingBotThoughtByAgent] = useState<Record<string, string>>({});

  const [tasksByProject, setTasksByProject] = useState<Record<string, TaskRecord[]>>({});
  const [goalsByProject, setGoalsByProject] = useState<Record<string, TeamGoalRecord[]>>({});
  const [artifactsByProject, setArtifactsByProject] = useState<Record<string, ArtifactEntry[]>>({});
  const [annotationsByProject, setAnnotationsByProject] = useState<Record<string, AnnotationRecord[]>>({});
  const [timelinesByAgent, setTimelinesByAgent] = useState<Record<string, TimelineItem[]>>({});
  const [debatesByProject, setDebatesByProject] = useState<Record<string, DebateRecord[]>>({});
  const [debateMessagesByDebate, setDebateMessagesByDebate] = useState<Record<string, DebateMessageRecord[]>>({});
  const [verificationsByProject, setVerificationsByProject] = useState<Record<string, VerificationReportRecord[]>>({});
  const [selfModProposals, setSelfModProposals] = useState<SelfModProposalRecord[]>([]);
  const [repoFilesByProject, setRepoFilesByProject] = useState<Record<string, RepoFileEntry[]>>({});
  const [gitDiffByProject, setGitDiffByProject] = useState<Record<string, GitDiffResponse>>({});
  const [checkpointsByProject, setCheckpointsByProject] = useState<Record<string, CheckpointRecord[]>>({});
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequestRecord[]>([]);
  const [lastMergeFailure, setLastMergeFailure] = useState<MergeFailureNotice | null>(null);

  const [configData, setConfigData] = useState<HubConfig | null>(null);
  const [secretsPresence, setSecretsPresence] = useState<SecretPresenceEntry[]>([]);
  const [l1Memory, setL1Memory] = useState<Record<string, L1MemoryEntry>>({});
  const [l2Facts, setL2Facts] = useState<MemoryFactRecord[]>([]);

  const setActiveCodeContext = useCallback((projectId: string | null, agentId: string | null) => {
    activeCodeContextRef.current = { projectId, agentId };
  }, []);

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

  const scheduleProjectContextRefresh = useCallback(
    (projectId: string) => {
      if (!projectId) return;
      const existing = contextRefreshTimersRef.current.get(projectId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        contextRefreshTimersRef.current.delete(projectId);
        const ctx = activeCodeContextRef.current;
        const agentId = ctx.projectId === projectId ? ctx.agentId : undefined;
        void refreshProjectCodeContext(projectId, agentId);
      }, 180);
      contextRefreshTimersRef.current.set(projectId, timer);
    },
    [refreshProjectCodeContext],
  );

  const sendRaw = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const subscribe = useCallback(
    (topic: SubscriptionTopic, forceRefresh = false) => {
      const prevCount = topicRefCounts.current.get(topic) ?? 0;
      topicRefCounts.current.set(topic, prevCount + 1);
      if (prevCount === 0 || forceRefresh) {
        sendRaw({ kind: "subscribe", topic });
      }
    },
    [sendRaw],
  );

  const unsubscribe = useCallback(
    (topic: SubscriptionTopic) => {
      const prevCount = topicRefCounts.current.get(topic) ?? 0;
      if (prevCount <= 0) return;
      if (prevCount === 1) {
        topicRefCounts.current.delete(topic);
        sendRaw({ kind: "unsubscribe", topic });
      } else {
        topicRefCounts.current.set(topic, prevCount - 1);
      }
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
        }, 20_000);
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

  const fetchConfigAndSecrets = useCallback(async () => {
    const [cfgRes, secRes] = await Promise.all([
      fetch("/api/config"),
      fetch("/api/secrets"),
    ]);
    if (cfgRes.status === 401 || secRes.status === 401) {
      setAuthRequired(true);
      throw new Error("Authentication required");
    }
    if (!cfgRes.ok) {
      throw new Error(`Failed to load config (${cfgRes.status})`);
    }
    if (!secRes.ok) {
      throw new Error(`Failed to load secrets status (${secRes.status})`);
    }
    const cfgJson = (await cfgRes.json()) as { config: HubConfig };
    const secJson = (await secRes.json()) as { keys: SecretPresenceEntry[] };
    setConfigData(cfgJson.config);
    setSecretsPresence(secJson.keys ?? []);
    if (cfgJson.config?.providers) {
      setProviders(
        Object.entries(cfgJson.config.providers).map(([name, cfg]) => ({
          name,
          runtime: cfg.runtime,
          models: Object.keys(cfg.models ?? {}),
        })),
      );
    }
  }, []);

  const saveSecret = useCallback(
    async (key: string, value: string) => {
      const res = await fetch("/api/secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || `Failed to save secret (${res.status})`);
      }
      await fetchConfigAndSecrets();
    },
    [fetchConfigAndSecrets],
  );

  const deleteSecret = useCallback(
    async (key: string) => {
      const res = await fetch(`/api/secrets/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || `Failed to delete secret (${res.status})`);
      }
      await fetchConfigAndSecrets();
    },
    [fetchConfigAndSecrets],
  );

  const testProviderConnection = useCallback(async (provider: string): Promise<{ ok: boolean; detail: string }> => {
    const res = await fetch("/api/secrets/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider }),
    });
    const json = (await res.json().catch(() => ({ ok: false, detail: `HTTP ${res.status}` }))) as {
      ok?: boolean;
      detail?: string;
    };
    return { ok: Boolean(json.ok), detail: json.detail ?? `HTTP ${res.status}` };
  }, []);

  const fetchMemoryStudio = useCallback(async (projectId?: string, query?: string) => {
    const l1Url = projectId ? `/api/memory/l1?projectId=${encodeURIComponent(projectId)}` : "/api/memory/l1";
    const factParams = new URLSearchParams();
    if (projectId) factParams.set("projectId", projectId);
    if (query?.trim()) factParams.set("query", query.trim());
    factParams.set("limit", "150");
    const factsUrl = `/api/memory/facts?${factParams.toString()}`;

    const [l1Res, factsRes] = await Promise.all([fetch(l1Url), fetch(factsUrl)]);
    if (l1Res.status === 401 || factsRes.status === 401) {
      setAuthRequired(true);
      throw new Error("Authentication required");
    }
    if (!l1Res.ok) {
      throw new Error(`Failed to fetch L1 memory (${l1Res.status})`);
    }
    if (!factsRes.ok) {
      throw new Error(`Failed to fetch L2 facts (${factsRes.status})`);
    }
    const l1Data = (await l1Res.json()) as {
      user?: L1MemoryEntry;
      global?: L1MemoryEntry;
      project?: L1MemoryEntry | null;
    };
    const nextL1: Record<string, L1MemoryEntry> = {};
    if (l1Data.user) nextL1.user = l1Data.user;
    if (l1Data.global) nextL1.global = l1Data.global;
    if (l1Data.project) nextL1.project = l1Data.project;
    setL1Memory(nextL1);

    const factsData = (await factsRes.json()) as { facts?: MemoryFactRecord[] };
    setL2Facts(factsData.facts ?? []);
  }, []);

  const fetchCheckpoints = useCallback(
    async (projectId: string, agentId?: string): Promise<CheckpointRecord[]> => {
      const res = await sendCommand<{ checkpoints: CheckpointRecord[] }>({
        type: "checkpoint.list",
        projectId,
        ...(agentId ? { agentId } : {}),
      });
      const list = res.checkpoints ?? [];
      if (!agentId) {
        setCheckpointsByProject((prev) => ({ ...prev, [projectId]: list }));
      } else {
        setCheckpointsByProject((prev) => {
          const others = (prev[projectId] ?? []).filter((c) => c.agentId !== agentId);
          return {
            ...prev,
            [projectId]: [...list, ...others].sort((a, b) => b.createdAt - a.createdAt),
          };
        });
      }
      return list;
    },
    [sendCommand],
  );

  const unlockWithToken = useCallback(async (token: string) => {
    const trimmed = token.trim();
    if (!trimmed) {
      throw new Error("Access token is required");
    }
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: trimmed }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error === "unauthorized" ? "Invalid daemon session token" : `Unlock failed (${res.status})`);
    }
    setAuthRequired(false);
    reconnectAttemptRef.current = 0;
    setReconnectingAttempt(0);
    reconnectNowRef.current?.();
  }, []);

  useEffect(() => {
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let lastPongAt = Date.now();

    const clearHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const checkAuthStatus = async (): Promise<boolean> => {
      try {
        const res = await fetch("/api/auth/status", { cache: "no-store" });
        if (!res.ok) return true;
        const data = (await res.json()) as { authenticated?: boolean };
        if (data.authenticated === false) {
          setAuthRequired(true);
          setHydrated(true);
          return false;
        }
        setAuthRequired(false);
        return true;
      } catch {
        return true;
      }
    };

    const scheduleReconnect = () => {
      if (closed) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
      reconnectAttemptRef.current = attempt + 1;
      setReconnectingAttempt(attempt + 1);
      reconnectTimer = setTimeout(() => {
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (closed) return;
      const prevWs = wsRef.current;
      if (prevWs && (prevWs.readyState === WebSocket.OPEN || prevWs.readyState === WebSocket.CONNECTING)) {
        return;
      }

      const authed = await checkAuthStatus();
      if (!authed || closed) return;

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (closed) {
          ws.close();
          return;
        }
        setConnected(true);
        setAuthRequired(false);
        reconnectAttemptRef.current = 0;
        setReconnectingAttempt(0);
        lastPongAt = Date.now();

        if ((topicRefCounts.current.get("global:status") ?? 0) === 0) {
          topicRefCounts.current.set("global:status", 1);
        }
        if ((topicRefCounts.current.get("chat:meta") ?? 0) === 0) {
          topicRefCounts.current.set("chat:meta", 1);
        }
        for (const topic of topicRefCounts.current.keys()) {
          ws.send(JSON.stringify({ kind: "subscribe", topic }));
        }

        clearHeartbeat();
        heartbeatTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastPongAt > 38_000) {
            ws.close();
            return;
          }
          ws.send(JSON.stringify({ kind: "ping", ts: Date.now() }));
        }, 15_000);
      };

      ws.onclose = () => {
        clearHeartbeat();
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        setConnected(false);
        for (const pending of pendingAcks.current.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Daemon WebSocket connection closed"));
        }
        pendingAcks.current.clear();

        if (!closed) {
          void checkAuthStatus().then((ok) => {
            if (ok && !closed) {
              scheduleReconnect();
            }
          });
        }
      };

      ws.onmessage = (ev) => {
        let msg: WsServerMessage;
        try {
          msg = JSON.parse(String(ev.data)) as WsServerMessage;
        } catch {
          return;
        }

        if (msg.kind === "pong") {
          lastPongAt = Date.now();
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
          if (!msg.data || typeof msg.data !== "object") {
            if (msg.topic === "global:status") setHydrated(true);
            return;
          }

          if (msg.topic === "global:status") {
            const snap = msg.data as {
              status: QuietStatusProjection;
              projects: ProjectRecord[];
              agents: AgentRecord[];
              goals?: TeamGoalRecord[];
              providers: ProviderSummary[];
            };
            setQuietStatus(snap.status ?? INITIAL_QUIET_STATUS);
            setProjects(snap.projects ?? []);
            setAgents(snap.agents ?? []);
            setProviders(snap.providers ?? []);
            setPendingPermissions(snap.status?.pendingPermissions ?? []);
            if (Array.isArray(snap.goals)) {
              const grouped: Record<string, TeamGoalRecord[]> = {};
              for (const g of snap.goals) {
                grouped[g.projectId] = grouped[g.projectId] ?? [];
                grouped[g.projectId]!.push(g);
              }
              setGoalsByProject(grouped);
            }
            setHydrated(true);
          } else if (msg.topic === "chat:meta") {
            const snap = msg.data as { messages: TimelineItem[]; cards?: ArtifactCardEvent[] };
            setChatMessages(snap.messages ?? []);
            if (snap.cards) {
              setChatCards(snap.cards);
            }
          } else if (msg.topic.endsWith(":board")) {
            const projectId = msg.topic.split(":")[1]!;
            const snap = msg.data as {
              tasks?: TaskRecord[];
              agents?: AgentRecord[];
              goals?: TeamGoalRecord[];
            };
            setTasksByProject((prev) => ({ ...prev, [projectId]: snap.tasks ?? [] }));
            if (Array.isArray(snap.agents)) {
              setAgents((prev) => {
                const others = prev.filter((a) => a.projectId !== projectId);
                return [...others, ...snap.agents!];
              });
            }
            if (Array.isArray(snap.goals)) {
              setGoalsByProject((prev) => ({
                ...prev,
                [projectId]: mergeGoals(prev[projectId] ?? [], snap.goals!),
              }));
            }
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
              const nextStatus = msg.data as QuietStatusProjection;
              setQuietStatus(nextStatus);
              if (Array.isArray(nextStatus.pendingPermissions)) {
                setPendingPermissions(nextStatus.pendingPermissions);
              }
              if (Array.isArray(nextStatus.activeGoals)) {
                setGoalsByProject((prev) => {
                  const next = { ...prev };
                  for (const g of nextStatus.activeGoals!) {
                    next[g.projectId] = mergeGoals(next[g.projectId] ?? [], [g]);
                  }
                  return next;
                });
              }
            } else if (msg.eventType === "project.created") {
              const payload = msg.data as { project?: ProjectRecord; projectManager?: AgentRecord };
              if (payload.project) {
                setProjects((prev) => upsertById(prev, payload.project!));
              }
              if (payload.projectManager) {
                setAgents((prev) => upsertById(prev, payload.projectManager!));
              }
            } else if (msg.eventType === "project.updated") {
              const proj = msg.data as ProjectRecord;
              if (proj?.id) {
                setProjects((prev) => upsertById(prev, proj));
              }
            } else if (msg.eventType === "agent.spawned") {
              const bot = msg.data as AgentRecord;
              if (bot?.id) {
                setAgents((prev) => upsertById(prev, bot));
              }
            } else if (msg.eventType === "agent.status") {
              const { agentId, status, lastSummary } = msg.data as {
                agentId: string;
                status: AgentRecord["status"];
                lastSummary?: string;
              };
              setAgents((prev) =>
                prev.map((a) =>
                  a.id === agentId
                    ? { ...a, status, ...(lastSummary !== undefined ? { lastSummary } : {}) }
                    : a,
                ),
              );
            } else if (msg.eventType === "config.updated") {
              const { config } = msg.data as { config?: HubConfig };
              if (config) {
                setConfigData(config);
                setProviders(
                  Object.entries(config.providers ?? {}).map(([name, cfg]) => ({
                    name,
                    runtime: cfg.runtime,
                    models: Object.keys(cfg.models ?? {}),
                  })),
                );
              }
            } else if (msg.eventType === "permission.requested") {
              const perm = msg.data as PermissionRequestRecord;
              if (perm?.id) {
                setPendingPermissions((prev) => upsertById(prev, perm, true));
              }
            } else if (msg.eventType === "permission.resolved") {
              const resolved = msg.data as { permissionId?: string; id?: string };
              const targetId = resolved.permissionId ?? resolved.id;
              if (targetId) {
                setPendingPermissions((prev) => prev.filter((p) => p.id !== targetId));
              }
            } else if (msg.eventType === "memory.l1.updated") {
              const info = msg.data as { target?: string; usedChars?: number; maxChars?: number };
              if (info?.target) {
                setL1Memory((prev) => {
                  const existing = prev[info.target!];
                  if (!existing) return prev;
                  const usedChars = info.usedChars ?? existing.usedChars;
                  const maxChars = info.maxChars ?? existing.maxChars;
                  const pct = maxChars > 0 ? Math.min(100, Math.round((usedChars / maxChars) * 100)) : 0;
                  return {
                    ...prev,
                    [info.target!]: {
                      ...existing,
                      usedChars,
                      maxChars,
                      gaugeHeader: `[${pct}% — ${usedChars}/${maxChars} chars]`,
                    },
                  };
                });
              }
            }
          } else if (msg.topic === "global:selfmod") {
            if (msg.eventType === "selfmod.updated") {
              const prop = msg.data as SelfModProposalRecord;
              setSelfModProposals((prev) => upsertById(prev, prop, true));
            }
          } else if (msg.topic === "chat:meta") {
            if (msg.eventType === "chat.delta") {
              const delta = msg.data as { text?: string };
              if (typeof delta?.text === "string") {
                setStreamingChatText((prev) => prev + delta.text);
              }
            } else if (msg.eventType === "chat.thought") {
              const delta = msg.data as { text?: string };
              if (typeof delta?.text === "string") {
                setStreamingChatThought((prev) => prev + delta.text);
              }
            } else if (msg.eventType === "chat.message") {
              const item = msg.data as TimelineItem;
              setChatMessages((prev) => (prev.some((m) => m.id === item.id) ? prev : [...prev, item]));
              if (item.role === "assistant") {
                setStreamingChatText("");
                setStreamingChatThought("");
              }
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
                return { ...prev, [projectId]: upsertById(list, task, true) };
              });
              if (msg.eventType === "task.updated" && activeCodeContextRef.current.projectId === projectId) {
                scheduleProjectContextRefresh(projectId);
              }
            } else if (msg.eventType === "board.updated") {
              const snap = msg.data as {
                tasks?: TaskRecord[];
                agents?: AgentRecord[];
                goals?: TeamGoalRecord[];
              };
              setTasksByProject((prev) => ({ ...prev, [projectId]: snap.tasks ?? [] }));
              if (Array.isArray(snap.agents)) {
                setAgents((prev) => {
                  const others = prev.filter((a) => a.projectId !== projectId);
                  return [...others, ...snap.agents!];
                });
              }
              if (Array.isArray(snap.goals)) {
                setGoalsByProject((prev) => ({
                  ...prev,
                  [projectId]: mergeGoals(prev[projectId] ?? [], snap.goals!),
                }));
              }
              if (activeCodeContextRef.current.projectId === projectId) {
                scheduleProjectContextRefresh(projectId);
              }
            } else if (msg.eventType === "agent.spawned") {
              const bot = msg.data as AgentRecord;
              if (bot?.id) {
                setAgents((prev) => upsertById(prev, bot));
              }
            } else if (msg.eventType === "goal.reported") {
              const report = msg.data as {
                projectId: string;
                goalId: string | null;
                status: "milestone" | "completed" | "blocked";
                summary: string;
                verifiedTaskIds?: string[];
                reportedAt?: number;
              };
              if (report.goalId) {
                setGoalsByProject((prev) => {
                  const current = prev[projectId] ?? [];
                  const existing = current.find((g) => g.goalId === report.goalId);
                  const nextGoal: TeamGoalRecord = {
                    goalId: report.goalId!,
                    projectId,
                    goal: existing?.goal ?? report.summary,
                    status:
                      report.status === "completed"
                        ? "completed"
                        : report.status === "blocked"
                          ? "blocked"
                          : existing?.status ?? "active",
                    taskIds: existing?.taskIds ?? report.verifiedTaskIds ?? [],
                    updatedAt: report.reportedAt ?? Date.now(),
                  };
                  return { ...prev, [projectId]: mergeGoals(current, [nextGoal]) };
                });
              }
            } else if (msg.eventType === "task.merge_failed") {
              const failure = msg.data as {
                taskId: string;
                error: string;
                conflicts?: string[];
                preMergeRef?: string | null;
              };
              setLastMergeFailure({
                projectId,
                taskId: failure.taskId,
                error: failure.error,
                conflicts: failure.conflicts ?? [],
                preMergeRef: failure.preMergeRef ?? null,
                at: Date.now(),
              });
            }
          } else if (msg.topic.endsWith(":previews")) {
            const projectId = msg.topic.split(":")[1]!;
            if (msg.eventType === "annotation.created" || msg.eventType === "annotation.updated") {
              const ann = msg.data as AnnotationRecord;
              setAnnotationsByProject((prev) => {
                const list = prev[projectId] ?? [];
                return { ...prev, [projectId]: upsertById(list, ann, true) };
              });
            }
          } else if (msg.topic.endsWith(":debates")) {
            const projectId = msg.topic.split(":")[1]!;
            if (msg.eventType === "debate.updated") {
              const debate = msg.data as DebateRecord;
              setDebatesByProject((prev) => {
                const list = prev[projectId] ?? [];
                return { ...prev, [projectId]: upsertById(list, debate, true) };
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
            if (msg.eventType === "timeline.delta") {
              const delta = msg.data as { kind?: string; text?: string };
              if (typeof delta?.text === "string") {
                if (delta.kind === "thought") {
                  setStreamingBotThoughtByAgent((prev) => ({
                    ...prev,
                    [agentId]: (prev[agentId] ?? "") + delta.text,
                  }));
                } else {
                  setStreamingBotTextByAgent((prev) => ({
                    ...prev,
                    [agentId]: (prev[agentId] ?? "") + delta.text,
                  }));
                }
              }
            } else if (msg.eventType === "timeline.item") {
              const item = msg.data as TimelineItem;
              setTimelinesByAgent((prev) => {
                const list = prev[agentId] ?? [];
                if (list.some((m) => m.id === item.id)) return prev;
                return { ...prev, [agentId]: [...list, item] };
              });
              if (item.kind === "message") {
                setStreamingBotTextByAgent((prev) => {
                  if (!(agentId in prev)) return prev;
                  const next = { ...prev };
                  delete next[agentId];
                  return next;
                });
                setStreamingBotThoughtByAgent((prev) => {
                  if (!(agentId in prev)) return prev;
                  const next = { ...prev };
                  delete next[agentId];
                  return next;
                });
              } else if (item.kind === "thought") {
                setStreamingBotThoughtByAgent((prev) => {
                  if (!(agentId in prev)) return prev;
                  const next = { ...prev };
                  delete next[agentId];
                  return next;
                });
              } else if (item.kind === "handoff") {
                const ctx = activeCodeContextRef.current;
                if (ctx.projectId) {
                  scheduleProjectContextRefresh(ctx.projectId);
                  if ((topicRefCounts.current.get(`project:${ctx.projectId}:previews`) ?? 0) > 0) {
                    sendRaw({ kind: "subscribe", topic: `project:${ctx.projectId}:previews` });
                  }
                }
              }
            } else if (msg.eventType === "agent.status") {
              const { status } = msg.data as { agentId: string; status: AgentRecord["status"] };
              setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, status } : a)));
            } else if (msg.eventType === "permission.requested") {
              const perm = msg.data as PermissionRequestRecord;
              if (perm?.id) {
                setPendingPermissions((prev) => upsertById(prev, perm, true));
              }
            } else if (msg.eventType === "permission.resolved") {
              const resolved = msg.data as { permissionId?: string; id?: string };
              const targetId = resolved.permissionId ?? resolved.id;
              if (targetId) {
                setPendingPermissions((prev) => prev.filter((p) => p.id !== targetId));
              }
            }
          }
        }
      };
    };

    reconnectNowRef.current = () => {
      void connect();
    };
    void connect();

    return () => {
      closed = true;
      reconnectNowRef.current = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearHeartbeat();
      for (const timer of contextRefreshTimersRef.current.values()) {
        clearTimeout(timer);
      }
      contextRefreshTimersRef.current.clear();
      for (const pending of pendingAcks.current.values()) {
        clearTimeout(pending.timer);
      }
      pendingAcks.current.clear();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [scheduleProjectContextRefresh, sendRaw]);

  return {
    connected,
    hydrated,
    authRequired,
    reconnectingAttempt,
    unlockWithToken,
    quietStatus,
    projects,
    agents,
    providers,
    chatMessages,
    chatCards,
    streamingChatText,
    streamingChatThought,
    streamingBotTextByAgent,
    streamingBotThoughtByAgent,
    tasksByProject,
    goalsByProject,
    artifactsByProject,
    annotationsByProject,
    timelinesByAgent,
    debatesByProject,
    debateMessagesByDebate,
    verificationsByProject,
    selfModProposals,
    repoFilesByProject,
    gitDiffByProject,
    checkpointsByProject,
    pendingPermissions,
    lastMergeFailure,
    configData,
    secretsPresence,
    l1Memory,
    l2Facts,
    setActiveCodeContext,
    refreshProjectCodeContext,
    fetchConfigAndSecrets,
    saveSecret,
    deleteSecret,
    testProviderConnection,
    fetchMemoryStudio,
    fetchCheckpoints,
    subscribe,
    unsubscribe,
    sendCommand,
  };
}
