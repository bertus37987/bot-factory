import {
  Bell,
  Brain,
  ChevronDown,
  ChevronRight,
  Columns2,
  Folder,
  FolderPlus,
  GitBranch,
  Kanban,
  Layers,
  Lock,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRecord, ArtifactEntry, RepoFileEntry } from "@bot-factory/shared";
import { BotsTab, type BotsSubView } from "./bots/BotsTab";
import { TeamSwitcher } from "./bots/TeamSwitcher";
import { BrowserWorkspaceShell } from "./browser/BrowserWorkspaceShell";
import { InAppBrowser, type BrowserTab, type BrowserTabKind } from "./browser/InAppBrowser";
import type { BrowserDockMode, ComposerAttachment } from "./browser/types";
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
import { ResizeSplitter } from "./components/ResizeSplitter";
import { BotSpawnModal } from "./studio/BotSpawnModal";
import { EscalationInbox } from "./studio/EscalationInbox";
import { MemoryL1Studio } from "./studio/MemoryL1Studio";
import { ProjectModal } from "./studio/ProjectModal";
import { SettingsView } from "./studio/SettingsView";

type ThemeMode = "vanta" | "light";

const LS_THEME = "bf_theme";
const LS_DRAWER_W = "bf_drawer_w";
const LS_BROWSER_DOCK = "bf_browser_dock";
const LS_SPLIT_PCT = "bf_split_pct";

function readStoredTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(LS_THEME);
    return raw === "light" ? "light" : "vanta";
  } catch {
    return "vanta";
  }
}

function readStoredNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // Ignore storage write errors.
  }
}

function readStoredDockMode(): BrowserDockMode {
  try {
    const raw = localStorage.getItem(LS_BROWSER_DOCK);
    if (raw === "right" || raw === "bottom" || raw === "float") return raw;
    return "right";
  } catch {
    return "right";
  }
}

const clampDrawerWidth = (w: number) => Math.max(180, Math.min(420, Math.round(w)));
const clampSplitPercent = (pct: number) => Math.max(36, Math.min(64, Math.round(pct * 10) / 10));

if (typeof document !== "undefined") {
  document.documentElement.dataset.theme = readStoredTheme();
}

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
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const initial = readStoredTheme();
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = initial;
    }
    return initial;
  });
  const [world, setWorld] = useState<"chat" | "bots">("chat");
  const [drawerOpen, setDrawerOpen] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 1000 : true,
  );
  const [drawerWidth, setDrawerWidth] = useState<number>(() =>
    clampDrawerWidth(readStoredNumber(LS_DRAWER_W, 256)),
  );
  const [splitRequested, setSplitChatOpen] = useState(false);
  const [narrowChat, setNarrowChat] = useState(() => window.matchMedia("(max-width: 699px)").matches);
  const splitChatOpen = splitRequested && !narrowChat;
  const [splitPercent, setSplitPercent] = useState<number>(() =>
    clampSplitPercent(readStoredNumber(LS_SPLIT_PCT, 48)),
  );
  const [focusedChatPane, setFocusedChatPane] = useState<"chat" | "bots">("chat");
  const [composerAttachmentsByTarget, setComposerAttachmentsByTarget] = useState<
    Record<string, ComposerAttachment[]>
  >({});

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [botsSubView, setBotsSubView] = useState<BotsSubView>("chat_group");

  const [effort, setEffort] = useState<ReasoningEffort>("high");
  const [autonomy, setAutonomy] = useState<AutonomyLevel>("medium");
  const [selectedChatTarget, setSelectedChatTarget] = useState<ModelTargetSelection | null>(null);

  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserDockMode, setBrowserDockMode] = useState<BrowserDockMode>(() => readStoredDockMode());
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
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const [unlockToken, setUnlockToken] = useState("");
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const drawerWidthRef = useRef(drawerWidth);
  drawerWidthRef.current = drawerWidth;
  const splitPercentRef = useRef(splitPercent);
  splitPercentRef.current = splitPercent;
  const worldContainerRef = useRef<HTMLElement | null>(null);
  const browserTabsRef = useRef<BrowserTab[]>([]);
  browserTabsRef.current = browserTabs;
  const toastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(LS_THEME, theme);
    } catch {
      // Ignore storage write errors.
    }
  }, [theme]);

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

  // Keep BotsTab subscriptions active when Bots world OR Split-Chat is visible
  const botsVisible = world === "bots" || splitChatOpen;
  const projectAgentIdsKey = projectAgents.map((a) => a.id).join(",");
  useEffect(() => {
    if (!botsVisible || !activeProject) return;
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
  }, [botsVisible, activeProject?.id, projectAgentIdsKey, bf.subscribe, bf.unsubscribe]);

  // Responsive <1000px drawer auto-collapse
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 999px)");
    const onChange = (e: MediaQueryListEvent) => {
      setDrawerOpen(!e.matches);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 699px)");
    const onChange = (e: MediaQueryListEvent) => setNarrowChat(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Global keyboard shortcuts (Ctrl+E world switch, Ctrl+K quick palette, Ctrl+B toggle drawer, Ctrl+Shift+S split chat)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        if (narrowChat) return;
        e.preventDefault();
        setSplitChatOpen((s) => !s);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setWorld((w) => {
          const next = w === "chat" ? "bots" : "chat";
          setFocusedChatPane(next);
          return next;
        });
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
  }, [narrowChat]);

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
          if (browserDockMode === "fullscreen") setBrowserDockMode("right");
        }
      }
    },
    [activeProject?.id, browserDockMode],
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
      if (browserDockMode === "fullscreen") setBrowserDockMode("right");
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
    browserDockMode,
    projectBrowserTabs.length,
    activeProject,
    activeArtifacts,
    activeRepoFiles,
    openArtifactInBrowser,
    openBrowserTab,
    openDiffInBrowser,
  ]);

  const chatTargetKey = "chat";
  const botsTargetKey =
    botsSubView === "chat_single" && activeAgent
      ? `bots:${activeAgent.id}`
      : `bots:group:${activeProject?.id ?? "none"}`;
  const activeAttachmentTarget = (splitChatOpen ? focusedChatPane === "bots" : world === "bots")
    ? botsTargetKey
    : chatTargetKey;

  const handleImportAttachment = useCallback(
    (att: ComposerAttachment) => {
      setComposerAttachmentsByTarget((prev) => {
        const current = prev[activeAttachmentTarget] ?? [];
        const deduped = current.filter((item) => item.id !== att.id);
        return {
          ...prev,
          [activeAttachmentTarget]: [...deduped, att],
        };
      });
      if (browserOpen && browserDockMode === "fullscreen") {
        pushToast(
          `Attached "${att.label}" to ${activeAttachmentTarget === "chat" ? "Main Agent" : "Team"} composer`,
          "info",
        );
      }
    },
    [activeAttachmentTarget, browserOpen, browserDockMode, pushToast],
  );

  const removeComposerAttachment = useCallback((targetKey: string, id: string) => {
    setComposerAttachmentsByTarget((prev) => ({
      ...prev,
      [targetKey]: (prev[targetKey] ?? []).filter((item) => item.id !== id),
    }));
  }, []);

  const clearComposerAttachments = useCallback((targetKey: string) => {
    setComposerAttachmentsByTarget((prev) => {
      if (!(targetKey in prev) || (prev[targetKey]?.length ?? 0) === 0) return prev;
      return { ...prev, [targetKey]: [] };
    });
  }, []);

  const clearSentAttachments = useCallback((targetKey: string, sent: ComposerAttachment[]) => {
    if (!sent.length) return;
    const sentItems = new Set(sent);
    setComposerAttachmentsByTarget((prev) => ({
      ...prev,
      [targetKey]: (prev[targetKey] ?? []).filter((item) => !sentItems.has(item)),
    }));
  }, []);

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

  const selectBotsTeam = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    setSelectedAgentId(null);
    setBotsSubView("chat_group");
    setFocusedChatPane("bots");
    if (window.matchMedia("(max-width: 999px)").matches) setDrawerOpen(false);
  }, []);

  const selectRosterBot = (agentId: string) => {
    handleSelectSubView("chat_single", agentId);
    if (window.matchMedia("(max-width: 999px)").matches) setDrawerOpen(false);
  };

  const selectBotsWorkspace = (view: BotsSubView) => {
    handleSelectSubView(view);
    if (window.matchMedia("(max-width: 999px)").matches) setDrawerOpen(false);
  };

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
          subtitle: `${resolveBotRole(a).jobTitle} · ${proj?.name ?? "Project"} · ${a.model}`,
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
        if (world === "bots" || splitChatOpen) selectBotsTeam(entry.projectId);
        else setSelectedProjectId(entry.projectId);
      } else if (entry.kind === "bot") {
        if (entry.agent.projectId) setSelectedProjectId(entry.agent.projectId);
        setSelectedAgentId(entry.agent.id);
        setBotsSubView("chat_single");
        setWorld("bots");
        setFocusedChatPane("bots");
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
    [world, splitChatOpen, selectBotsTeam, openArtifactInBrowser, openBrowserTab],
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
    <div className={`app-shell-v3${world === "bots" ? " bots-inbox-active" : ""}`}>
      {/* Far-Left 44px Custom Icon Rail */}
      <nav className="icon-rail" aria-label="Primary navigation">
        <div className="icon-rail-top">
          <button
            type="button"
            className={`rail-mode-btn ${world === "chat" ? "active" : ""}`}
            onClick={() => {
              setWorld("chat");
              setFocusedChatPane("chat");
            }}
            title="Main Agent (Ctrl+E)"
            aria-label="Main Agent"
          >
            <AgentChatApertureIcon size={18} />
          </button>

          <button
            type="button"
            className={`rail-mode-btn ${world === "bots" ? "active" : ""}`}
            onClick={() => {
              setWorld("bots");
              setFocusedChatPane("bots");
            }}
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
            aria-expanded={drawerOpen}
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
          <button
            type="button"
            data-testid="theme-toggle-btn"
            className="rail-util-btn"
            onClick={() => setTheme((t) => (t === "vanta" ? "light" : "vanta"))}
            title={theme === "vanta" ? "Switch to Light Mode" : "Switch to Vanta Black"}
            aria-label={theme === "vanta" ? "Switch to Light theme" : "Switch to Vanta Black theme"}
          >
            {theme === "vanta" ? <Sun size={15} strokeWidth={1.6} /> : <Moon size={15} strokeWidth={1.6} />}
          </button>
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

      {/* Secondary Resizable & Collapsible Contextual Drawer */}
      {drawerOpen && (
        <>
          <aside className={`side-drawer ${world === "bots" ? "bots-inbox-drawer" : ""}`} style={{ width: drawerWidth }}>
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
                        setFocusedChatPane("bots");
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
                      <span className="mono-tag">
                        {activeArtifacts.length +
                          (activeRepoFiles.some((f) => f.relativePath === "README.md") ? 1 : 0)}
                      </span>
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
                <span className="drawer-title">Conversations</span>
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
                {bf.projects.length === 0 && (
                  <div className="drawer-empty-hint">
                    No projects yet. Click <b>+ Project</b> above to provision one.
                  </div>
                )}

                {(activeProject ? [activeProject] : []).map((p) => {
                  const allProjectBots = projectAgents;
                  const topLevelBots = allProjectBots.filter((a) => a.scope !== "sidekick");
                  const clusterRoles = topLevelBots.slice(0, 4).map((b) => resolveBotRole(b).role);

                  return (
                    <div key={p.id} className="drawer-section">
                      <div className="drawer-proj-row">
                        <div className="drawer-proj-title">
                          <span>{p.name}</span>
                        </div>
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
                        className={`bot-roster-row ${botsSubView === "chat_group" ? "active" : ""}`}
                        aria-current={botsSubView === "chat_group" ? "true" : undefined}
                        onClick={() => selectBotsTeam(p.id)}
                      >
                        <GroupAvatarCluster
                          roles={clusterRoles.length > 0 ? clusterRoles : ["team_lead", "builder"]}
                          size={32}
                        />
                        <div className="bot-roster-copy">
                          <div className="bot-roster-top">
                            <span className="bot-roster-name">Group Chat</span>
                          </div>
                          <div className="bot-roster-sub">
                            {topLevelBots.length} {topLevelBots.length === 1 ? "bot" : "bots"} in channel
                          </div>
                        </div>
                      </button>

                      {topLevelBots.map((bot) => {
                        const meta = resolveBotRole(bot);
                        const isSel = activeAgent?.id === bot.id && botsSubView === "chat_single";
                        const subagents = allProjectBots.filter(
                          (s) => s.scope === "sidekick" && s.parentAgentId === bot.id,
                        );
                        const subExpanded = expandedSubagentParents[bot.id] ?? true;

                        return (
                          <div key={bot.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <button
                              type="button"
                              className={`bot-roster-row ${isSel ? "active" : ""}`}
                              aria-current={isSel ? "true" : undefined}
                              onClick={() => selectRosterBot(bot.id)}
                            >
                              <BotAvatar
                                role={meta.role}
                                size={30}
                                active={bot.status === "working" || bot.status === "debating"}
                                agentStatus={bot.status}
                                seed={bot.id}
                              />
                              <div className="bot-roster-copy">
                                <div className="bot-roster-top">
                                  <span className="bot-roster-name">{bot.name}</span>
                                  <JobTitlePill label={meta.jobTitle} role={meta.role} />
                                </div>
                                <div className="bot-roster-sub">
                                  {bot.status.replaceAll("_", " ")}
                                  {bot.lastSummary ? ` · ${bot.lastSummary}` : ""}
                                </div>
                              </div>
                            </button>

                            {subagents.length > 0 && (
                              <div className="subagent-tree">
                                <button
                                  type="button"
                                  className="subagent-tree-toggle"
                                  aria-expanded={subExpanded}
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
                                      activeAgent?.id === sub.id && botsSubView === "chat_single";
                                    return (
                                      <button
                                        key={sub.id}
                                        type="button"
                                        className={`subagent-node ${subSel ? "active" : ""}`}
                                        aria-current={subSel ? "true" : undefined}
                                        onClick={() => selectRosterBot(sub.id)}
                                      >
                                        <BotAvatar
                                          role="cub"
                                          size={22}
                                          active={sub.status === "working"}
                                          agentStatus={sub.status}
                                          seed={sub.id}
                                        />
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
                    onClick={() => selectBotsWorkspace("board")}
                  >
                    <Kanban size={14} strokeWidth={1.6} />
                    <span className="drawer-item-label">Task Board</span>
                    <span className="mono-tag">{activeTasks.length}</span>
                  </button>
                  <button
                    type="button"
                    className={`drawer-item ${botsSubView === "checkpoints" ? "active" : ""}`}
                    onClick={() => selectBotsWorkspace("checkpoints")}
                  >
                    <GitBranch size={14} strokeWidth={1.6} />
                    <span className="drawer-item-label">Checkpoints &amp; Merge</span>
                    <span className="mono-tag">{activeCheckpoints.length}</span>
                  </button>
                  <button
                    type="button"
                    className={`drawer-item ${botsSubView === "selfmod" ? "active" : ""}`}
                    onClick={() => selectBotsWorkspace("selfmod")}
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
        <ResizeSplitter
          orientation="vertical"
          edge="right"
          className="side-drawer-splitter"
          ariaLabel="Resize sidebar width"
          onDelta={(dx) => setDrawerWidth((prev) => clampDrawerWidth(prev + dx))}
          onResizeEnd={() => writeStoredNumber(LS_DRAWER_W, drawerWidthRef.current)}
        />
        </>
      )}

      {/* Center Primary Column + Resizable 4-Mode In-App Browser Shell */}
      <div
        className="workspace-split"
        style={{
          flexDirection: browserOpen && browserDockMode === "bottom" ? "column" : "row",
        }}
      >
        <section className={`center-column ${browserOpen && browserDockMode === "fullscreen" ? "hidden" : ""}`}>
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

          <header className={`center-header${world === "bots" && !splitChatOpen ? " bots-topbar" : ""}`}>
            <div className="center-header-left">
              {world === "bots" && !splitChatOpen && (
                <TeamSwitcher projects={bf.projects} agents={bf.agents} project={activeProject} onSelect={selectBotsTeam} />
              )}
              {splitChatOpen ? (
                <>
                  <BotAvatar
                    role="orchestrator"
                    size={24}
                    active={bf.quietStatus.runningBots > 0}
                    seed="main-agent"
                  />
                  <span className="center-header-title">
                    Main Agent ⇄ {activeProject?.name ?? "Engineering Teams"}
                  </span>
                  <JobTitlePill
                    label={`Focus: ${focusedChatPane === "chat" ? "Main Agent" : "Team"}`}
                    role={focusedChatPane === "chat" ? "orchestrator" : "team_lead"}
                  />
                </>
              ) : world === "chat" ? (
                <>
                  <BotAvatar
                    role="orchestrator"
                    size={24}
                    active={bf.quietStatus.runningBots > 0}
                    seed="main-agent"
                  />
                  <span className="center-header-title">Main Agent</span>
                  <JobTitlePill label="Quiet Mode" role="orchestrator" />
                  {activeProject && <span className="mono-tag">{activeProject.name}</span>}
                </>
              ) : botsSubView === "chat_group" && activeProject ? (
                <span className="center-header-title">Group Chat</span>
              ) : botsSubView === "chat_single" && activeAgent && activeBotMeta ? (
                <>
                  <BotAvatar
                    role={activeBotMeta.role}
                    size={26}
                    active={activeAgent.status === "working" || activeAgent.status === "debating"}
                    agentStatus={activeAgent.status}
                    seed={activeAgent.id}
                  />
                  <span className="center-header-title">{activeAgent.name}</span>
                  <JobTitlePill label={activeBotMeta.jobTitle} role={activeBotMeta.role} />
                  <span className="bots-inspected-model" title={`${activeAgent.provider}/${activeAgent.model}`}>
                    {activeAgent.model}
                  </span>
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

              <button
                type="button"
                data-testid="split-chat-toggle-btn"
                className={`btn xs ${splitChatOpen ? "active-outline" : ""}`}
                onClick={() => setSplitChatOpen((s) => !s)}
                title={narrowChat ? "Split Chat needs a wider window" : "Split Chat: Main Agent + Engineering Teams (Ctrl+Shift+S)"}
                disabled={narrowChat}
                aria-pressed={splitChatOpen}
              >
                <Columns2 size={14} strokeWidth={1.6} />
                <span>Split</span>
              </button>

              <button
                type="button"
                className={`btn xs ${browserOpen ? "active-outline" : ""}`}
                onClick={toggleBrowserSidebar}
                title="Toggle In-App Browser"
                aria-label="Browser"
                aria-pressed={browserOpen}
              >
                <BrowserPaneIcon size={14} />
                <span>Browser</span>
              </button>
            </div>
          </header>

          <main ref={worldContainerRef} className={`world-container ${splitChatOpen ? "split-active" : ""}`}>
            <div
              className={`world-pane ${
                splitChatOpen
                  ? `split-left ${focusedChatPane === "chat" ? "focused" : ""}`
                  : world === "chat"
                    ? ""
                    : "hidden"
              }`.trim()}
              style={splitChatOpen ? { width: `${splitPercent}%` } : undefined}
            >
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
                attachments={composerAttachmentsByTarget[chatTargetKey] ?? []}
                onRemoveAttachment={(id) => removeComposerAttachment(chatTargetKey, id)}
                onClearAttachments={() => clearComposerAttachments(chatTargetKey)}
                onFocusPane={() => setFocusedChatPane("chat")}
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
                  setFocusedChatPane("bots");
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

            {splitChatOpen && (
              <ResizeSplitter
                orientation="vertical"
                edge="left"
                ariaLabel="Resize split chat panes"
                onDelta={(dx) => {
                  const containerW = worldContainerRef.current?.getBoundingClientRect().width || 900;
                  setSplitPercent((prev) => clampSplitPercent(prev + (dx / Math.max(320, containerW)) * 100));
                }}
                onResizeEnd={() => writeStoredNumber(LS_SPLIT_PCT, splitPercentRef.current)}
              />
            )}

            <div
              className={`world-pane ${
                splitChatOpen
                  ? `split-right ${focusedChatPane === "bots" ? "focused" : ""}`
                  : world === "bots"
                    ? ""
                    : "hidden"
              }`.trim()}
            >
              <BotsTab
                isVisible={botsVisible}
                projects={bf.projects}
                activeProject={activeProject}
                agents={bf.agents}
                metaAgentId={metaAgent?.id ?? null}
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
                conversationKey={botsTargetKey}
                activeAgentId={activeAgent?.id ?? null}
                selfModProposals={bf.selfModProposals}
                attachments={composerAttachmentsByTarget[botsTargetKey] ?? []}
                onRemoveAttachment={(id) => removeComposerAttachment(botsTargetKey, id)}
                onClearAttachments={(sent) => clearSentAttachments(botsTargetKey, sent)}
                onFocusPane={() => setFocusedChatPane("bots")}
                compactSplit={splitChatOpen}
                onSelectSubView={handleSelectSubView}
                onSelectProject={selectBotsTeam}
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
          <BrowserWorkspaceShell dockMode={browserDockMode}>
            <InAppBrowser
              project={activeProject}
              artifacts={activeArtifacts}
              annotations={activeAnnotations}
              repoFiles={activeRepoFiles}
              gitDiff={activeGitDiff}
              activeAgentId={activeAgent?.id ?? null}
              tabs={projectBrowserTabs}
              activeTabId={activeBrowserTabId}
              expanded={browserDockMode === "fullscreen"}
              dockMode={browserDockMode}
              onChangeDockMode={(next) => {
                setBrowserDockMode(next);
                try {
                  localStorage.setItem(LS_BROWSER_DOCK, next);
                } catch {
                  // Ignore storage write errors.
                }
              }}
              onImportToChat={handleImportAttachment}
              onArtifactSaved={(filePath) => {
                if (activeProject) {
                  void bf.refreshProjectCodeContext(activeProject.id, activeAgent?.id);
                  pushToast(`Saved ${filePath}`, "success");
                }
              }}
              onSelectTab={(tabId) => {
                if (activeProject) {
                  setActiveTabIdByProject((prev) => ({ ...prev, [activeProject.id]: tabId }));
                }
              }}
              onCloseTab={closeBrowserTab}
              onOpenTab={openBrowserTab}
              onToggleExpand={() =>
                setBrowserDockMode((m) => (m === "fullscreen" ? "right" : "fullscreen"))
              }
              onCloseSidebar={() => {
                setBrowserOpen(false);
                if (browserDockMode === "fullscreen") setBrowserDockMode("right");
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
          </BrowserWorkspaceShell>
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
          setFocusedChatPane("bots");
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
          if (world === "bots") selectBotsTeam(res.project.id);
          else {
            setSelectedProjectId(res.project.id);
            setSelectedAgentId(res.projectManager?.id ?? null);
          }
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
          setFocusedChatPane("bots");
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
                          agentStatus={entry.agent.status}
                          seed={entry.agent.id}
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
