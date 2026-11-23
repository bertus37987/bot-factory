import {
  Folder,
  FolderPlus,
  Kanban,
  Layers,
  MessageSquareWarning,
  OctagonX,
  Pause,
  Plus,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactEntry } from "@bot-factory/shared";
import { BotsTab, type BotsSubView } from "./bots/BotsTab";
import { InAppBrowser, type BrowserTabItem, type BrowserTabKind } from "./browser/InAppBrowser";
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
import type { AutonomyLevel } from "./components/PrecisionComposer";
import type { ReasoningEffort } from "./components/ReasoningEffortSlider";

function artifactKindToTabKind(kind: ArtifactEntry["kind"]): BrowserTabKind {
  if (kind === "image") return "image";
  if (kind === "model_3d") return "model_3d";
  return "doc";
}

export function App() {
  const bf = useBotFactory();
  const [world, setWorld] = useState<"chat" | "bots">("chat");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [botsSubView, setBotsSubView] = useState<BotsSubView>("chat_group");

  // Composer controls (shared smoothly across worlds)
  const [effort, setEffort] = useState<ReasoningEffort>("high");
  const [autonomy, setAutonomy] = useState<AutonomyLevel>("medium");

  // In-App Browser Sidebar state (native multi-tab!)
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const [browserWidth, setBrowserWidth] = useState(520);
  const [browserTabs, setBrowserTabs] = useState<BrowserTabItem[]>([]);
  const [activeBrowserTabId, setActiveBrowserTabId] = useState<string | null>(null);

  // Command Palette (Ctrl+K)
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [safetyBusy, setSafetyBusy] = useState(false);

  const draggingBrowserRef = useRef(false);

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

  const activeArtifacts = activeProject ? bf.artifactsByProject[activeProject.id] ?? [] : [];
  const activeAnnotations = activeProject ? bf.annotationsByProject[activeProject.id] ?? [] : [];
  const activeRepoFiles = activeProject ? bf.repoFilesByProject[activeProject.id] ?? [] : [];
  const activeGitDiff = activeProject ? bf.gitDiffByProject[activeProject.id] ?? null : null;
  const activeTasks = activeProject ? bf.tasksByProject[activeProject.id] ?? [] : [];
  const activeDebates = activeProject ? bf.debatesByProject[activeProject.id] ?? [] : [];

  // Keep project previews & real repo/diff telemetry hydrated whenever active project changes
  useEffect(() => {
    if (!activeProject) return;
    const topic = `project:${activeProject.id}:previews` as const;
    bf.subscribe(topic);
    void bf.refreshProjectCodeContext(activeProject.id, activeAgent?.id);
    return () => bf.unsubscribe(topic);
  }, [activeProject?.id, activeAgent?.id, bf.subscribe, bf.unsubscribe, bf.refreshProjectCodeContext]);

  // Reset browser tabs cleanly on project switch
  useEffect(() => {
    setBrowserTabs([]);
    setActiveBrowserTabId(null);
  }, [activeProject?.id]);

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

  const openBrowserTab = useCallback((tab: Omit<BrowserTabItem, "id">) => {
    setBrowserOpen(true);
    setBrowserTabs((prev) => {
      const existing = prev.find((t) => t.kind === tab.kind && t.path === tab.path && (t.url ?? "") === (tab.url ?? ""));
      if (existing) {
        setActiveBrowserTabId(existing.id);
        return prev;
      }
      const id = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      setActiveBrowserTabId(id);
      return [...prev, { ...tab, id }];
    });
  }, []);

  const closeBrowserTab = useCallback(
    (tabId: string) => {
      setBrowserTabs((prev) => {
        const next = prev.filter((t) => t.id !== tabId);
        if (activeBrowserTabId === tabId) {
          setActiveBrowserTabId(next[next.length - 1]?.id ?? null);
        }
        if (next.length === 0) {
          setBrowserOpen(false);
        }
        return next;
      });
    },
    [activeBrowserTabId],
  );

  const openArtifactInBrowser = useCallback(
    (artifact: ArtifactEntry) => {
      openBrowserTab({
        kind: artifactKindToTabKind(artifact.kind),
        title: artifact.name,
        path: artifact.relativePath,
      });
    },
    [openBrowserTab],
  );

  const openDiffInBrowser = useCallback(() => {
    if (activeProject) {
      void bf.refreshProjectCodeContext(activeProject.id, activeAgent?.id);
    }
    openBrowserTab({
      kind: "diff",
      title: "Änderungen (Diff)",
      path: "diff://HEAD",
    });
  }, [activeProject, activeAgent?.id, bf.refreshProjectCodeContext, openBrowserTab]);

  const toggleBrowserSidebar = useCallback(() => {
    setBrowserOpen((prev) => {
      if (!prev && browserTabs.length === 0) {
        const defaultArt = activeArtifacts.find((a) => a.kind === "doc") ?? activeArtifacts[0];
        if (defaultArt) {
          const id = `tab_init_${Date.now()}`;
          setBrowserTabs([
            {
              id,
              kind: artifactKindToTabKind(defaultArt.kind),
              title: defaultArt.name,
              path: defaultArt.relativePath,
            },
          ]);
          setActiveBrowserTabId(id);
        } else if (activeRepoFiles[0]) {
          const id = `tab_init_${Date.now()}`;
          setBrowserTabs([
            { id, kind: "code", title: activeRepoFiles[0].name, path: activeRepoFiles[0].relativePath },
          ]);
          setActiveBrowserTabId(id);
        } else {
          const id = `tab_init_${Date.now()}`;
          setBrowserTabs([{ id, kind: "diff", title: "Änderungen (Diff)", path: "diff://HEAD" }]);
          setActiveBrowserTabId(id);
        }
      }
      return !prev;
    });
  }, [browserTabs.length, activeArtifacts, activeRepoFiles]);

  const filteredPaletteAgents = bf.agents.filter(
    (a) =>
      a.scope !== "global" &&
      (a.name.toLowerCase().includes(paletteQuery.toLowerCase()) ||
        a.model.toLowerCase().includes(paletteQuery.toLowerCase())),
  );

  const unreadBots = bf.agents.filter(
    (a) => a.scope !== "global" && (a.status === "working" || a.status === "waiting_review" || a.status === "debating" || a.status === "requires_action"),
  );

  const brandActivity = !bf.connected
    ? "connecting"
    : bf.quietStatus.runningBots > 0
      ? "working"
      : "idle";

  const activeBotMeta = activeAgent ? resolveBotRole(activeAgent) : null;

  return (
    <div className="app-shell-v3">
      {/* Far-Left 44px Custom Icon Rail (ui-01 grammar: 2 bespoke Bot-Factory mode icons, ZERO slider) */}
      <nav className="icon-rail" aria-label="Hauptnavigation">
        <div className="icon-rail-top">
          <button
            type="button"
            className={`rail-mode-btn ${world === "chat" ? "active" : ""}`}
            onClick={() => setWorld("chat")}
            title="Agent Chat (Ctrl+E)"
            aria-label="Agent Chat"
          >
            <AgentChatApertureIcon size={18} />
          </button>

          <button
            type="button"
            className={`rail-mode-btn ${world === "bots" ? "active" : ""}`}
            onClick={() => setWorld("bots")}
            title="Bot-Teams & Steuerung (Ctrl+E)"
            aria-label="Bot-Teams"
          >
            <BotsLatticeIcon size={18} />
            {bf.quietStatus.runningBots > 0 && <span className="rail-badge">{bf.quietStatus.runningBots}</span>}
          </button>

          <div className="rail-divider" />

          <button
            type="button"
            className={`rail-util-btn ${drawerOpen ? "active" : ""}`}
            onClick={() => setDrawerOpen((o) => !o)}
            title="Seitenleiste ein-/ausblenden (Ctrl+B)"
            aria-label="Seitenleiste umschalten"
          >
            <SidebarToggleIcon size={16} />
          </button>

          <button
            type="button"
            className="rail-util-btn"
            onClick={() => {
              setPaletteOpen(true);
              setPaletteQuery("");
            }}
            title="Schnellsuche (Ctrl+K)"
            aria-label="Schnellsuche"
          >
            <Search size={15} strokeWidth={1.6} />
          </button>
        </div>

        <div className="icon-rail-bottom">
          <BotThinkingOrb
            activity={brandActivity}
            size={20}
            label={
              !bf.connected
                ? "Verbinde mit Daemon…"
                : bf.quietStatus.runningBots > 0
                  ? `${bf.quietStatus.runningBots} Bots aktiv`
                  : "Bot-Factory verbunden (127.0.0.1)"
            }
          />
        </div>
      </nav>

      {/* Secondary 252px Collapsible Drawer */}
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
                  onClick={async () => {
                    const res = await bf.sendCommand<{ project: { id: string } }>({
                      type: "project.create",
                      name: `Projekt-${bf.projects.length + 1}`,
                      seedDemoArtifacts: true,
                    });
                    setSelectedProjectId(res.project.id);
                  }}
                >
                  <FolderPlus size={14} strokeWidth={1.6} />
                  <span>Neues Projekt anlegen</span>
                </button>

                <div className="drawer-section">
                  <div className="section-eyebrow">
                    <span>Projekte</span>
                    <span className="mono-tag">{bf.projects.length}</span>
                  </div>
                  {bf.projects.length === 0 && (
                    <div className="drawer-empty-hint">Noch keine Projekte vorhanden.</div>
                  )}
                  {bf.projects.map((p) => {
                    const isActive = activeProject?.id === p.id;
                    const teamCount = bf.agents.filter((a) => a.projectId === p.id).length;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className={`drawer-item ${isActive ? "active" : ""}`}
                        onClick={() => setSelectedProjectId(p.id)}
                      >
                        <Folder size={14} strokeWidth={1.6} color="var(--ink-muted)" />
                        <span className="drawer-item-label">{p.name}</span>
                        <span className="mono-tag">{teamCount} Bots</span>
                      </button>
                    );
                  })}
                </div>

                {activeProject && (
                  <div className="drawer-section">
                    <div className="section-eyebrow">
                      <span>Browser-Dateien</span>
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
                    {activeRepoFiles.slice(0, 5).map((rf) => (
                      <button
                        key={rf.relativePath}
                        type="button"
                        className="drawer-item"
                        onClick={() =>
                          openBrowserTab({ kind: "code", title: rf.name, path: rf.relativePath })
                        }
                      >
                        <CodeTabIcon size={14} />
                        <span className="drawer-item-label">{rf.relativePath}</span>
                      </button>
                    ))}
                    <button type="button" className="drawer-item" onClick={openDiffInBrowser}>
                      <DiffBranchIcon size={14} />
                      <span className="drawer-item-label">Git Diff ({activeGitDiff?.filesChanged ?? 0})</span>
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="drawer-header">
                <span className="drawer-title">Bot-Teams</span>
                <button
                  type="button"
                  className="btn xs"
                  onClick={async () => {
                    const res = await bf.sendCommand<{ project: { id: string }; projectManager: { id: string } }>({
                      type: "project.create",
                      name: `Projekt-${bf.projects.length + 1}`,
                      seedDemoArtifacts: true,
                    });
                    setSelectedProjectId(res.project.id);
                    setSelectedAgentId(res.projectManager.id);
                    setBotsSubView("chat_group");
                  }}
                >
                  <Plus size={12} strokeWidth={1.6} />
                  <span>Projekt</span>
                </button>
              </div>

              <div className="drawer-scroll">
                {unreadBots.length > 0 && (
                  <div className="drawer-section">
                    <div className="section-eyebrow">
                      <span>Aktiv / Review</span>
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
                            badgeCount={bot.status === "waiting_review" || bot.status === "requires_action" ? 1 : undefined}
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
                    Noch kein Projekt-Team. Klicke oben auf <b>+ Projekt</b>.
                  </div>
                )}

                {bf.projects.map((p) => {
                  const team = bf.agents.filter((a) => a.projectId === p.id);
                  const isCurrentProj = activeProject?.id === p.id;
                  const clusterRoles = team.slice(0, 4).map((b) => resolveBotRole(b).role);
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
                          title="Neuen Peer-Bot im Worktree starten"
                          onClick={async () => {
                            const count = team.filter((a) => a.scope === "peer").length + 1;
                            const names = ["Forge", "Carver-3D", "Scout-Research", "Builder"];
                            const label = `${names[(count - 1) % names.length]}-${count}`;
                            const res = await bf.sendCommand<{ agent: { id: string } }>({
                              type: "bot.spawn",
                              projectId: p.id,
                              name: label,
                              scope: "peer",
                            });
                            setSelectedProjectId(p.id);
                            setSelectedAgentId(res.agent.id);
                            setBotsSubView("chat_single");
                          }}
                        >
                          <Plus size={12} strokeWidth={1.6} />
                          <span>Bot</span>
                        </button>
                      </div>

                      {/* Multi-Bot Group Room entry (2x2 Low-Poly Beaver Cluster) */}
                      <button
                        type="button"
                        className={`bot-roster-row ${isCurrentProj && botsSubView === "chat_group" ? "active" : ""}`}
                        onClick={() => {
                          setSelectedProjectId(p.id);
                          setBotsSubView("chat_group");
                        }}
                      >
                        <GroupAvatarCluster roles={clusterRoles.length > 0 ? clusterRoles : ["team_lead", "builder"]} size={32} />
                        <div className="bot-roster-copy">
                          <div className="bot-roster-top">
                            <span className="bot-roster-name">{p.name}</span>
                            <JobTitlePill label="Gruppenchat" tone="accent" />
                          </div>
                          <div className="bot-roster-sub">{team.length} Bots im Team-Kanal</div>
                        </div>
                      </button>

                      {/* Individual Bots with Low-Poly Orange Beaver Portraits + Job Title */}
                      {team.map((bot) => {
                        const meta = resolveBotRole(bot);
                        const isSel = isCurrentProj && activeAgent?.id === bot.id && botsSubView === "chat_single";
                        return (
                          <button
                            key={bot.id}
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
                              badgeCount={bot.status === "waiting_review" || bot.status === "requires_action" ? 1 : undefined}
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
                        );
                      })}
                    </div>
                  );
                })}

                {/* Clean Sidebar Control Views (Answer 3: Task-Board, Debates & Verifier, Self-Mod in Left Sidebar) */}
                <div className="drawer-section drawer-tools-section">
                  <div className="section-eyebrow">
                    <span>Werkzeuge</span>
                  </div>
                  <button
                    type="button"
                    className={`drawer-item ${botsSubView === "board" ? "active" : ""}`}
                    onClick={() => setBotsSubView("board")}
                  >
                    <Kanban size={14} strokeWidth={1.6} />
                    <span className="drawer-item-label">Task-Board</span>
                    <span className="mono-tag">{activeTasks.length}</span>
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
          {/* Minimal 44px Context Header */}
          <header className="center-header">
            <div className="center-header-left">
              {world === "chat" ? (
                <>
                  <BotAvatar role="orchestrator" size={24} active={bf.quietStatus.runningBots > 0} />
                  <span className="center-header-title">Meta-Orchestrator</span>
                  <JobTitlePill label="Ruhiger Modus" />
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
                  {activeAgent.worktreeBranch && <span className="mono-tag">{activeAgent.worktreeBranch}</span>}
                </>
              ) : (
                <span className="center-header-title">
                  {botsSubView === "board"
                    ? `Task-Board · ${activeProject?.name ?? ""}`
                    : botsSubView === "debates"
                      ? `Debates & Verifier · ${activeProject?.name ?? ""}`
                      : "Self-Mod Sandbox"}
                </span>
              )}
            </div>

            <div className="center-header-right">
              {/* Physically separated Pause & Hard-Stop Safety Controls in Bots Mode */}
              {world === "bots" && activeAgent && (botsSubView === "chat_single" || botsSubView === "chat_group") && (
                <div className="safety-controls">
                  <button
                    type="button"
                    className="btn xs"
                    disabled={safetyBusy || activeAgent.status === "paused" || activeAgent.status === "stopped"}
                    onClick={async () => {
                      setSafetyBusy(true);
                      try {
                        await bf.sendCommand({ type: "bot.pause", agentId: activeAgent.id });
                      } finally {
                        setSafetyBusy(false);
                      }
                    }}
                    title="Aktiven Bot sanft pausieren"
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
                      } finally {
                        setSafetyBusy(false);
                      }
                    }}
                    title="Harter Prozess-Stopp"
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
                title="In-App Browser umschalten"
              >
                <BrowserPaneIcon size={14} />
                <span>Browser</span>
              </button>
            </div>
          </header>

          {/* Both worlds remain mounted for instant <100ms switching */}
          <main className="world-container">
            <div className={`world-pane ${world === "chat" ? "" : "hidden"}`}>
              <ChatTab
                messages={bf.chatMessages}
                cards={bf.chatCards}
                projects={bf.projects}
                activeProject={activeProject}
                quietStatus={bf.quietStatus}
                activeModelLabel={metaAgent?.model ?? "mistral-large-4"}
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
                onCreateDemoProject={async (name) => {
                  const res = await bf.sendCommand<{ project: { id: string } }>({
                    type: "project.create",
                    name,
                    seedDemoArtifacts: true,
                  });
                  setSelectedProjectId(res.project.id);
                }}
                onOpenProjectPreview={(projectId, artifactPath) => {
                  setSelectedProjectId(projectId);
                  const path = artifactPath ?? "plans/roadmap.md";
                  const kind: BrowserTabKind = path.endsWith(".glb") || path.endsWith(".gltf")
                    ? "model_3d"
                    : /\.(png|jpg|jpeg|svg|webp)$/i.test(path)
                      ? "image"
                      : "doc";
                  openBrowserTab({
                    kind,
                    title: path.split("/").pop() ?? path,
                    path,
                  });
                }}
                onOpenDiffInBrowser={openDiffInBrowser}
                onOpenBrowser={toggleBrowserSidebar}
                onSwitchToBots={() => setWorld("bots")}
              />
            </div>

            <div className={`world-pane ${world === "bots" ? "" : "hidden"}`}>
              <BotsTab
                projects={bf.projects}
                agents={bf.agents}
                activeProject={activeProject}
                activeAgent={activeAgent}
                activeSubView={botsSubView}
                tasksByProject={bf.tasksByProject}
                artifactsByProject={bf.artifactsByProject}
                timelinesByAgent={bf.timelinesByAgent}
                debatesByProject={bf.debatesByProject}
                debateMessagesByDebate={bf.debateMessagesByDebate}
                verificationsByProject={bf.verificationsByProject}
                selfModProposals={bf.selfModProposals}
                gitDiff={activeGitDiff}
                effort={effort}
                autonomy={autonomy}
                onChangeEffort={setEffort}
                onChangeAutonomy={setAutonomy}
                onSelectProject={setSelectedProjectId}
                onChangeSubView={setBotsSubView}
                onSubscribe={bf.subscribe}
                onUnsubscribe={bf.unsubscribe}
                onCreateProject={async (name) => {
                  const res = await bf.sendCommand<{ project: { id: string }; projectManager: { id: string } }>({
                    type: "project.create",
                    name,
                    seedDemoArtifacts: true,
                  });
                  setSelectedProjectId(res.project.id);
                  setSelectedAgentId(res.projectManager.id);
                  setBotsSubView("chat_group");
                }}
                onSpawnBot={async (projectId) => {
                  const count = bf.agents.filter((a) => a.projectId === projectId && a.scope === "peer").length + 1;
                  const res = await bf.sendCommand<{ agent: { id: string } }>({
                    type: "bot.spawn",
                    projectId,
                    name: `Forge-${count}`,
                    scope: "peer",
                  });
                  setSelectedProjectId(projectId);
                  setSelectedAgentId(res.agent.id);
                }}
                onSubmitSteer={async (projectId, message) => {
                  await bf.sendCommand({
                    type: "steer.submit",
                    projectId,
                    message,
                    reasoningEffort: effort,
                    autonomyLevel: autonomy,
                  });
                }}
                onCreateTask={async (projectId, title) => {
                  await bf.sendCommand({ type: "task.create", projectId, title, specMd: title, priority: 2 });
                }}
                onDispatchTask={async (projectId, taskId) => {
                  await bf.sendCommand({ type: "task.dispatch", projectId, taskId });
                }}
                onVerifyTask={async (projectId, taskId) => {
                  await bf.sendCommand({ type: "task.verify", projectId, taskId });
                }}
                onOpenArtifactInBrowser={openArtifactInBrowser}
                onOpenDiffInBrowser={openDiffInBrowser}
                onOpenBrowser={toggleBrowserSidebar}
                onOpenDebate={async (params) => {
                  await bf.sendCommand({ type: "debate.open", ...params });
                }}
                onPostDebate={async (params) => {
                  await bf.sendCommand({ type: "debate.post", ...params });
                }}
                onResolveDebate={async (params) => {
                  await bf.sendCommand({ type: "debate.resolve", ...params });
                }}
                onProposeSelfMod={async (params) => {
                  await bf.sendCommand({ type: "selfmod.propose", ...params });
                }}
                onVerifySelfMod={async (proposalId) => {
                  await bf.sendCommand({ type: "selfmod.verify", proposalId });
                }}
                onPromoteSelfMod={async (proposalId) => {
                  await bf.sendCommand({ type: "selfmod.promote", proposalId });
                }}
                onRollbackSelfMod={async (proposalId) => {
                  await bf.sendCommand({ type: "selfmod.rollback", proposalId });
                }}
              />
            </div>
          </main>
        </section>

        {/* Drag Resize Handle + Native 2-Row Tabbed In-App Browser Sidebar */}
        {browserOpen && (
          <>
            {!browserExpanded && (
              <div
                className="browser-resize-gutter"
                onMouseDown={() => {
                  draggingBrowserRef.current = true;
                  document.body.style.cursor = "col-resize";
                }}
                title="Breite ziehen"
              />
            )}
            <aside
              className={`browser-sidebar-pane ${browserExpanded ? "expanded" : ""}`}
              style={browserExpanded ? undefined : { width: browserWidth }}
            >
              <InAppBrowser
                projectId={activeProject?.id ?? null}
                activeAgentId={activeAgent?.id ?? null}
                tabs={browserTabs}
                activeTabId={activeBrowserTabId}
                artifacts={activeArtifacts}
                annotations={activeAnnotations}
                repoFiles={activeRepoFiles}
                gitDiff={activeGitDiff}
                expanded={browserExpanded}
                onSelectTab={setActiveBrowserTabId}
                onCloseTab={closeBrowserTab}
                onOpenTab={openBrowserTab}
                onToggleExpand={() => setBrowserExpanded((e) => !e)}
                onCloseBrowser={() => {
                  setBrowserOpen(false);
                  setBrowserExpanded(false);
                }}
                onRefreshDiff={() => {
                  if (activeProject) void bf.refreshProjectCodeContext(activeProject.id, activeAgent?.id);
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

      {/* Ctrl+K Command Palette */}
      {paletteOpen && (
        <div className="modal-backdrop" onClick={() => setPaletteOpen(false)}>
          <div className="palette-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Schnellwechsel">
            <div className="palette-search-row">
              <Search size={14} strokeWidth={1.6} color="var(--ink-muted)" />
              <input
                autoFocus
                className="composer-input"
                placeholder="Zu Bot, Projekt oder Browser-Datei springen…"
                value={paletteQuery}
                onChange={(e) => setPaletteQuery(e.target.value)}
              />
              <span className="kbd-chip">Esc</span>
            </div>
            <div className="palette-list">
              {filteredPaletteAgents.length === 0 && (
                <div style={{ padding: "12px 10px", color: "var(--ink-muted)", fontSize: "var(--text-xs)" }}>
                  Keine passenden Bots gefunden.
                </div>
              )}
              {filteredPaletteAgents.map((a) => {
                const meta = resolveBotRole(a);
                return (
                  <button
                    type="button"
                    key={a.id}
                    className="palette-item"
                    onClick={() => {
                      if (a.projectId) setSelectedProjectId(a.projectId);
                      setSelectedAgentId(a.id);
                      setBotsSubView("chat_single");
                      setWorld("bots");
                      setPaletteOpen(false);
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                      <BotAvatar role={meta.role} size={24} active={a.status === "working"} />
                      <span style={{ fontWeight: 500 }}>{a.name}</span>
                      <JobTitlePill label={meta.jobTitle} />
                    </span>
                    <span className="mono-tag">{a.model}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
