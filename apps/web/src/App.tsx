import {
  Bell,
  Brain,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  GitBranch,
  Kanban,
  Layers,
  Lock,
  MessageSquareWarning,
  OctagonX,
  Pause,
  Play,
  Plus,
  Search,
  Settings,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRecord, ArtifactEntry, RepoFileEntry } from "@bot-factory/shared";
import { BotsTab, type BotsTabProps } from "./bots/BotsTab";
import { InAppBrowser, type BrowserTab, type BrowserTabKind } from "./browser/InAppBrowser";
import { ChatTab } from "./chat/ChatTab";
import { useBotFactory } from "./client/useBotFactory";
import { BotAvatar, GroupAvatarCluster, JobTitlePill, resolveBotRole } from "./components/BotAvatars";
import {
  AgentChatApertureIcon,
  BotsLatticeIcon,
  BrowserPaneIcon,
  CodeTabIcon,
  Cube3DTabIcon,
  DiffBranchIcon,
  DocTabIcon,
  ImageTabIcon,
  SidebarToggleIcon,
} from "./components/BotFactoryIcons";
import { BotThinkingOrb } from "./components/BotThinkingOrb";
import type { AutonomyLevel, ModelTargetSelection } from "./components/PrecisionComposer";
import type { ReasoningEffort } from "./components/ReasoningEffortSlider";
import { BotSpawnModal } from "./studio/BotSpawnModal";
import { EscalationInbox } from "./studio/EscalationInbox";
import { MemoryL1Studio } from "./studio/MemoryL1Studio";
import { ProjectModal } from "./studio/ProjectModal";
import { SettingsView } from "./studio/SettingsView";

type BotsSubView = BotsTabProps["activeSubView"];

interface ToastItem {
  id: string;
  tone: "info" | "success" | "error";
  message: string;
}

type PaletteEntry =
  | { kind: "bot"; id: string; title: string; subtitle: string; agent: AgentRecord }
  | { kind: "project"; id: string; title: string; subtitle: string; projectId: string }
  | { kind: "artifact"; id: string; title: string; subtitle: string; projectId: string; artifact: ArtifactEntry }
  | { kind: "file"; id: string; title: string; subtitle: string; projectId: string; file: RepoFileEntry };

function artifactKindToTabKind(kind: ArtifactEntry["kind"]): BrowserTabKind {
  if (kind === "image") return "image";
  if (kind === "model_3d") return "model_3d";
  return "doc";
}

function makeTabId(): string {
  return `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function App() {
  const bf = useBotFactory();
  const [world, setWorld] = useState<"chat" | "bots">("chat");
  const [drawerOpen, setDrawerOpen] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 1000 : true,
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [botsSubView, setBotsSubView] = useState<BotsSubView>("chat_group");

  const [effort, setEffort] = useState<ReasoningEffort>("high");
  const [autonomy, setAutonomy] = useState<AutonomyLevel>("medium");
  const [selectedChatTarget, setSelectedChatTarget] = useState<ModelTargetSelection | null>(null);

  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const [browserWidth, setBrowserWidth] = useState(520);
  const [browserTabs, setBrowserTabs] = useState<BrowserTab[]>([]);
  const [activeTabIdByProject, setActiveTabIdByProject] = useState<Record<string, string>>({});

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);

  const [inboxOpen, setInboxOpen] = useState(false);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [botSpawnModalOpen, setBotSpawnModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoryStudioOpen, setMemoryStudioOpen] = useState(false);

  const [expandedSubagentParents, setExpandedSubagentParents] = useState<Record<string, boolean>>({});
  const [safetyBusy, setSafetyBusy] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const [unlockToken, setUnlockToken] = useState("");
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const draggingBrowserRef = useRef(false);
  const browserTabsRef = useRef<BrowserTab[]>([]);
  browserTabsRef.current = browserTabs;
  const toastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const pushToast = useCallback((message: string, tone: ToastItem["tone"] = "info") => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev.slice(-3), { id, tone, message }]);
    const timer = setTimeout(() => {
      toastTimersRef.current.delete(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
    toastTimersRef.current.set(id, timer);
  }, []);

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    return () => {
      for (const t of toastTimersRef.current.values()) clearTimeout(t);
      toastTimersRef.current.clear();
    };
  }, []);

  const activeProject = useMemo(
    () => bf.projects.find((p) => p.id === selectedProjectId) ?? bf.projects[0] ?? null,
    [bf.projects, selectedProjectId],
  );

  const projectAgents = useMemo(
    () => (activeProject ? bf.agents.filter((a) => a.projectId === activeProject.id) : []),
    [bf.agents, activeProject],
  );

  const activeAgent = useMemo(
    () => projectAgents.find((a) => a.id === selectedAgentId) ?? projectAgents[0] ?? null,
    [projectAgents, selectedAgentId],
  );

  const metaAgent = useMemo(() => bf.agents.find((a) => a.scope === "global") ?? null, [bf.agents]);

  const effectiveChatTarget = useMemo<ModelTargetSelection | null>(() => {
    if (selectedChatTarget) return selectedChatTarget;
    const routed = bf.configData?.routing?.defaultsByIntent?.meta_orchestrator;
    if (routed) return routed;
    if (metaAgent) return { provider: metaAgent.provider, model: metaAgent.model };
    return null;
  }, [selectedChatTarget, bf.configData, metaAgent]);

  const activeArtifacts = activeProject ? bf.artifactsByProject[activeProject.id] ?? [] : [];
  const activeAnnotations = activeProject ? bf.annotationsByProject[activeProject.id] ?? [] : [];
  const activeRepoFiles = activeProject ? bf.repoFilesByProject[activeProject.id] ?? [] : [];
  const activeGitDiff = activeProject ? bf.gitDiffByProject[activeProject.id] ?? null : null;
  const activeTasks = activeProject ? bf.tasksByProject[activeProject.id] ?? [] : [];
  const activeGoals = activeProject ? bf.goalsByProject[activeProject.id] ?? [] : [];
  const activeDebates = activeProject ? bf.debatesByProject[activeProject.id] ?? [] : [];
  const activeVerifications = activeProject ? bf.verificationsByProject[activeProject.id] ?? [] : [];
  const activeCheckpoints = activeProject ? bf.checkpointsByProject[activeProject.id] ?? [] : [];

  const projectBrowserTabs = useMemo(() => {
    if (!activeProject) return [];
    return browserTabs.filter((t) => t.projectId === activeProject.id);
  }, [browserTabs, activeProject]);

  const activeBrowserTabId = useMemo(() => {
    if (!activeProject) return null;
    const saved = activeTabIdByProject[activeProject.id];
    if (saved && projectBrowserTabs.some((t) => t.id === saved)) return saved;
    return projectBrowserTabs[projectBrowserTabs.length - 1]?.id ?? null;
  }, [activeProject, activeTabIdByProject, projectBrowserTabs]);

  // Keep active project/agent context synced in useBotFactory for auto-refresh
  useEffect(() => {
    bf.setActiveCodeContext(activeProject?.id ?? null, activeAgent?.id ?? null);
  }, [activeProject?.id, activeAgent?.id, bf.setActiveCodeContext]);

  // Always hydrate lightweight config & L1 memory once connected so model selector & Context Ring show live data
  useEffect(() => {
    if (!bf.connected || bf.authRequired) return;
    void bf.fetchConfigAndSecrets().catch(() => {});
    void bf.fetchMemoryStudio(activeProject?.id).catch(() => {});
  }, [bf.connected, bf.authRequired, activeProject?.id, bf.fetchConfigAndSecrets, bf.fetchMemoryStudio]);

  // Surface merge failures via unified toast stack
  useEffect(() => {
    if (!bf.lastMergeFailure) return;
    const f = bf.lastMergeFailure;
    const conflictText = f.conflicts.length > 0 ? ` (${f.conflicts.join(", ")})` : "";
    pushToast(`Merge failed: ${f.error}${conflictText}`, "error");
  }, [bf.lastMergeFailure, pushToast]);

  // Keep active project previews, board (for Main Agent verified merge CTA), and code context hydrated
  useEffect(() => {
    if (!activeProject) return;
    const previewsTopic = `project:${activeProject.id}:previews` as const;
    const boardTopic = `project:${activeProject.id}:board` as const;
    bf.subscribe(previewsTopic);
    bf.subscribe(boardTopic);
    void bf.refreshProjectCodeContext(activeProject.id, activeAgent?.id);
    return () => {
      bf.unsubscribe(previewsTopic);
      bf.unsubscribe(boardTopic);
    };
  }, [activeProject?.id, activeAgent?.id, bf.subscribe, bf.unsubscribe, bf.refreshProjectCodeContext]);

  // Pause heavy BotsTab subscriptions (bot timelines, debates, selfmod) when world !== "bots"
  const projectAgentIdsKey = projectAgents.map((a) => a.id).join(",");
  useEffect(() => {
    if (world !== "bots" || !activeProject) return;
    const debatesTopic = `project:${activeProject.id}:debates` as const;
    const selfModTopic = "global:selfmod" as const;
    const timelineTopics = projectAgents.map((a) => `bot:${a.id}:timeline` as const);
    bf.subscribe(debatesTopic);
    bf.subscribe(selfModTopic);
    for (const topic of timelineTopics) {
      bf.subscribe(topic);
    }
    return () => {
      bf.unsubscribe(debatesTopic);
      bf.unsubscribe(selfModTopic);
      for (const topic of timelineTopics) {
        bf.unsubscribe(topic);
      }
    };
  }, [world, activeProject?.id, projectAgentIdsKey, bf.subscribe, bf.unsubscribe]);

  // Responsive <1000px drawer auto-collapse
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 999px)");
    const onChange = (e: MediaQueryListEvent) => {
      setDrawerOpen(!e.matches);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Global keyboard shortcuts (Ctrl+E world switch, Ctrl+K quick palette, Ctrl+B toggle drawer)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setWorld((w) => (w === "chat" ? "bots" : "chat"));
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        setPaletteQuery("");
        setPaletteIndex(0);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setDrawerOpen((o) => !o);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Drag resize for In-App Browser Sidebar
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingBrowserRef.current) return;
      const next = Math.min(Math.max(360, window.innerWidth - e.clientX), Math.round(window.innerWidth * 0.65));
      setBrowserWidth(next);
    };
    const onUp = () => {
      draggingBrowserRef.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const openBrowserTab = useCallback((tab: Omit<BrowserTab, "id">) => {
    setBrowserOpen(true);
    const current = browserTabsRef.current;
    const existing = current.find(
      (t) => t.projectId === tab.projectId && t.kind === tab.kind && t.target === tab.target,
    );
    if (existing) {
      setActiveTabIdByProject((prev) => ({ ...prev, [tab.projectId]: existing.id }));
      return;
    }
    const id = makeTabId();
    const created: BrowserTab = { ...tab, id };
    setBrowserTabs((prev) => [...prev, created]);
    setActiveTabIdByProject((prev) => ({ ...prev, [tab.projectId]: id }));
  }, []);

  const closeBrowserTab = useCallback(
    (tabId: string) => {
      const current = browserTabsRef.current;
      const targetTab = current.find((t) => t.id === tabId);
      const next = current.filter((t) => t.id !== tabId);
      setBrowserTabs(next);
      if (targetTab) {
        const remainingForProject = next.filter((t) => t.projectId === targetTab.projectId);
        setActiveTabIdByProject((prev) => {
          const updated = { ...prev };
          if (updated[targetTab.projectId] === tabId) {
            if (remainingForProject.length > 0) {
              updated[targetTab.projectId] = remainingForProject[remainingForProject.length - 1]!.id;
            } else {
              delete updated[targetTab.projectId];
            }
          }
          return updated;
        });
        if (activeProject?.id === targetTab.projectId && remainingForProject.length === 0) {
          setBrowserOpen(false);
          setBrowserExpanded(false);
        }
      }
    },
    [activeProject?.id],
  );

  const openBrowserItem = useCallback(
    (
      projectId: string,
      kind: "doc" | "image" | "model_3d" | "code" | "diff",
      target: string,
      label?: string,
    ) => {
      if (kind === "diff") {
        void bf.refreshProjectCodeContext(projectId, activeAgent?.id);
      }
      openBrowserTab({
        projectId,
        kind,
        target,
        label: label ?? (kind === "diff" ? "Git Diff" : target.split("/").pop() ?? target),
      });
    },
    [activeAgent?.id, bf.refreshProjectCodeContext, openBrowserTab],
  );

  const openArtifactInBrowser = useCallback(
    (artifact: ArtifactEntry) => {
      openBrowserTab({
        projectId: artifact.projectId,
        kind: artifactKindToTabKind(artifact.kind),
        target: artifact.relativePath,
        label: artifact.name,
      });
    },
    [openBrowserTab],
  );

  const openDiffInBrowser = useCallback(
    (overrideProjectId?: string) => {
      const pid = overrideProjectId ?? activeProject?.id;
      if (!pid) return;
      void bf.refreshProjectCodeContext(pid, activeAgent?.id);
      openBrowserTab({
        projectId: pid,
        kind: "diff",
        target: "diff://HEAD",
        label: "Changes (Diff)",
      });
    },
    [activeProject?.id, activeAgent?.id, bf.refreshProjectCodeContext, openBrowserTab],
  );

  const toggleBrowserSidebar = useCallback(() => {
    if (browserOpen) {
      setBrowserOpen(false);
      setBrowserExpanded(false);
      return;
    }
    if (projectBrowserTabs.length === 0 && activeProject) {
      const defaultArt = activeArtifacts.find((a) => a.kind === "doc") ?? activeArtifacts[0];
      if (defaultArt) {
        openArtifactInBrowser(defaultArt);
        return;
      }
      if (activeRepoFiles[0]) {
        openBrowserTab({
          projectId: activeProject.id,
          kind: "code",
          target: activeRepoFiles[0].relativePath,
          label: activeRepoFiles[0].name,
        });
        return;
      }
      openDiffInBrowser(activeProject.id);
      return;
    }
    setBrowserOpen(true);
  }, [
    browserOpen,
    projectBrowserTabs.length,
    activeProject,
    activeArtifacts,
    activeRepoFiles,
    openArtifactInBrowser,
    openBrowserTab,
    openDiffInBrowser,
  ]);

  const handleSelectSubView = useCallback(
    (view: BotsSubView, agentId?: string | null) => {
      setBotsSubView(view);
      if (agentId !== undefined) {
        setSelectedAgentId(agentId);
      }
    },
    [],
  );

  const handleSelectTarget = useCallback(
    (target: ModelTargetSelection) => {
      setSelectedChatTarget(target);
      void bf
        .sendCommand({
          type: "config.update",
          patchJson: JSON.stringify({
            routing: {
              defaultsByIntent: {
                meta_orchestrator: target,
              },
            },
          }),
        })
        .catch((err) => {
          pushToast(err instanceof Error ? err.message : String(err), "error");
        });
    },
    [bf.sendCommand, pushToast],
  );

  // Compute Context/Memory Ring % from loaded L1 memory budgets
  const contextBudget = useMemo(() => {
    const entries = Object.values(bf.l1Memory);
    if (entries.length === 0) {
      return { percent: 18, tooltip: "L1 Memory & Context budget" };
    }
    let used = 0;
    let max = 0;
    for (const entry of entries) {
      used += entry.usedChars;
      max += entry.maxChars;
    }
    const percent = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
    return {
      percent,
      tooltip: `L1 Memory & Context: ${used.toLocaleString()} / ${max.toLocaleString()} chars (${percent}%)`,
    };
  }, [bf.l1Memory]);

  const memoryRecalledActive = useMemo(() => {
    const hasL1Content = Object.values(bf.l1Memory).some((e) => e.usedChars > 0);
    return hasL1Content || bf.l2Facts.length > 0;
  }, [bf.l1Memory, bf.l2Facts.length]);

  // Pinned Bots (up to 3 top bots in active project: Team Lead, primary Builder, Verifier)
  const pinnedBots = useMemo(() => {
    const topLevel = projectAgents.filter((a) => a.scope !== "sidekick");
    return topLevel.slice(0, 3);
  }, [projectAgents]);

  const unreadBots = useMemo(
    () =>
      bf.agents.filter(
        (a) =>
          a.scope !== "global" &&
          (a.status === "working" ||
            a.status === "waiting_review" ||
            a.status === "debating" ||
            a.status === "requires_action"),
      ),
    [bf.agents],
  );

  const inboxAlertCount = useMemo(() => {
    const permCount = bf.pendingPermissions.length;
    const unknownCount = bf.quietStatus.unknownAdmissions?.length ?? 0;
    const actionNotices = bf.quietStatus.inboxNotices.filter((n) => n.level === "action").length;
    return permCount + unknownCount + actionNotices;
  }, [bf.pendingPermissions.length, bf.quietStatus]);

  // Unified Ctrl+K Palette entries (Bots + Subagents + Projects + Artifacts + Repo Files)
  const paletteEntries = useMemo<PaletteEntry[]>(() => {
    const q = paletteQuery.trim().toLowerCase();
    const out: PaletteEntry[] = [];

    for (const p of bf.projects) {
      if (!q || p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q)) {
        out.push({
          kind: "project",
          id: `prj:${p.id}`,
          title: p.name,
          subtitle: `Project · ${p.slug}`,
          projectId: p.id,
        });
      }
    }

    for (const a of bf.agents) {
      if (a.scope === "global") continue;
      const proj = bf.projects.find((p) => p.id === a.projectId);
      const hay = `${a.name} ${a.model} ${a.scope} ${proj?.name ?? ""}`.toLowerCase();
      if (!q || hay.includes(q)) {
        out.push({
          kind: "bot",
          id: `bot:${a.id}`,
          title: a.name,
          subtitle: `${a.scope === "sidekick" ? "Subagent" : resolveBotRole(a).jobTitle} · ${proj?.name ?? "Project"} · ${a.model}`,
          agent: a,
        });
      }
    }

    for (const [pid, list] of Object.entries(bf.artifactsByProject)) {
      const proj = bf.projects.find((p) => p.id === pid);
      for (const art of list) {
        const hay = `${art.name} ${art.relativePath} ${proj?.name ?? ""}`.toLowerCase();
        if (!q || hay.includes(q)) {
          out.push({
            kind: "artifact",
            id: `art:${pid}:${art.relativePath}`,
            title: art.name,
            subtitle: `Artifact · ${proj?.name ?? ""} · ${art.relativePath}`,
            projectId: pid,
            artifact: art,
          });
        }
      }
    }

    for (const [pid, files] of Object.entries(bf.repoFilesByProject)) {
      const proj = bf.projects.find((p) => p.id === pid);
      for (const rf of files.slice(0, 60)) {
        const hay = `${rf.name} ${rf.relativePath} ${proj?.name ?? ""}`.toLowerCase();
        if (!q || hay.includes(q)) {
          out.push({
            kind: "file",
            id: `file:${pid}:${rf.relativePath}`,
            title: rf.name,
            subtitle: `Repo · ${proj?.name ?? ""} · ${rf.relativePath}`,
            projectId: pid,
            file: rf,
          });
        }
      }
    }

    return out.slice(0, 30);
  }, [paletteQuery, bf.projects, bf.agents, bf.artifactsByProject, bf.repoFilesByProject]);

  const executePaletteEntry = useCallback(
    (entry: PaletteEntry) => {
      if (entry.kind === "project") {
        setSelectedProjectId(entry.projectId);
        if (world === "bots") setBotsSubView("chat_group");
      } else if (entry.kind === "bot") {
        if (entry.agent.projectId) setSelectedProjectId(entry.agent.projectId);
        setSelectedAgentId(entry.agent.id);
        setBotsSubView("chat_single");
        setWorld("bots");
      } else if (entry.kind === "artifact") {
        setSelectedProjectId(entry.projectId);
        openArtifactInBrowser(entry.artifact);
      } else if (entry.kind === "file") {
        setSelectedProjectId(entry.projectId);
        openBrowserTab({
          projectId: entry.projectId,
          kind: "code",
          target: entry.file.relativePath,
          label: entry.file.name,
        });
      }
      setPaletteOpen(false);
    },
    [world, openArtifactInBrowser, openBrowserTab],
  );

  const brandActivity = !bf.connected
    ? "connecting"
    : bf.quietStatus.runningBots > 0
      ? "working"
      : "idle";

  const activeBotMeta = activeAgent ? resolveBotRole(activeAgent) : null;

  if (bf.authRequired) {
    return (
      <div className="auth-gate-backdrop">
        <div className="auth-gate-card" role="dialog" aria-label="Unlock Bot-Factory Studio">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <BotAvatar role="orchestrator" size={40} />
            <div>
              <h1 style={{ margin: 0, fontSize: "var(--text-lg)", fontWeight: 600 }}>
                Unlock Bot-Factory Studio
              </h1>
              <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)" }}>
                Local loopback authentication required (127.0.0.1)
              </div>
            </div>
          </div>
          <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--ink-secondary)", lineHeight: 1.5 }}>
            Paste your session token from <code className="md-inline-code">~/bot-factory/system/.daemon-token</code>{" "}
            or launch via <code className="md-inline-code">bun run dev</code> to authenticate automatically.
          </p>
          {unlockError && <div className="inline-error">{unlockError}</div>}
          <form
            className="auth-gate-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (unlockBusy) return;
              setUnlockBusy(true);
              setUnlockError(null);
              try {
                await bf.unlockWithToken(unlockToken);
                setUnlockToken("");
              } catch (err) {
                setUnlockError(err instanceof Error ? err.message : String(err));
              } finally {
                setUnlockBusy(false);
              }
            }}
          >
            <input
              type="password"
              className="field-input"
              placeholder="bf_…"
              autoFocus
              value={unlockToken}
              onChange={(e) => setUnlockToken(e.target.value)}
            />
            <button type="submit" className="btn primary" disabled={unlockBusy || !unlockToken.trim()}>
              <Lock size={13} strokeWidth={1.7} />
              <span>{unlockBusy ? "Unlocking…" : "Unlock Studio"}</span>
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (!bf.hydrated) {
    return (
      <div className="app-shell-v3">
        <div className="hydration-shell">
          <BotThinkingOrb activity="connecting" size={32} label="Connecting to local daemon…" />
          <div style={{ fontWeight: 500, color: "var(--ink-primary)" }}>
            Connecting to Bot-Factory Daemon…
          </div>
          <div className="skeleton-stack" aria-hidden="true">
            <div className="skeleton-bar" style={{ width: "86%" }} />
            <div className="skeleton-bar" style={{ width: "68%" }} />
            <div className="skeleton-bar" style={{ width: "74%" }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell-v3">
      {/* Far-Left 44px Custom Icon Rail */}
      <nav className="icon-rail" aria-label="Primary navigation">
        <div className="icon-rail-top">
          <button
            type="button"
            className={`rail-mode-btn ${world === "chat" ? "active" : ""}`}
            onClick={() => setWorld("chat")}
            title="Main Agent (Ctrl+E)"
            aria-label="Main Agent"
          >
            <AgentChatApertureIcon size={18} />
          </button>

          <button
            type="button"
            className={`rail-mode-btn ${world === "bots" ? "active" : ""}`}
            onClick={() => setWorld("bots")}
            title="Engineering Teams (Ctrl+E)"
            aria-label="Engineering Teams"
          >
            <BotsLatticeIcon size={18} />
            {bf.quietStatus.runningBots > 0 && <span className="rail-badge">{bf.quietStatus.runningBots}</span>}
          </button>

          <div className="rail-divider" />

          <button
            type="button"
            className={`rail-util-btn ${drawerOpen ? "active" : ""}`}
            onClick={() => setDrawerOpen((o) => !o)}
            title="Toggle Sidebar (Ctrl+B)"
            aria-label="Toggle sidebar"
          >
            <SidebarToggleIcon size={16} />
          </button>

          <button
            type="button"
            className="rail-util-btn"
            onClick={() => {
              setPaletteOpen(true);
              setPaletteQuery("");
              setPaletteIndex(0);
            }}
            title="Quick Jump (Ctrl+K)"
            aria-label="Quick Jump"
          >
            <Search size={15} strokeWidth={1.6} />
          </button>

          <button
            type="button"
            data-inbox-trigger="true"
            className={`rail-util-btn ${inboxOpen ? "active" : ""}`}
            onClick={() => setInboxOpen((o) => !o)}
            title="Escalation Inbox"
            aria-label="Escalation Inbox"
          >
            <Bell size={15} strokeWidth={1.6} />
            {inboxAlertCount > 0 && (
              <span className={`rail-badge ${bf.pendingPermissions.length > 0 ? "danger" : ""}`}>
                {inboxAlertCount}
              </span>
            )}
          </button>

          <button
            type="button"
            className={`rail-util-btn ${settingsOpen ? "active" : ""}`}
            onClick={() => {
              setSettingsOpen(true);
              void bf.fetchConfigAndSecrets().catch((err) => {
                pushToast(err instanceof Error ? err.message : String(err), "error");
              });
            }}
            title="Settings & BYOS Keys"
            aria-label="Settings"
          >
            <Settings size={15} strokeWidth={1.6} />
          </button>
        </div>

        <div className="icon-rail-bottom">
          <BotThinkingOrb
            activity={brandActivity}
            size={20}
            label={
              !bf.connected
                ? "Reconnecting to daemon…"
                : bf.quietStatus.runningBots > 0
                  ? `${bf.quietStatus.runningBots} bots running`
                  : "Bot-Factory connected (127.0.0.1)"
            }
          />
        </div>
      </nav>

      {/* Secondary 248px Collapsible Contextual Drawer */}
      {drawerOpen && (
        <aside className="side-drawer">
          {world === "chat" ? (
            <>
              <div className="drawer-header">
                <span className="drawer-title">Bot-Factory</span>
                <span className="mono-tag">127.0.0.1</span>
              </div>

              <div className="drawer-scroll">
                <button
                  type="button"
                  className="drawer-new-btn"
                  onClick={() => setProjectModalOpen(true)}
                >
                  <FolderPlus size={14} strokeWidth={1.6} />
                  <span>New Project</span>
                </button>

                <div className="drawer-section">
                  <div className="section-eyebrow">
                    <span>Projects</span>
                    <span className="mono-tag">{bf.projects.length}</span>
                  </div>
                  {bf.projects.length === 0 && (
                    <div className="drawer-empty-hint">No projects yet. Create one to start.</div>
                  )}
                  {bf.projects.map((p) => {
                    const isActive = activeProject?.id === p.id;
                    const teamCount = bf.agents.filter((a) => a.projectId === p.id && a.scope !== "sidekick").length;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className={`drawer-item ${isActive ? "active" : ""}`}
                        onClick={() => setSelectedProjectId(p.id)}
                      >
                        <Folder size={14} strokeWidth={1.6} color="var(--ink-muted)" />
                        <span className="drawer-item-label">{p.name}</span>
                        <span className="mono-tag">{teamCount}</span>
                      </button>
                    );
                  })}
                </div>

                {activeProject && (
                  <div className="drawer-section">
                    <div className="section-eyebrow">
                      <span>Engineering Teams</span>
                      <span className="mono-tag">{projectAgents.length}</span>
                    </div>
                    <button
                      type="button"
                      className="drawer-item"
                      onClick={() => {
                        setBotsSubView("chat_group");
                        setWorld("bots");
                      }}
                    >
                      <BotsLatticeIcon size={14} />
                      <span className="drawer-item-label">{activeProject.name} Team</span>
                      <span className="mono-tag">{activeTasks.length} tasks</span>
                    </button>
                    <button
                      type="button"
                      className="drawer-item"
                      onClick={() => {
                        setMemoryStudioOpen(true);
                        void bf.fetchMemoryStudio(activeProject.id).catch((err) => {
                          pushToast(err instanceof Error ? err.message : String(err), "error");
                        });
                      }}
                    >
                      <Brain size={14} strokeWidth={1.6} />
                      <span className="drawer-item-label">Memory Studio</span>
                      <span className="mono-tag">{contextBudget.percent}%</span>
                    </button>
                  </div>
                )}

                {activeProject && (
                  <div className="drawer-section">
                    <div className="section-eyebrow">
                      <span>Browser Files</span>
                      <span className="mono-tag">{activeArtifacts.length}</span>
                    </div>
                    {activeArtifacts.map((art) => (
                      <button
                        key={art.relativePath}
                        type="button"
                        className="drawer-item"
                        onClick={() => openArtifactInBrowser(art)}
                      >
                        {art.kind === "image" ? (
                          <ImageTabIcon size={14} />
                        ) : art.kind === "model_3d" ? (
                          <Cube3DTabIcon size={14} />
                        ) : (
                          <DocTabIcon size={14} />
                        )}
                        <span className="drawer-item-label">{art.name}</span>
                      </button>
                    ))}
                    {activeRepoFiles.slice(0, 6).map((rf) => (
                      <button
                        key={rf.relativePath}
                        type="button"
                        className="drawer-item"
                        onClick={() =>
                          openBrowserTab({
                            projectId: activeProject.id,
                            kind: "code",
                            target: rf.relativePath,
                            label: rf.name,
                          })
                        }
                      >
                        <CodeTabIcon size={14} />
                        <span className="drawer-item-label">{rf.relativePath}</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      className="drawer-item"
                      onClick={() => openDiffInBrowser(activeProject.id)}
                    >
                      <DiffBranchIcon size={14} />
                      <span className="drawer-item-label">
                        Git Diff ({activeGitDiff?.filesChanged ?? 0})
                      </span>
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="drawer-header">
                <span className="drawer-title">Engineering Teams</span>
                <button
                  type="button"
                  className="btn xs"
                  onClick={() => setProjectModalOpen(true)}
                >
                  <Plus size={12} strokeWidth={1.6} />
                  <span>Project</span>
                </button>
              </div>

              <div className="drawer-scroll">
                {pinnedBots.length > 0 && activeProject && (
                  <div className="drawer-section">
                    <div className="section-eyebrow">
                      <span>Pinned Bots</span>
                      <span className="mono-tag">{pinnedBots.length}</span>
                    </div>
                    <div className="pinned-bots-grid">
                      {pinnedBots.map((bot) => {
                        const meta = resolveBotRole(bot);
                        const isSel = activeAgent?.id === bot.id && botsSubView === "chat_single";
                        return (
                          <button
                            key={bot.id}
                            type="button"
                            className={`pinned-bot-tile ${isSel ? "active" : ""}`}
                            onClick={() => {
                              setSelectedProjectId(activeProject.id);
                              setSelectedAgentId(bot.id);
                              setBotsSubView("chat_single");
                            }}
                            title={`${bot.name} (${meta.jobTitle})`}
                          >
                            <BotAvatar
                              role={meta.role}
                              size={28}
                              active={bot.status === "working" || bot.status === "debating"}
                            />
                            <span className="pinned-bot-name">{bot.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {unreadBots.length > 0 && (
                  <div className="drawer-section">
                    <div className="section-eyebrow">
                      <span>Active / Review</span>
                      <span className="pill warning">{unreadBots.length}</span>
                    </div>
                    {unreadBots.map((bot) => {
                      const meta = resolveBotRole(bot);
                      const isSel = activeAgent?.id === bot.id && botsSubView === "chat_single";
                      return (
                        <button
                          key={bot.id}
                          type="button"
                          className={`bot-roster-row ${isSel ? "active" : ""}`}
                          onClick={() => {
                            if (bot.projectId) setSelectedProjectId(bot.projectId);
                            setSelectedAgentId(bot.id);
                            setBotsSubView("chat_single");
                          }}
                        >
                          <BotAvatar
                            role={meta.role}
                            size={30}
                            active={bot.status === "working" || bot.status === "debating"}
                            badgeCount={
                              bot.status === "waiting_review" || bot.status === "requires_action" ? 1 : undefined
                            }
                          />
                          <div className="bot-roster-copy">
                            <div className="bot-roster-top">
                              <span className="bot-roster-name">{bot.name}</span>
                              <JobTitlePill label={meta.jobTitle} />
                            </div>
                            <div className="bot-roster-sub">{bot.lastSummary ?? bot.status}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {bf.projects.length === 0 && (
                  <div className="drawer-empty-hint">
                    No projects yet. Click <b>+ Project</b> above to provision one.
                  </div>
                )}

                {bf.projects.map((p) => {
                  const allProjectBots = bf.agents.filter((a) => a.projectId === p.id);
                  const topLevelBots = allProjectBots.filter((a) => a.scope !== "sidekick");
                  const isCurrentProj = activeProject?.id === p.id;
                  const clusterRoles = topLevelBots.slice(0, 4).map((b) => resolveBotRole(b).role);

                  return (
                    <div key={p.id} className="drawer-section">
                      <div className="drawer-proj-row">
                        <button
                          type="button"
                          className={`drawer-proj-title ${isCurrentProj ? "active" : ""}`}
                          onClick={() => {
                            setSelectedProjectId(p.id);
                            setBotsSubView("chat_group");
                          }}
                        >
                          <Folder size={13} strokeWidth={1.6} />
                          <span>{p.name}</span>
                        </button>
                        <button
                          type="button"
                          className="btn xs ghost"
                          title="Spawn a new peer bot in an isolated worktree"
                          onClick={() => {
                            setSelectedProjectId(p.id);
                            setBotSpawnModalOpen(true);
                          }}
                        >
                          <Plus size={12} strokeWidth={1.6} />
                          <span>Bot</span>
                        </button>
                      </div>

                      <button
                        type="button"
                        className={`bot-roster-row ${isCurrentProj && botsSubView === "chat_group" ? "active" : ""}`}
                        onClick={() => {
                          setSelectedProjectId(p.id);
                          setBotsSubView("chat_group");
                        }}
                      >
                        <GroupAvatarCluster
                          roles={clusterRoles.length > 0 ? clusterRoles : ["team_lead", "builder"]}
                          size={32}
                        />
                        <div className="bot-roster-copy">
                          <div className="bot-roster-top">
                            <span className="bot-roster-name">Core Team</span>
                            <JobTitlePill label="Group Chat" tone="accent" />
                          </div>
                          <div className="bot-roster-sub">
                            {topLevelBots.length} {topLevelBots.length === 1 ? "bot" : "bots"} in channel
                          </div>
                        </div>
                      </button>

                      {topLevelBots.map((bot) => {
                        const meta = resolveBotRole(bot);
                        const isSel = isCurrentProj && activeAgent?.id === bot.id && botsSubView === "chat_single";
                        const subagents = allProjectBots.filter(
                          (s) => s.scope === "sidekick" && s.parentAgentId === bot.id,
                        );
                        const subExpanded = expandedSubagentParents[bot.id] ?? true;

                        return (
                          <div key={bot.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <button
                              type="button"
                              className={`bot-roster-row ${isSel ? "active" : ""}`}
                              onClick={() => {
                                setSelectedProjectId(p.id);
                                setSelectedAgentId(bot.id);
                                setBotsSubView("chat_single");
                              }}
                            >
                              <BotAvatar
                                role={meta.role}
                                size={30}
                                active={bot.status === "working" || bot.status === "debating"}
                                badgeCount={
                                  bot.status === "waiting_review" || bot.status === "requires_action" ? 1 : undefined
                                }
                              />
                              <div className="bot-roster-copy">
                                <div className="bot-roster-top">
                                  <span className="bot-roster-name">{bot.name}</span>
                                  <JobTitlePill label={meta.jobTitle} />
                                </div>
                                <div className="bot-roster-sub">
                                  {bot.model}
                                  {bot.worktreeBranch ? ` · ${bot.worktreeBranch}` : ""}
                                </div>
                              </div>
                            </button>

                            {subagents.length > 0 && (
                              <div className="subagent-tree">
                                <button
                                  type="button"
                                  className="subagent-tree-toggle"
                                  onClick={() =>
                                    setExpandedSubagentParents((prev) => ({
                                      ...prev,
                                      [bot.id]: !subExpanded,
                                    }))
                                  }
                                >
                                  {subExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                                  <span>Subagents ({subagents.length})</span>
                                </button>
                                {subExpanded &&
                                  subagents.map((sub) => {
                                    const subSel =
                                      isCurrentProj && activeAgent?.id === sub.id && botsSubView === "chat_single";
                                    return (
                                      <button
                                        key={sub.id}
                                        type="button"
                                        className={`subagent-node ${subSel ? "active" : ""}`}
                                        onClick={() => {
                                          setSelectedProjectId(p.id);
                                          setSelectedAgentId(sub.id);
                                          setBotsSubView("chat_single");
                                        }}
                                      >
                                        <BotThinkingOrb status={sub.status} size={20} shell={false} />
                                        <span className="drawer-item-label">{sub.name}</span>
                                        <span className="mono-tag">{sub.subagentMode ?? "readonly"}</span>
                                      </button>
                                    );
                                  })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}

                <div className="drawer-section drawer-tools-section">
                  <div className="section-eyebrow">
                    <span>Workspace</span>
                  </div>
                  <button
                    type="button"
                    className={`drawer-item ${botsSubView === "board" ? "active" : ""}`}
                    onClick={() => setBotsSubView("board")}
                  >
                    <Kanban size={14} strokeWidth={1.6} />
                    <span className="drawer-item-label">Task Board</span>
                    <span className="mono-tag">{activeTasks.length}</span>
                  </button>
                  <button
                    type="button"
                    className={`drawer-item ${botsSubView === "checkpoints" ? "active" : ""}`}
                    onClick={() => setBotsSubView("checkpoints")}
                  >
                    <GitBranch size={14} strokeWidth={1.6} />
                    <span className="drawer-item-label">Checkpoints &amp; Merge</span>
                    <span className="mono-tag">{activeCheckpoints.length}</span>
                  </button>
                  <button
                    type="button"
                    className={`drawer-item ${botsSubView === "debates" ? "active" : ""}`}
                    onClick={() => setBotsSubView("debates")}
                  >
                    <MessageSquareWarning size={14} strokeWidth={1.6} />
                    <span className="drawer-item-label">Debates &amp; Verifier</span>
                    <span className="mono-tag">{activeDebates.length}</span>
                  </button>
                  <button
                    type="button"
                    className={`drawer-item ${botsSubView === "selfmod" ? "active" : ""}`}
                    onClick={() => setBotsSubView("selfmod")}
                  >
                    <Layers size={14} strokeWidth={1.6} />
                    <span className="drawer-item-label">Self-Mod Sandbox</span>
                    <span className="mono-tag">{bf.selfModProposals.length}</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </aside>
      )}

      {/* Center Primary Column + Resizable Right In-App Browser Sidebar */}
      <div className="workspace-split">
        <section className={`center-column ${browserOpen && browserExpanded ? "hidden" : ""}`}>
          {!bf.connected && (
            <div className="ws-banner" role="status">
              <div className="ws-banner-left">
                <WifiOff size={14} strokeWidth={1.7} />
                <span>
                  Daemon WebSocket disconnected — reconnecting to 127.0.0.1
                  {bf.reconnectingAttempt > 0 ? ` (attempt ${bf.reconnectingAttempt})` : ""}…
                </span>
              </div>
              <span className="mono-tag">Read-only until restored</span>
            </div>
          )}

          <header className="center-header">
            <div className="center-header-left">
              {world === "chat" ? (
                <>
                  <BotAvatar role="orchestrator" size={24} active={bf.quietStatus.runningBots > 0} />
                  <span className="center-header-title">Main Agent</span>
                  <JobTitlePill label="Quiet Mode" />
                  {activeProject && <span className="mono-tag">{activeProject.name}</span>}
                </>
              ) : botsSubView === "chat_group" && activeProject ? (
                <>
                  <GroupAvatarCluster
                    roles={
                      projectAgents.length > 0
                        ? projectAgents.slice(0, 4).map((a) => resolveBotRole(a).role)
                        : ["team_lead", "builder"]
                    }
                    size={26}
                  />
                  <span className="center-header-title">{activeProject.name}</span>
                  <JobTitlePill label={`${projectAgents.length} Bots`} tone="accent" />
                </>
              ) : botsSubView === "chat_single" && activeAgent && activeBotMeta ? (
                <>
                  <BotAvatar
                    role={activeBotMeta.role}
                    size={26}
                    active={activeAgent.status === "working" || activeAgent.status === "debating"}
                  />
                  <span className="center-header-title">{activeAgent.name}</span>
                  <JobTitlePill label={activeBotMeta.jobTitle} />
                  {activeAgent.worktreeBranch && (
                    <span className="mono-tag">{activeAgent.worktreeBranch}</span>
                  )}
                </>
              ) : (
                <span className="center-header-title">
                  {botsSubView === "board"
                    ? `Task Board · ${activeProject?.name ?? ""}`
                    : botsSubView === "checkpoints"
                      ? `Checkpoints & Merge · ${activeProject?.name ?? ""}`
                      : botsSubView === "debates"
                        ? `Debates & Verifier · ${activeProject?.name ?? ""}`
                        : "Self-Mod Sandbox"}
                </span>
              )}
            </div>

            <div className="center-header-right">
              {bf.pendingPermissions.length > 0 && (
                <button
                  type="button"
                  data-inbox-trigger="true"
                  className="btn xs accent"
                  onClick={() => setInboxOpen(true)}
                >
                  <Bell size={12} strokeWidth={1.7} />
                  <span>{bf.pendingPermissions.length} Permission</span>
                </button>
              )}

              {world === "bots" && activeAgent && (botsSubView === "chat_single" || botsSubView === "chat_group") && (
                <div className="safety-controls">
                  {(activeAgent.status === "paused" ||
                    activeAgent.status === "stopped" ||
                    activeAgent.status === "error") && (
                    <button
                      type="button"
                      className="btn xs"
                      disabled={safetyBusy}
                      onClick={async () => {
                        setSafetyBusy(true);
                        try {
                          await bf.sendCommand({ type: "bot.resume", agentId: activeAgent.id });
                        } catch (err) {
                          pushToast(err instanceof Error ? err.message : String(err), "error");
                        } finally {
                          setSafetyBusy(false);
                        }
                      }}
                      title="Resume bot session"
                    >
                      <Play size={12} strokeWidth={1.6} />
                      <span>Resume</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn xs"
                    disabled={safetyBusy || activeAgent.status === "paused" || activeAgent.status === "stopped"}
                    onClick={async () => {
                      setSafetyBusy(true);
                      try {
                        await bf.sendCommand({ type: "bot.pause", agentId: activeAgent.id });
                      } catch (err) {
                        pushToast(err instanceof Error ? err.message : String(err), "error");
                      } finally {
                        setSafetyBusy(false);
                      }
                    }}
                    title="Soft pause active bot"
                  >
                    <Pause size={12} strokeWidth={1.6} />
                    <span>Pause</span>
                  </button>
                  <button
                    type="button"
                    className="btn xs danger"
                    disabled={safetyBusy || activeAgent.status === "stopped"}
                    onClick={async () => {
                      setSafetyBusy(true);
                      try {
                        await bf.sendCommand({ type: "bot.stop", agentId: activeAgent.id });
                      } catch (err) {
                        pushToast(err instanceof Error ? err.message : String(err), "error");
                      } finally {
                        setSafetyBusy(false);
                      }
                    }}
                    title="Hard process stop"
                  >
                    <OctagonX size={12} strokeWidth={1.6} />
                    <span>Stop</span>
                  </button>
                </div>
              )}

              <button
                type="button"
                className={`btn xs ${browserOpen ? "active-outline" : ""}`}
                onClick={toggleBrowserSidebar}
                title="Toggle In-App Browser"
              >
                <BrowserPaneIcon size={14} />
                <span>Browser</span>
              </button>
            </div>
          </header>

          <main className="world-container">
            <div className={`world-pane ${world === "chat" ? "" : "hidden"}`}>
              <ChatTab
                messages={bf.chatMessages}
                cards={bf.chatCards}
                streamingText={bf.streamingChatText}
                streamingThought={bf.streamingChatThought}
                projects={bf.projects}
                activeProject={activeProject}
                tasksByProject={bf.tasksByProject}
                quietStatus={bf.quietStatus}
                activeModelLabel={
                  effectiveChatTarget
                    ? `${effectiveChatTarget.provider}/${effectiveChatTarget.model}`
                    : "mistral-hosted/mistral-large-latest"
                }
                providers={bf.providers}
                selectedTarget={effectiveChatTarget}
                onSelectTarget={handleSelectTarget}
                contextPercent={contextBudget.percent}
                contextTooltip={contextBudget.tooltip}
                memoryRecalledActive={memoryRecalledActive}
                gitDiff={activeGitDiff}
                effort={effort}
                autonomy={autonomy}
                onChangeEffort={setEffort}
                onChangeAutonomy={setAutonomy}
                onSelectProject={setSelectedProjectId}
                onSendChat={async (text) => {
                  await bf.sendCommand({
                    type: "chat.send",
                    text,
                    projectId: activeProject?.id,
                    reasoningEffort: effort,
                    autonomyLevel: autonomy,
                  });
                }}
                onOpenNewProjectModal={() => setProjectModalOpen(true)}
                onOpenProjectPreview={(projectId, artifactPath) => {
                  setSelectedProjectId(projectId);
                  const path = artifactPath ?? "plans/roadmap.md";
                  const kind: BrowserTabKind =
                    path.endsWith(".glb") || path.endsWith(".gltf")
                      ? "model_3d"
                      : /\.(png|jpg|jpeg|svg|webp)$/i.test(path)
                        ? "image"
                        : "doc";
                  openBrowserTab({
                    projectId,
                    kind,
                    target: path,
                    label: path.split("/").pop() ?? path,
                  });
                }}
                onOpenDiffInBrowser={openDiffInBrowser}
                onOpenBrowser={toggleBrowserSidebar}
                onSwitchToBots={(projectId) => {
                  if (projectId) setSelectedProjectId(projectId);
                  setBotsSubView("chat_group");
                  setWorld("bots");
                }}
                onOpenMemoryStudio={() => {
                  setMemoryStudioOpen(true);
                  void bf.fetchMemoryStudio(activeProject?.id).catch(() => {});
                }}
                onMergeTask={async (projectId, taskId) => {
                  await bf.sendCommand({
                    type: "task.merge",
                    projectId,
                    taskId,
                    strategy: "squash",
                  });
                  pushToast("Task squash-merge queued for main", "success");
                }}
              />
            </div>

            <div className={`world-pane ${world === "bots" ? "" : "hidden"}`}>
              <BotsTab
                isVisible={world === "bots"}
                projects={bf.projects}
                activeProject={activeProject}
                agents={bf.agents}
                providers={bf.providers}
                tasks={activeTasks}
                goals={activeGoals}
                timelinesByAgent={bf.timelinesByAgent}
                streamingBotTextByAgent={bf.streamingBotTextByAgent}
                streamingBotThoughtByAgent={bf.streamingBotThoughtByAgent}
                artifacts={activeArtifacts}
                debates={activeDebates}
                debateMessagesByDebate={bf.debateMessagesByDebate}
                verifications={activeVerifications}
                checkpoints={activeCheckpoints}
                gitDiff={activeGitDiff}
                activeSubView={botsSubView}
                activeAgentId={activeAgent?.id ?? null}
                selfModProposals={bf.selfModProposals}
                onSelectSubView={handleSelectSubView}
                onSelectProject={setSelectedProjectId}
                onOpenProjectModal={() => setProjectModalOpen(true)}
                onOpenBotSpawnModal={() => setBotSpawnModalOpen(true)}
                onOpenBrowserItem={openBrowserItem}
                onSendCommand={bf.sendCommand}
                onFetchCheckpoints={bf.fetchCheckpoints}
                onNotifyError={(msg) => pushToast(msg, "error")}
              />
            </div>
          </main>
        </section>

        {browserOpen && (
          <>
            {!browserExpanded && (
              <div
                className="browser-resize-gutter"
                onMouseDown={() => {
                  draggingBrowserRef.current = true;
                  document.body.style.cursor = "col-resize";
                }}
                title="Drag to resize"
              />
            )}
            <aside
              className={`browser-sidebar-pane ${browserExpanded ? "expanded" : ""}`}
              style={browserExpanded ? undefined : { width: browserWidth }}
            >
              <InAppBrowser
                project={activeProject}
                artifacts={activeArtifacts}
                annotations={activeAnnotations}
                repoFiles={activeRepoFiles}
                gitDiff={activeGitDiff}
                activeAgentId={activeAgent?.id ?? null}
                tabs={projectBrowserTabs}
                activeTabId={activeBrowserTabId}
                expanded={browserExpanded}
                onSelectTab={(tabId) => {
                  if (activeProject) {
                    setActiveTabIdByProject((prev) => ({ ...prev, [activeProject.id]: tabId }));
                  }
                }}
                onCloseTab={closeBrowserTab}
                onOpenTab={openBrowserTab}
                onToggleExpand={() => setBrowserExpanded((e) => !e)}
                onCloseSidebar={() => {
                  setBrowserOpen(false);
                  setBrowserExpanded(false);
                }}
                onRefreshContext={() => {
                  if (activeProject) {
                    void bf.refreshProjectCodeContext(activeProject.id, activeAgent?.id);
                  }
                }}
                onCreateAnnotation={async (params) => {
                  if (!activeProject) return;
                  await bf.sendCommand({
                    type: "annotation.create",
                    projectId: activeProject.id,
                    anchor: params.anchor,
                    comment: params.comment,
                    snapshotDataUrl: params.snapshotDataUrl,
                    requestFixNow: params.requestFixNow,
                  });
                }}
                onResolveAnnotation={async (annotationId, status) => {
                  await bf.sendCommand({ type: "annotation.resolve", annotationId, status });
                }}
              />
            </aside>
          </>
        )}
      </div>

      {/* Floating Escalation Inbox Popover */}
      <EscalationInbox
        open={inboxOpen}
        onClose={() => setInboxOpen(false)}
        quietStatus={bf.quietStatus}
        pendingPermissions={bf.pendingPermissions}
        agents={bf.agents}
        projects={bf.projects}
        onPermissionRespond={async (permissionId, decision) => {
          await bf.sendCommand({ type: "permission.respond", permissionId, decision });
        }}
        onResolveUnknown={async (admissionId, expectedGeneration) => {
          await bf.sendCommand({ type: "session.resolve_unknown", admissionId, expectedGeneration });
        }}
        onDismissNotice={async (noticeId) => {
          await bf.sendCommand({ type: "inbox.dismiss", noticeId });
        }}
        onJumpToProjectMerge={(projectId) => {
          setSelectedProjectId(projectId);
          setWorld("bots");
          setBotsSubView("checkpoints");
        }}
      />

      {/* Wave 4 Studio Modals */}
      <ProjectModal
        open={projectModalOpen}
        onClose={() => setProjectModalOpen(false)}
        onSubmit={async (input) => {
          const res = await bf.sendCommand<{ project: { id: string }; projectManager: { id: string } }>({
            type: "project.create",
            name: input.name,
            ...(input.slug ? { slug: input.slug } : {}),
            ...(input.externalRepoPath ? { externalRepoPath: input.externalRepoPath } : {}),
            seedDemoArtifacts: input.seedDemoArtifacts,
            ...(input.verifyChecks.length > 0 ? { verifyChecks: input.verifyChecks } : {}),
          });
          setSelectedProjectId(res.project.id);
          setSelectedAgentId(res.projectManager?.id ?? null);
          pushToast(`Project "${input.name}" provisioned`, "success");
        }}
      />

      <BotSpawnModal
        open={botSpawnModalOpen}
        project={activeProject}
        providers={bf.providers}
        onClose={() => setBotSpawnModalOpen(false)}
        onSubmit={async (input) => {
          const res = await bf.sendCommand<{ agent: { id: string; name: string } }>({
            type: "bot.spawn",
            projectId: input.projectId,
            name: input.name,
            scope: input.scope,
            ...(input.provider ? { provider: input.provider } : {}),
            ...(input.model ? { model: input.model } : {}),
            autonomyLevel: input.autonomyLevel,
            reasoningEffort: input.reasoningEffort,
          });
          setSelectedProjectId(input.projectId);
          setSelectedAgentId(res.agent.id);
          setBotsSubView("chat_single");
          setWorld("bots");
          pushToast(`Spawned ${res.agent.name}`, "success");
        }}
      />

      <SettingsView
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        config={bf.configData}
        projects={bf.projects}
        activeProject={activeProject}
        providers={bf.providers}
        secretsPresence={bf.secretsPresence}
        onRefresh={bf.fetchConfigAndSecrets}
        onSaveSecret={bf.saveSecret}
        onDeleteSecret={bf.deleteSecret}
        onTestProvider={bf.testProviderConnection}
        onSendCommand={bf.sendCommand}
      />

      <MemoryL1Studio
        open={memoryStudioOpen}
        onClose={() => setMemoryStudioOpen(false)}
        projects={bf.projects}
        activeProject={activeProject}
        l1Memory={bf.l1Memory}
        l2Facts={bf.l2Facts}
        onRefreshMemory={bf.fetchMemoryStudio}
        onSendCommand={bf.sendCommand}
      />

      {/* Ctrl+K Quick-Jump Command Palette */}
      {paletteOpen && (
        <div className="modal-backdrop" onClick={() => setPaletteOpen(false)}>
          <div
            className="palette-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Quick Jump Palette"
          >
            <div className="palette-search-row">
              <Search size={14} strokeWidth={1.6} color="var(--ink-muted)" />
              <input
                autoFocus
                className="composer-input"
                placeholder="Jump to bot, subagent, project, artifact, or repo file…"
                value={paletteQuery}
                onChange={(e) => {
                  setPaletteQuery(e.target.value);
                  setPaletteIndex(0);
                }}
                onKeyDown={(e) => {
                  if (paletteEntries.length === 0) return;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setPaletteIndex((i) => (i + 1) % paletteEntries.length);
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setPaletteIndex((i) => (i - 1 + paletteEntries.length) % paletteEntries.length);
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    const picked = paletteEntries[paletteIndex] ?? paletteEntries[0];
                    if (picked) executePaletteEntry(picked);
                  }
                }}
              />
              <span className="kbd-chip">Esc</span>
            </div>
            <div className="palette-list">
              {paletteEntries.length === 0 && (
                <div style={{ padding: "14px 10px", color: "var(--ink-muted)", fontSize: "var(--text-xs)" }}>
                  No matching projects, bots, artifacts, or files found.
                </div>
              )}
              {paletteEntries.map((entry, idx) => {
                const isSelected = idx === paletteIndex;
                return (
                  <button
                    type="button"
                    key={entry.id}
                    className={`palette-item ${isSelected ? "selected" : ""}`}
                    onMouseEnter={() => setPaletteIndex(idx)}
                    onClick={() => executePaletteEntry(entry)}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                      {entry.kind === "bot" ? (
                        <BotAvatar
                          role={resolveBotRole(entry.agent).role}
                          size={24}
                          active={entry.agent.status === "working"}
                        />
                      ) : entry.kind === "project" ? (
                        <Folder size={15} strokeWidth={1.6} color="var(--ink-muted)" />
                      ) : entry.kind === "artifact" ? (
                        entry.artifact.kind === "image" ? (
                          <ImageTabIcon size={15} />
                        ) : entry.artifact.kind === "model_3d" ? (
                          <Cube3DTabIcon size={15} />
                        ) : (
                          <DocTabIcon size={15} />
                        )
                      ) : (
                        <CodeTabIcon size={15} />
                      )}
                      <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {entry.title}
                      </span>
                    </span>
                    <span className="mono-tag">{entry.subtitle}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Unified Toast Stack */}
      {toasts.length > 0 && (
        <div className="toast-stack" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast-item ${toast.tone}`}>
              <span>{toast.message}</span>
              <button
                type="button"
                className="btn xs ghost"
                onClick={() => dismissToast(toast.id)}
                aria-label="Dismiss notification"
              >
                <X size={12} strokeWidth={1.6} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
