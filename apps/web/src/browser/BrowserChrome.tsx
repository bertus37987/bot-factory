import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Box,
  ChevronRight,
  FileCode2,
  FileText,
  GitCompareArrows,
  Globe,
  Image as ImageIcon,
  Lock,
  Maximize2,
  Minimize2,
  PanelBottom,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { ArtifactEntry, GitDiffResponse, ProjectRecord, RepoFileEntry } from "@bot-factory/shared";
import {
  breadcrumbSegments,
  formatBytes,
  validateLoopbackWebUrl,
  type BrowserDockMode,
  type BrowserTab,
  type BrowserTabKind,
  type ImageZoomMode,
  type Model3DPreset,
} from "./types";

export interface BrowserChromeProps {
  project: ProjectRecord | null;
  tabs: BrowserTab[];
  activeTab: BrowserTab | null;
  activeTabId: string | null;
  artifacts: ArtifactEntry[];
  repoFiles: RepoFileEntry[];
  gitDiff: GitDiffResponse | null;
  dockMode: BrowserDockMode;
  canBack: boolean;
  canForward: boolean;
  imageZoom: ImageZoomMode;
  model3dPreset: Model3DPreset | "";
  model3dWireframe: boolean;
  omniboxFeedback: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onOpenTab: (tab: Omit<BrowserTab, "id">) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onChangeDockMode: (mode: BrowserDockMode) => void;
  onStartFloatDrag?: (e: ReactPointerEvent<HTMLElement>) => void;
  onCloseSidebar: () => void;
  onChangeImageZoom: (zoom: ImageZoomMode) => void;
  onSelectModel3DPreset: (preset: Model3DPreset) => void;
  onToggleModel3DWireframe: () => void;
  onClearOmniboxFeedback: () => void;
  onSetOmniboxFeedback: (msg: string | null) => void;
}

function TabKindIcon({ kind, size = 13 }: { kind: BrowserTabKind; size?: number }) {
  const sw = 1.6;
  const color = "var(--ink-secondary)";
  switch (kind) {
    case "doc":
      return <FileText size={size} strokeWidth={sw} color={color} />;
    case "image":
      return <ImageIcon size={size} strokeWidth={sw} color={color} />;
    case "model_3d":
      return <Box size={size} strokeWidth={sw} color={color} />;
    case "code":
      return <FileCode2 size={size} strokeWidth={sw} color={color} />;
    case "diff":
      return <GitCompareArrows size={size} strokeWidth={sw} color={color} />;
    case "web":
      return <Globe size={size} strokeWidth={sw} color={color} />;
  }
}

function QuickGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="iab-quickgroup" style={{ marginBottom: 6 }}>
      <div
        style={{
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-wide)",
          textTransform: "uppercase",
          color: "var(--ink-faint)",
          padding: "5px 8px 3px",
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function QuickItem({
  icon,
  primary,
  secondary,
  onClick,
}: {
  icon: ReactNode;
  primary: string;
  secondary?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="iab-quickitem drawer-item"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        textAlign: "left",
        padding: "5px 8px",
        borderRadius: "var(--studio-row-radius)",
      }}
    >
      <span style={{ flexShrink: 0, display: "inline-flex" }}>{icon}</span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span
          style={{
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: "var(--text-xs)",
            color: "var(--ink-primary)",
          }}
        >
          {primary}
        </span>
        {secondary && (
          <span
            style={{
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--ink-muted)",
              fontSize: "var(--text-2xs)",
            }}
          >
            {secondary}
          </span>
        )}
      </span>
    </button>
  );
}

function QuickEmpty({ text }: { text: string }) {
  return <div style={{ padding: "4px 8px", color: "var(--ink-faint)", fontSize: "var(--text-2xs)" }}>{text}</div>;
}

function artifactToTabKind(kind: ArtifactEntry["kind"]): BrowserTabKind {
  if (kind === "image") return "image";
  if (kind === "model_3d") return "model_3d";
  return "doc";
}

export function BrowserChrome({
  project,
  tabs,
  activeTab,
  activeTabId,
  artifacts,
  repoFiles,
  gitDiff,
  dockMode,
  canBack,
  canForward,
  imageZoom,
  model3dPreset,
  model3dWireframe,
  omniboxFeedback,
  onSelectTab,
  onCloseTab,
  onOpenTab,
  onBack,
  onForward,
  onReload,
  onChangeDockMode,
  onStartFloatDrag,
  onCloseSidebar,
  onChangeImageZoom,
  onSelectModel3DPreset,
  onToggleModel3DWireframe,
  onClearOmniboxFeedback,
  onSetOmniboxFeedback,
}: BrowserChromeProps): JSX.Element {
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [webUrlDraft, setWebUrlDraft] = useState("");
  const [webUrlError, setWebUrlError] = useState<string | null>(null);
  const [omniboxEditing, setOmniboxEditing] = useState(false);
  const [omniboxDraft, setOmniboxDraft] = useState("");

  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const quickSearchRef = useRef<HTMLInputElement | null>(null);
  const omniboxInputRef = useRef<HTMLInputElement | null>(null);
  const tabButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const projectId = project?.id ?? "";

  useEffect(() => {
    if (!quickOpenVisible) return;
    const focusTimer = setTimeout(() => quickSearchRef.current?.focus(), 0);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setQuickOpenVisible(false);
        setWebUrlError(null);
        addBtnRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [quickOpenVisible]);

  useEffect(() => {
    setOmniboxEditing(false);
  }, [activeTabId]);

  useEffect(() => {
    if (omniboxEditing) {
      omniboxInputRef.current?.focus();
      omniboxInputRef.current?.select();
    }
  }, [omniboxEditing]);

  const docArtifacts = useMemo(
    () => artifacts.filter((a) => a.kind === "doc" || a.kind === "handoff"),
    [artifacts],
  );
  const visualArtifacts = useMemo(
    () => artifacts.filter((a) => a.kind === "image" || a.kind === "model_3d"),
    [artifacts],
  );
  const filteredFiles = useMemo(() => {
    const q = fileQuery.trim().toLowerCase();
    if (!q) return repoFiles.slice(0, 60);
    return repoFiles.filter((f) => f.relativePath.toLowerCase().includes(q)).slice(0, 60);
  }, [repoFiles, fileQuery]);

  const openQuickItem = (tab: Omit<BrowserTab, "id">) => {
    onOpenTab(tab);
    setQuickOpenVisible(false);
    setWebUrlError(null);
    onClearOmniboxFeedback();
  };

  const openWebDraft = (raw: string) => {
    const res = validateLoopbackWebUrl(raw);
    if (!res.allowed) {
      setWebUrlError(res.message);
      return;
    }
    setWebUrlError(null);
    setWebUrlDraft("");
    openQuickItem({
      kind: "web",
      target: res.normalizedUrl,
      label: res.normalizedUrl.replace(/^https?:\/\//i, ""),
      projectId,
    });
  };

  const enterOmniboxEdit = (initial?: string) => {
    onClearOmniboxFeedback();
    setOmniboxDraft(initial ?? activeTab?.target ?? "");
    setOmniboxEditing(true);
  };

  const commitOmnibox = () => {
    const raw = omniboxDraft.trim();
    setOmniboxEditing(false);
    if (!raw) return;

    // 1. Diff shorthand
    if (raw === "diff" || raw.toLowerCase() === "diff://head") {
      onClearOmniboxFeedback();
      onOpenTab({ kind: "diff", target: "diff://HEAD", label: "Git Diff", projectId });
      return;
    }

    // 2. Explicit or loopback URL
    const looksLikeUrl =
      /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ||
      /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/.*)?$/i.test(raw);
    if (looksLikeUrl) {
      const res = validateLoopbackWebUrl(raw);
      if (!res.allowed) {
        onSetOmniboxFeedback(res.message);
        return;
      }
      onClearOmniboxFeedback();
      onOpenTab({
        kind: "web",
        target: res.normalizedUrl,
        label: res.normalizedUrl.replace(/^https?:\/\//i, ""),
        projectId,
      });
      return;
    }

    // 3. Repo or artifact path matching
    if (!project) {
      onSetOmniboxFeedback("Select or create a project before opening workspace files.");
      return;
    }

    const cleanPath = raw.replace(/^\.\//, "").replace(/\\/g, "/");
    const lower = cleanPath.toLowerCase();

    const exactArt = artifacts.find(
      (a) => a.relativePath.toLowerCase() === lower || a.name.toLowerCase() === lower,
    );
    if (exactArt) {
      onClearOmniboxFeedback();
      onOpenTab({
        kind: artifactToTabKind(exactArt.kind),
        target: exactArt.relativePath,
        label: exactArt.name,
        projectId: project.id,
      });
      return;
    }

    const exactRepo = repoFiles.find((f) => f.relativePath.toLowerCase() === lower);
    if (exactRepo) {
      onClearOmniboxFeedback();
      onOpenTab({
        kind: "code",
        target: exactRepo.relativePath,
        label: exactRepo.name,
        projectId: project.id,
      });
      return;
    }

    const matchingArtifacts = artifacts.filter(
      (a) => a.relativePath.toLowerCase().endsWith(`/${lower}`) || a.relativePath.toLowerCase().includes(lower),
    );
    const matchingRepo = repoFiles.filter(
      (f) => f.relativePath.toLowerCase().endsWith(`/${lower}`) || f.relativePath.toLowerCase().includes(lower),
    );
    const totalMatches = matchingArtifacts.length + matchingRepo.length;

    if (totalMatches === 1) {
      onClearOmniboxFeedback();
      if (matchingArtifacts[0]) {
        const a = matchingArtifacts[0];
        onOpenTab({
          kind: artifactToTabKind(a.kind),
          target: a.relativePath,
          label: a.name,
          projectId: project.id,
        });
      } else if (matchingRepo[0]) {
        const f = matchingRepo[0];
        onOpenTab({
          kind: "code",
          target: f.relativePath,
          label: f.name,
          projectId: project.id,
        });
      }
      return;
    }

    if (totalMatches > 1) {
      setFileQuery(cleanPath);
      setQuickOpenVisible(true);
      onSetOmniboxFeedback(`Multiple matches for "${cleanPath}" — select a file from Quick Open.`);
      return;
    }

    onSetOmniboxFeedback(`No matching artifact or repository file found for "${cleanPath}".`);
  };

  const handleTabKeyDown = (e: React.KeyboardEvent, idx: number, tabId: string) => {
    if (tabs.length === 0) return;
    let nextIdx: number | null = null;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = tabs.length - 1;
    else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onCloseTab(tabId);
      return;
    }

    if (nextIdx !== null) {
      e.preventDefault();
      const targetTab = tabs[nextIdx];
      if (targetTab) {
        onSelectTab(targetTab.id);
        tabButtonRefs.current.get(targetTab.id)?.focus();
      }
    }
  };

  const segments = activeTab ? breadcrumbSegments(activeTab) : [];

  const iconBtnStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 26,
    height: 24,
    border: "1px solid transparent",
    background: "transparent",
    borderRadius: "var(--radius-sm)",
    cursor: "pointer",
    color: "var(--ink-secondary)",
    flexShrink: 0,
  };

  const dockBtnStyle = (active: boolean): React.CSSProperties => ({
    ...iconBtnStyle,
    background: active ? "var(--bg-active)" : "transparent",
    borderColor: active ? "var(--border-strong)" : "transparent",
    color: active ? "var(--ink-primary)" : "var(--ink-muted)",
  });

  const handleTabbarPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dockMode !== "float" || !onStartFloatDrag) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, textarea, select, a, [role="tab"], [data-no-drag="true"]')) {
      return;
    }
    onStartFloatDrag(e);
  };

  return (
    <>
      {/* ============================ ROW 1: TAB BAR ============================ */}
      <div
        className="iab-tabbar browser-chrome-tabs"
        onPointerDown={handleTabbarPointerDown}
        style={{
          height: 36,
          flexShrink: 0,
          display: "flex",
          alignItems: "flex-end",
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border-hairline)",
          paddingLeft: 6,
          paddingRight: 4,
          gap: 4,
          cursor: dockMode === "float" ? "grab" : undefined,
        }}
      >
        <div
          className="iab-tabstrip browser-tablist"
          role="tablist"
          aria-label="Browser tabs"
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 2,
            flex: 1,
            minWidth: 0,
            overflowX: "auto",
            scrollbarWidth: "none",
          }}
        >
          {tabs.map((tab, idx) => {
            const active = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className={`iab-tab browser-tab ${active ? "active" : ""}`}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onCloseTab(tab.id);
                  }
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  height: 30,
                  maxWidth: 196,
                  minWidth: 0,
                  background: active ? "var(--studio-selected)" : "transparent",
                  border: active ? "1px solid var(--border-hairline)" : "1px solid transparent",
                  borderRadius: "var(--studio-row-radius)",
                  flexShrink: 0,
                  paddingRight: 4,
                }}
              >
                <button
                  ref={(el) => {
                    if (el) tabButtonRefs.current.set(tab.id, el);
                    else tabButtonRefs.current.delete(tab.id);
                  }}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  title={tab.target}
                  className="iab-tab-trigger browser-tab-btn"
                  onClick={() => onSelectTab(tab.id)}
                  onKeyDown={(e) => handleTabKeyDown(e, idx, tab.id)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    height: "100%",
                    padding: "0 4px 0 10px",
                    minWidth: 0,
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    fontSize: "var(--text-xs)",
                    fontWeight: active ? "var(--weight-medium)" : "var(--weight-regular)",
                    color: active ? "var(--ink-primary)" : "var(--ink-secondary)",
                  }}
                >
                  <TabKindIcon kind={tab.kind} />
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 132,
                    }}
                  >
                    {tab.label}
                  </span>
                </button>
                <button
                  type="button"
                  className="iab-tab-close browser-tab-close"
                  aria-label={`Close ${tab.label}`}
                  title={`Close ${tab.label}`}
                  onClick={() => onCloseTab(tab.id)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 18,
                    height: 18,
                    border: "none",
                    borderRadius: 4,
                    cursor: "pointer",
                    padding: 0,
                    flexShrink: 0,
                  }}
                >
                  <X size={11} strokeWidth={1.8} />
                </button>
              </div>
            );
          })}

          <button
            ref={addBtnRef}
            type="button"
            className="iab-add-tab"
            aria-label="Open new browser tab"
            aria-expanded={quickOpenVisible}
            aria-haspopup="dialog"
            title="Open doc, image, 3D model, code, diff, or local URL"
            onClick={() => {
              setQuickOpenVisible((v) => !v);
              setFileQuery("");
              setWebUrlError(null);
            }}
            style={{
              ...iconBtnStyle,
              width: 26,
              height: 26,
              marginBottom: 2,
              marginLeft: 2,
              border: quickOpenVisible ? "1px solid var(--border-strong)" : "1px solid transparent",
              background: quickOpenVisible ? "var(--bg-active)" : "transparent",
            }}
          >
            <Plus size={14} strokeWidth={1.6} />
          </button>
        </div>

        {/* Right Chrome Actions: 4-Mode Dock Switcher + Close */}
        <div
          className="iab-dock-switcher"
          role="group"
          aria-label="Browser layout mode"
          style={{ display: "flex", alignItems: "center", gap: 2, paddingBottom: 5, flexShrink: 0 }}
        >
          <button
            type="button"
            className={`iab-chrome-btn iab-dock-right ${dockMode === "right" ? "active" : ""}`}
            aria-label="Dock Right"
            aria-pressed={dockMode === "right"}
            title="Dock Right"
            data-dock-btn="right"
            onClick={() => onChangeDockMode("right")}
            style={dockBtnStyle(dockMode === "right")}
          >
            <PanelRight size={13} strokeWidth={1.6} />
          </button>

          <button
            type="button"
            className={`iab-chrome-btn iab-dock-bottom ${dockMode === "bottom" ? "active" : ""}`}
            aria-label="Dock Bottom"
            aria-pressed={dockMode === "bottom"}
            title="Dock Bottom"
            data-dock-btn="bottom"
            onClick={() => onChangeDockMode("bottom")}
            style={dockBtnStyle(dockMode === "bottom")}
          >
            <PanelBottom size={13} strokeWidth={1.6} />
          </button>

          <button
            type="button"
            className={`iab-chrome-btn iab-dock-float ${dockMode === "float" ? "active" : ""}`}
            aria-label="Float"
            aria-pressed={dockMode === "float"}
            title="Float Window"
            data-dock-btn="float"
            onClick={() => onChangeDockMode("float")}
            style={dockBtnStyle(dockMode === "float")}
          >
            <AppWindow size={13} strokeWidth={1.6} />
          </button>

          <button
            type="button"
            className={`iab-chrome-btn iab-expand ${dockMode === "fullscreen" ? "active" : ""}`}
            aria-label={dockMode === "fullscreen" ? "Restore browser size" : "Fullscreen"}
            aria-pressed={dockMode === "fullscreen"}
            title={dockMode === "fullscreen" ? "Restore" : "Fullscreen"}
            data-dock-btn="fullscreen"
            onClick={() => onChangeDockMode(dockMode === "fullscreen" ? "right" : "fullscreen")}
            style={dockBtnStyle(dockMode === "fullscreen")}
          >
            {dockMode === "fullscreen" ? (
              <Minimize2 size={13} strokeWidth={1.6} />
            ) : (
              <Maximize2 size={13} strokeWidth={1.6} />
            )}
          </button>

          <button
            type="button"
            className="iab-chrome-btn iab-close"
            aria-label="Close browser"
            title="Close browser"
            onClick={onCloseSidebar}
            style={iconBtnStyle}
          >
            <X size={14} strokeWidth={1.6} />
          </button>
        </div>
      </div>

      {/* ========================= ROW 2: ADDRESS BAR =========================== */}
      <div
        className="iab-addressbar browser-chrome-nav"
        style={{
          height: 34,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 4,
          background: "var(--bg-canvas)",
          borderBottom: "1px solid var(--border-subtle)",
          padding: "0 8px",
        }}
      >
        <button
          type="button"
          className="iab-nav-btn"
          aria-label="Back"
          title="Back"
          disabled={!canBack}
          onClick={onBack}
          style={{ ...iconBtnStyle, opacity: canBack ? 1 : 0.35, cursor: canBack ? "pointer" : "not-allowed" }}
        >
          <ArrowLeft size={14} strokeWidth={1.6} />
        </button>

        <button
          type="button"
          className="iab-nav-btn"
          aria-label="Forward"
          title="Forward"
          disabled={!canForward}
          onClick={onForward}
          style={{ ...iconBtnStyle, opacity: canForward ? 1 : 0.35, cursor: canForward ? "pointer" : "not-allowed" }}
        >
          <ArrowRight size={14} strokeWidth={1.6} />
        </button>

        <button
          type="button"
          className="iab-nav-btn"
          aria-label="Reload"
          title="Reload current view"
          onClick={onReload}
          style={iconBtnStyle}
        >
          <RefreshCw size={13} strokeWidth={1.6} />
        </button>

        {/* Interactive breadcrumb / URL omnibox */}
        <div
          className="iab-omnibox browser-omnibox"
          onClick={() => {
            if (!omniboxEditing) enterOmniboxEdit();
          }}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            height: 24,
            marginLeft: 4,
            padding: "0 10px",
            borderRadius: "var(--radius-pill)",
            border: omniboxEditing
              ? "1px solid var(--border-strong)"
              : omniboxFeedback
                ? "1px solid var(--status-warning-border)"
                : "1px solid var(--border-subtle)",
            background: omniboxEditing ? "var(--bg-canvas)" : "var(--studio-panel)",
            cursor: omniboxEditing ? "text" : "pointer",
            overflow: "hidden",
          }}
        >
          {activeTab?.kind === "web" ? (
            <Lock size={11} strokeWidth={1.6} color="var(--ink-faint)" style={{ marginRight: 6, flexShrink: 0 }} />
          ) : activeTab ? (
            <span style={{ marginRight: 6, display: "inline-flex", flexShrink: 0 }}>
              <TabKindIcon kind={activeTab.kind} size={11} />
            </span>
          ) : null}

          {omniboxEditing || !activeTab ? (
            <input
              ref={omniboxInputRef}
              className="iab-omnibox-input"
              aria-label="Path or local loopback URL"
              value={omniboxEditing ? omniboxDraft : ""}
              placeholder="Type a file path (e.g. plans/roadmap.md) or http://127.0.0.1:3000..."
              spellCheck={false}
              onFocus={() => {
                if (!omniboxEditing) enterOmniboxEdit();
              }}
              onBlur={() => setOmniboxEditing(false)}
              onChange={(e) => {
                setOmniboxDraft(e.target.value);
                if (omniboxFeedback) onClearOmniboxFeedback();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitOmnibox();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setOmniboxEditing(false);
                  onClearOmniboxFeedback();
                }
              }}
              style={{
                flex: 1,
                minWidth: 0,
                border: "none",
                outline: "none",
                background: "transparent",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--ink-primary)",
                padding: 0,
              }}
            />
          ) : (
            <div
              className="iab-omnibox-breadcrumbs"
              title="Click to type a path or local URL"
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                gap: 2,
                overflow: "hidden",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--ink-secondary)",
              }}
            >
              {segments.map((seg, idx) => {
                const isLast = idx === segments.length - 1;
                const isFolderPrefix =
                  !isLast &&
                  (activeTab.kind === "code" || activeTab.kind === "doc") &&
                  !(activeTab.kind === "code" && idx === 0);
                return (
                  <span
                    key={`${seg}-${idx}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 2,
                      minWidth: 0,
                      flexShrink: isLast ? 1 : 0,
                    }}
                  >
                    {idx > 0 && (
                      <ChevronRight size={11} strokeWidth={1.6} color="var(--ink-faint)" style={{ flexShrink: 0 }} />
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isFolderPrefix) {
                          const start = activeTab.kind === "code" ? 1 : 0;
                          const prefix = segments.slice(start, idx + 1).join("/");
                          setFileQuery(prefix ? `${prefix}/` : "");
                          setQuickOpenVisible(true);
                        } else {
                          enterOmniboxEdit(activeTab.target);
                        }
                      }}
                      style={{
                        border: "none",
                        background: "transparent",
                        padding: "1px 3px",
                        borderRadius: "var(--radius-xs)",
                        cursor: "pointer",
                        color: isLast ? "var(--ink-primary)" : "var(--ink-muted)",
                        fontWeight: isLast ? "var(--weight-medium)" : "var(--weight-regular)",
                        fontFamily: "inherit",
                        fontSize: "inherit",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {seg}
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {/* Viewer-specific Row 2 Action Slot */}
        {activeTab?.kind === "image" && (
          <div
            className="image-zoom-toolbar"
            role="group"
            aria-label="Image zoom"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 2,
              padding: 2,
              borderRadius: "var(--radius-md)",
              background: "var(--bg-surface-subtle)",
              border: "1px solid var(--border-hairline)",
              flexShrink: 0,
            }}
          >
            {(["75%", "100%", "fit"] as ImageZoomMode[]).map((z) => {
              const selected = imageZoom === z;
              return (
                <button
                  key={z}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onChangeImageZoom(z)}
                  style={{
                    border: "none",
                    borderRadius: "var(--radius-xs)",
                    padding: "2px 7px",
                    fontSize: "var(--text-2xs)",
                    fontWeight: selected ? "var(--weight-semibold)" : "var(--weight-medium)",
                    background: selected ? "var(--bg-elevated, var(--bg-canvas))" : "transparent",
                    color: selected ? "var(--ink-primary)" : "var(--ink-muted)",
                    boxShadow: selected ? "0 1px 2px rgba(0, 0, 0, 0.14)" : "none",
                    cursor: "pointer",
                  }}
                >
                  {z === "fit" ? "Fit" : z}
                </button>
              );
            })}
          </div>
        )}

        {activeTab?.kind === "model_3d" && (
          <div
            className="model3d-preset-toolbar"
            role="group"
            aria-label="3D viewport presets"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 2,
              padding: 2,
              borderRadius: "var(--radius-md)",
              background: "var(--bg-surface-subtle)",
              border: "1px solid var(--border-hairline)",
              flexShrink: 0,
            }}
          >
            {(["Iso", "Front", "Top"] as Model3DPreset[]).map((preset) => {
              const selected = model3dPreset === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelectModel3DPreset(preset)}
                  style={{
                    border: "none",
                    borderRadius: "var(--radius-xs)",
                    padding: "2px 7px",
                    fontSize: "var(--text-2xs)",
                    fontWeight: selected ? "var(--weight-semibold)" : "var(--weight-medium)",
                    background: selected ? "var(--bg-elevated, var(--bg-canvas))" : "transparent",
                    color: selected ? "var(--ink-primary)" : "var(--ink-muted)",
                    boxShadow: selected ? "0 1px 2px rgba(0, 0, 0, 0.14)" : "none",
                    cursor: "pointer",
                  }}
                >
                  {preset}
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={model3dWireframe}
              onClick={onToggleModel3DWireframe}
              style={{
                border: "none",
                borderRadius: "var(--radius-xs)",
                padding: "2px 7px",
                fontSize: "var(--text-2xs)",
                fontWeight: model3dWireframe ? "var(--weight-semibold)" : "var(--weight-medium)",
                background: model3dWireframe ? "var(--accent-orange-soft)" : "transparent",
                color: model3dWireframe ? "var(--accent-orange)" : "var(--ink-muted)",
                cursor: "pointer",
              }}
            >
              Wire
            </button>
          </div>
        )}
      </div>

      {/* Omnibox validation / lookup feedback bar */}
      {omniboxFeedback && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "5px 10px",
            background: "var(--status-warning-bg)",
            borderBottom: "1px solid var(--status-warning-border)",
            color: "var(--status-warning-ink)",
            fontSize: "var(--text-2xs)",
            flexShrink: 0,
          }}
        >
          <span>{omniboxFeedback}</span>
          <button
            type="button"
            aria-label="Dismiss notice"
            onClick={onClearOmniboxFeedback}
            style={{
              border: "none",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              padding: 2,
              display: "inline-flex",
            }}
          >
            <X size={11} strokeWidth={1.8} />
          </button>
        </div>
      )}

      {/* ======================== QUICK-OPEN POPOVER ============================ */}
      {quickOpenVisible && (
        <>
          <div
            className="iab-popover-backdrop"
            onClick={() => {
              setQuickOpenVisible(false);
              setWebUrlError(null);
            }}
            style={{ position: "absolute", inset: 0, zIndex: 30 }}
          />
          <div
            className="iab-quickopen"
            role="dialog"
            aria-label="Quick Open"
            style={{
              position: "absolute",
              top: 38,
              left: 8,
              width: 316,
              maxWidth: "calc(100% - 16px)",
              maxHeight: "min(440px, calc(100dvh - 108px))",
              overflowY: "auto",
              background: "var(--studio-panel)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--studio-panel-radius)",
              boxShadow: "var(--shadow-popover)",
              zIndex: 31,
              padding: 8,
              fontSize: "var(--text-xs)",
            }}
          >
            <QuickGroup label="Docs & Plans">
              {docArtifacts.length === 0 && <QuickEmpty text="No documents in this project" />}
              {docArtifacts.map((a) => (
                <QuickItem
                  key={a.relativePath}
                  icon={<FileText size={13} strokeWidth={1.6} color="var(--ink-secondary)" />}
                  primary={a.name}
                  secondary={a.relativePath}
                  onClick={() => openQuickItem({ kind: "doc", target: a.relativePath, label: a.name, projectId })}
                />
              ))}
            </QuickGroup>

            <QuickGroup label="Images & 3D Models">
              {visualArtifacts.length === 0 && <QuickEmpty text="No images or 3D assets" />}
              {visualArtifacts.map((a) => (
                <QuickItem
                  key={a.relativePath}
                  icon={
                    a.kind === "image" ? (
                      <ImageIcon size={13} strokeWidth={1.6} color="var(--ink-secondary)" />
                    ) : (
                      <Box size={13} strokeWidth={1.6} color="var(--ink-secondary)" />
                    )
                  }
                  primary={a.name}
                  secondary={a.relativePath}
                  onClick={() =>
                    openQuickItem({
                      kind: a.kind === "image" ? "image" : "model_3d",
                      target: a.relativePath,
                      label: a.name,
                      projectId,
                    })
                  }
                />
              ))}
            </QuickGroup>

            <QuickGroup label="Code Search">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  marginBottom: 4,
                  borderRadius: "var(--radius-sm)",
                  background: "var(--bg-surface-subtle)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <Search size={12} strokeWidth={1.6} color="var(--ink-muted)" />
                <input
                  ref={quickSearchRef}
                  className="iab-quickopen-search"
                  placeholder="Filter workspace files..."
                  value={fileQuery}
                  onChange={(e) => setFileQuery(e.target.value)}
                  style={{
                    flex: 1,
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    fontSize: "var(--text-xs)",
                    fontFamily: "var(--font-mono)",
                    color: "var(--ink-primary)",
                    padding: 0,
                  }}
                />
              </div>
              {filteredFiles.length === 0 && <QuickEmpty text="No matching repository files" />}
              {filteredFiles.map((f) => (
                <QuickItem
                  key={f.relativePath}
                  icon={<FileCode2 size={13} strokeWidth={1.6} color="var(--ink-secondary)" />}
                  primary={f.name}
                  secondary={`${f.relativePath} · ${formatBytes(f.sizeBytes)}`}
                  onClick={() => openQuickItem({ kind: "code", target: f.relativePath, label: f.name, projectId })}
                />
              ))}
            </QuickGroup>

            <QuickGroup label="Git Diff">
              <QuickItem
                icon={<GitCompareArrows size={13} strokeWidth={1.6} color="var(--ink-secondary)" />}
                primary="diff://HEAD"
                secondary={
                  gitDiff
                    ? `${gitDiff.filesChanged} ${gitDiff.filesChanged === 1 ? "file" : "files"} · +${gitDiff.insertions} -${gitDiff.deletions}`
                    : "Open workspace diff"
                }
                onClick={() => openQuickItem({ kind: "diff", target: "diff://HEAD", label: "Git Diff", projectId })}
              />
            </QuickGroup>

            <QuickGroup label="Loopback Web URL">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--bg-surface-subtle)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <Globe size={12} strokeWidth={1.6} color="var(--ink-muted)" />
                <input
                  className="iab-quickopen-url"
                  placeholder="http://127.0.0.1:3000"
                  value={webUrlDraft}
                  spellCheck={false}
                  onChange={(e) => {
                    setWebUrlDraft(e.target.value);
                    if (webUrlError) setWebUrlError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      openWebDraft(webUrlDraft);
                    }
                  }}
                  style={{
                    flex: 1,
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    fontSize: "var(--text-xs)",
                    fontFamily: "var(--font-mono)",
                    color: "var(--ink-primary)",
                    padding: 0,
                  }}
                />
                <button type="button" className="btn xs primary" onClick={() => openWebDraft(webUrlDraft)}>
                  Open
                </button>
              </div>
              {webUrlError && (
                <div style={{ marginTop: 4, padding: "0 4px", fontSize: "var(--text-2xs)", color: "var(--status-danger-ink)" }}>
                  {webUrlError}
                </div>
              )}
            </QuickGroup>
          </div>
        </>
      )}
    </>
  );
}
