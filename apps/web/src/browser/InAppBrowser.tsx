import {
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  Copy,
  Crosshair,
  FileCode2,
  FileText,
  FileWarning,
  GitCompareArrows,
  Globe,
  Image as ImageIcon,
  Lock,
  Maximize2,
  MessageSquare,
  Minimize2,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type {
  AnnotationAnchor,
  AnnotationRecord,
  AnnotationStatus,
  ArtifactEntry,
  GitDiffResponse,
  RepoFileEntry,
} from "@bot-factory/shared";
import { BotThinkingOrb } from "../components/BotThinkingOrb";

export type BrowserTabKind = "doc" | "image" | "model_3d" | "code" | "diff" | "web";

export interface BrowserTabItem {
  id: string;
  kind: BrowserTabKind;
  title: string;
  path: string;
  url?: string;
}

export interface InAppBrowserProps {
  projectId: string | null;
  activeAgentId: string | null;
  tabs: BrowserTabItem[];
  activeTabId: string | null;
  artifacts: ArtifactEntry[];
  annotations: AnnotationRecord[];
  repoFiles: RepoFileEntry[];
  gitDiff: GitDiffResponse | null;
  expanded: boolean;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onOpenTab: (tab: Omit<BrowserTabItem, "id">) => void;
  onToggleExpand: () => void;
  onCloseBrowser: () => void;
  onRefreshDiff: () => void;
  onCreateAnnotation: (params: {
    anchor: AnnotationAnchor;
    comment: string;
    snapshotDataUrl?: string;
    requestFixNow: boolean;
  }) => Promise<void>;
  onResolveAnnotation: (annotationId: string, status: AnnotationStatus) => Promise<void>;
}

/* ---------------------------------------------------------------------------
   Helpers
   --------------------------------------------------------------------------- */

const LOOPBACK_URL_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/.*)?$/i;

function isAllowedWebUrl(url: string): boolean {
  return LOOPBACK_URL_RE.test(url) || url.startsWith("/api/");
}

function normalizeUrlInput(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/.*)?$/i.test(v)) return `http://${v}`;
  return null;
}

function quickHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function breadcrumbSegments(tab: BrowserTabItem): string[] {
  if (tab.kind === "web") return [tab.url ?? tab.path];
  if (tab.kind === "diff") return [tab.path || "diff://HEAD"];
  if (tab.kind === "code") return ["repo", ...tab.path.split("/").filter(Boolean)];
  return tab.path.split("/").filter(Boolean);
}

/* ---------------------------------------------------------------------------
   Inline-markdown renderer (headings, lists, quotes, code — never raw `#`)
   --------------------------------------------------------------------------- */

interface MdBlock {
  blockId: string;
  contentHash: string;
  text: string;
}

function parseMdBlocks(text: string): MdBlock[] {
  return text
    .split(/\n{2,}/)
    .map((raw, idx) => {
      const clean = raw.trim();
      const slug = clean
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 28);
      return {
        blockId: `blk-${idx}-${slug || "section"}`,
        contentHash: quickHash(clean),
        text: clean,
      };
    })
    .filter((b) => b.text.length > 0);
}

function renderInlineMd(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={i} className="iab-md-code" style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.88em",
          background: "var(--bg-surface-subtle)",
          border: "1px solid var(--border-hairline)",
          borderRadius: "var(--radius-xs)",
          padding: "1px 5px",
          color: "var(--ink-primary)",
        }}>
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={i} style={{ fontWeight: "var(--weight-semibold)", color: "var(--ink-primary)" }}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return <span key={i}>{part}</span>;
  });
}

function MarkdownBlockBody({ text }: { text: string }) {
  const lines = text.split("\n").map((l) => l.trimEnd());
  const headingMatch = /^(#{1,6})\s+(.*)$/.exec(lines[0] ?? "");
  if (headingMatch && lines.length === 1) {
    const level = Math.min(3, headingMatch[1]!.length);
    const size = level === 1 ? "var(--text-xl)" : level === 2 ? "var(--text-lg)" : "var(--text-base)";
    return (
      <div
        className={`iab-md-h${level}`}
        style={{
          fontSize: size,
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-tight)",
          color: "var(--ink-primary)",
          lineHeight: "var(--leading-snug)",
        }}
      >
        {renderInlineMd(headingMatch[2]!)}
      </div>
    );
  }
  if (/^---+$/.test(lines[0] ?? "") && lines.length === 1) {
    return <hr style={{ border: "none", borderTop: "1px solid var(--border-hairline)", margin: "2px 0" }} />;
  }
  const isUl = lines.every((l) => /^\s*[-*]\s+/.test(l));
  const isOl = lines.every((l) => /^\s*\d+\.\s+/.test(l));
  if (isUl || isOl) {
    const items = lines.map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
    return (
      <ul
        className="iab-md-list"
        style={{
          margin: 0,
          paddingLeft: 22,
          listStyleType: isOl ? "decimal" : "disc",
          display: "flex",
          flexDirection: "column",
          gap: 3,
          color: "var(--ink-primary)",
          fontSize: "var(--text-base)",
          lineHeight: "var(--leading-prose)",
        }}
      >
        {items.map((item, i) => (
          <li key={i}>{renderInlineMd(item)}</li>
        ))}
      </ul>
    );
  }
  const isQuote = lines.every((l) => /^\s*>/.test(l));
  if (isQuote) {
    const body = lines.map((l) => l.replace(/^\s*>\s?/, "")).join(" ");
    return (
      <blockquote
        className="iab-md-quote"
        style={{
          margin: 0,
          padding: "2px 0 2px 12px",
          borderLeft: "2px solid var(--border-strong)",
          color: "var(--ink-secondary)",
          fontSize: "var(--text-base)",
          lineHeight: "var(--leading-prose)",
        }}
      >
        {renderInlineMd(body)}
      </blockquote>
    );
  }
  // Paragraph — strip residual heading marker, merge soft-wrapped lines.
  const body = lines
    .map((l) => l.replace(/^#{1,6}\s+/, ""))
    .join(" ")
    .trim();
  return (
    <p
      className="iab-md-p"
      style={{
        margin: 0,
        color: "var(--ink-primary)",
        fontSize: "var(--text-base)",
        lineHeight: "var(--leading-prose)",
      }}
    >
      {renderInlineMd(body)}
    </p>
  );
}

/* ---------------------------------------------------------------------------
   Light syntax tinting for the code viewer
   --------------------------------------------------------------------------- */

const CODE_TOKEN_RE =
  /(\/\/.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:const|let|var|function|return|if|elif|else|for|while|import|export|from|as|type|interface|class|extends|implements|new|await|async|try|catch|finally|throw|switch|case|default|break|continue|do|in|of|typeof|instanceof|void|delete|yield|static|get|set|this|super|readonly|public|private|protected|def|lambda|None|True|False|and|or|not|is|global|nonlocal|pass|raise|with|local|end|then|repeat|until|self|nil|fn|pub|use|mod|struct|enum|impl|trait|match|mut|ref|where|crate|SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|CREATE|TABLE|print|echo)\b)|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\/\*.*?\*\/)/g;

interface CodeToken {
  text: string;
  cls: "comment" | "string" | "keyword" | "number" | null;
}

function tokenizeCodeLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  // A leading `#` (after whitespace) is treated as a comment for scripting langs.
  const hashComment = /^\s*#/.exec(line);
  const scanUpto = hashComment ? hashComment.index + (line.match(/^\s*/)![0].length) : line.length;
  let last = 0;
  CODE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_TOKEN_RE.exec(line)) !== null) {
    if (m.index >= scanUpto) break;
    if (m.index > last) tokens.push({ text: line.slice(last, m.index), cls: null });
    const cls: CodeToken["cls"] = m[1] !== undefined || m[5] !== undefined
      ? "comment"
      : m[2] !== undefined
        ? "string"
        : m[3] !== undefined
          ? "keyword"
          : "number";
    tokens.push({ text: m[0], cls });
    last = m.index + m[0].length;
    if (m[0].length === 0) break;
  }
  if (last < line.length) {
    const rest = line.slice(last);
    if (hashComment && last >= scanUpto) {
      tokens.push({ text: rest, cls: "comment" });
    } else {
      tokens.push({ text: rest, cls: null });
    }
  }
  return tokens;
}

const CODE_TOKEN_STYLE: Record<NonNullable<CodeToken["cls"]>, React.CSSProperties> = {
  comment: { color: "var(--ink-faint)", fontStyle: "italic" },
  string: { color: "var(--status-success-ink)" },
  keyword: { color: "var(--status-active-ink)", fontWeight: "var(--weight-medium)" },
  number: { color: "var(--status-warning-ink)" },
};

/* ---------------------------------------------------------------------------
   Three.js object disposal (shared with PreviewStudio semantics)
   --------------------------------------------------------------------------- */

function disposeObjectTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry && typeof mesh.geometry.dispose === "function") {
      mesh.geometry.dispose();
    }
    const mat = mesh.material;
    if (Array.isArray(mat)) {
      for (const m of mat) {
        if (m && typeof m.dispose === "function") m.dispose();
      }
    } else if (mat && typeof mat.dispose === "function") {
      mat.dispose();
    }
  });
}

/* ---------------------------------------------------------------------------
   InAppBrowser — 2-Row native-feeling tabbed browser pane
   --------------------------------------------------------------------------- */

export function InAppBrowser({
  projectId,
  activeAgentId,
  tabs,
  activeTabId,
  artifacts,
  annotations,
  repoFiles,
  gitDiff,
  expanded,
  onSelectTab,
  onCloseTab,
  onOpenTab,
  onToggleExpand,
  onCloseBrowser,
  onRefreshDiff,
  onCreateAnnotation,
  onResolveAnnotation,
}: InAppBrowserProps): JSX.Element {
  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);

  /* Per-session visited-tab history -------------------------------------- */
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);
  const [, setHistVersion] = useState(0);

  const pushHistory = (tabId: string) => {
    const cur = historyRef.current[historyIdxRef.current];
    if (cur === tabId) return;
    historyRef.current = historyRef.current.slice(0, historyIdxRef.current + 1);
    historyRef.current.push(tabId);
    historyIdxRef.current = historyRef.current.length - 1;
    setHistVersion((v) => v + 1);
  };

  const selectTab = (tabId: string) => {
    pushHistory(tabId);
    onSelectTab(tabId);
  };

  const goBack = () => {
    if (historyIdxRef.current <= 0) return;
    historyIdxRef.current -= 1;
    onSelectTab(historyRef.current[historyIdxRef.current]!);
    setHistVersion((v) => v + 1);
  };

  const goForward = () => {
    if (historyIdxRef.current >= historyRef.current.length - 1) return;
    historyIdxRef.current += 1;
    onSelectTab(historyRef.current[historyIdxRef.current]!);
    setHistVersion((v) => v + 1);
  };

  // Sync history when the active tab changes from outside (parent opens a tab).
  useEffect(() => {
    if (activeTabId) pushHistory(activeTabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  // Drop dangling history entries for closed tabs.
  useEffect(() => {
    const ids = new Set(tabs.map((t) => t.id));
    const kept = historyRef.current.filter((id) => ids.has(id));
    if (kept.length !== historyRef.current.length) {
      const activeIdx = kept.indexOf(activeTabId ?? "");
      historyRef.current = kept;
      historyIdxRef.current = activeIdx >= 0 ? activeIdx : kept.length - 1;
      setHistVersion((v) => v + 1);
    }
  }, [tabs, activeTabId]);

  /* Local UI state --------------------------------------------------------- */
  const [annotate, setAnnotate] = useState(false);
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [webUrlDraft, setWebUrlDraft] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [pendingAnchor, setPendingAnchor] = useState<AnnotationAnchor | null>(null);
  const [pendingSnapshot, setPendingSnapshot] = useState<string | undefined>(undefined);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [focusCameraPose, setFocusCameraPose] = useState<{
    pos: [number, number, number];
    target: [number, number, number];
  } | null>(null);

  /* Omnibox ----------------------------------------------------------------- */
  const [omniboxEditing, setOmniboxEditing] = useState(false);
  const [omniboxDraft, setOmniboxDraft] = useState("");
  const omniboxValue = omniboxEditing
    ? omniboxDraft
    : activeTab
      ? breadcrumbSegments(activeTab).join(" › ")
      : "";

  const commitOmnibox = () => {
    const url = normalizeUrlInput(omniboxDraft);
    if (url) {
      onOpenTab({ kind: "web", title: url, path: url, url });
    }
    setOmniboxEditing(false);
  };

  /* Derived ------------------------------------------------------------------ */
  const fileAnnotations = useMemo(
    () => (activeTab ? annotations.filter((a) => a.filePath === activeTab.path) : []),
    [annotations, activeTab],
  );

  const docArtifacts = useMemo(() => artifacts.filter((a) => a.kind === "doc"), [artifacts]);
  const visualArtifacts = useMemo(
    () => artifacts.filter((a) => a.kind === "image" || a.kind === "model_3d"),
    [artifacts],
  );
  const filteredFiles = useMemo(() => {
    const q = fileQuery.trim().toLowerCase();
    if (!q) return repoFiles.slice(0, 60);
    return repoFiles.filter((f) => f.relativePath.toLowerCase().includes(q)).slice(0, 60);
  }, [repoFiles, fileQuery]);

  const pickAnchor = (anchor: AnnotationAnchor, snapshot?: string) => {
    setPendingAnchor(anchor);
    setPendingSnapshot(snapshot);
    setPinsOpen(false);
  };

  const submitAnnotation = async () => {
    if (!pendingAnchor || !comment.trim() || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await onCreateAnnotation({
        anchor: pendingAnchor,
        comment: comment.trim(),
        snapshotDataUrl: pendingSnapshot,
        requestFixNow: true,
      });
      setPendingAnchor(null);
      setPendingSnapshot(undefined);
      setComment("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const resolveAnnotation = (annotationId: string, status: AnnotationStatus) => {
    setActionError(null);
    void onResolveAnnotation(annotationId, status).catch((err) => {
      setActionError(err instanceof Error ? err.message : String(err));
    });
  };

  const openQuickItem = (tab: Omit<BrowserTabItem, "id">) => {
    onOpenTab(tab);
    setQuickOpenVisible(false);
  };

  const canAnnotate = activeTab?.kind === "doc" || activeTab?.kind === "image" || activeTab?.kind === "model_3d";
  const canBack = historyIdxRef.current > 0;
  const canForward = historyIdxRef.current < historyRef.current.length - 1;

  const iconBtnStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 26,
    height: 24,
    border: "none",
    background: "transparent",
    borderRadius: "var(--radius-sm)",
    cursor: "pointer",
    color: "var(--ink-secondary)",
    flexShrink: 0,
  };

  return (
    <div
      className={`iab-root ${expanded ? "iab-expanded" : ""}`}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "var(--bg-canvas)",
        color: "var(--ink-primary)",
        fontFamily: "var(--font-sans)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* ============================ ROW 1: TAB BAR ============================ */}
      <div
        className="iab-tabbar"
        style={{
          height: 36,
          flexShrink: 0,
          display: "flex",
          alignItems: "flex-end",
          background: "#FAFAFA",
          borderBottom: "1px solid var(--border-hairline)",
          paddingLeft: 6,
          paddingRight: 4,
        }}
      >
        <div
          className="iab-tabstrip"
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
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className={`iab-tab ${active ? "active" : ""}`}
                role="tab"
                aria-selected={active}
                title={tab.path}
                onClick={() => selectTab(tab.id)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  height: 30,
                  padding: "0 8px 0 10px",
                  maxWidth: 190,
                  minWidth: 0,
                  cursor: "pointer",
                  userSelect: "none",
                  fontSize: "var(--text-xs)",
                  fontWeight: active ? "var(--weight-medium)" : "var(--weight-regular)",
                  color: active ? "var(--ink-primary)" : "var(--ink-secondary)",
                  background: active ? "#FFFFFF" : "transparent",
                  border: active ? "1px solid var(--border-hairline)" : "1px solid transparent",
                  borderBottom: active ? "1px solid #FFFFFF" : "1px solid transparent",
                  marginBottom: active ? -1 : 0,
                  borderRadius: "7px 7px 0 0",
                  flexShrink: 0,
                }}
              >
                <TabKindIcon kind={tab.kind} />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {tab.title}
                </span>
                <button
                  className="iab-tab-close"
                  aria-label={`Tab ${tab.title} schließen`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 16,
                    height: 16,
                    border: "none",
                    background: "transparent",
                    borderRadius: 4,
                    cursor: "pointer",
                    color: "var(--ink-muted)",
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
            className="iab-add-tab"
            aria-label="Neuen Tab öffnen"
            title="Pläne, Bilder, Code, Diff oder Web-URL öffnen"
            onClick={() => {
              setQuickOpenVisible((v) => !v);
              setFileQuery("");
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

        {/* Right chrome: Annotate / Pins / Expand / Close */}
        <div style={{ display: "flex", alignItems: "center", gap: 2, paddingBottom: 5, paddingLeft: 6 }}>
          <button
            className={`iab-chrome-btn iab-annotate-toggle ${annotate ? "active" : ""}`}
            title={canAnnotate ? "Annotate-Modus: klicke ins Dokument / Bild / 3D für Fix-Pins" : "Annotate (nur für Docs, Bilder & 3D)"}
            disabled={!canAnnotate}
            onClick={() => setAnnotate((v) => !v)}
            style={{
              ...iconBtnStyle,
              width: "auto",
              gap: 4,
              padding: "0 8px",
              fontSize: "var(--text-2xs)",
              fontFamily: "var(--font-sans)",
              color: annotate ? "var(--ink-primary)" : "var(--ink-muted)",
              background: annotate ? "var(--bg-active)" : "transparent",
              border: annotate ? "1px solid var(--border-strong)" : "1px solid transparent",
              opacity: canAnnotate ? 1 : 0.4,
              cursor: canAnnotate ? "pointer" : "default",
            }}
          >
            <Crosshair size={12} strokeWidth={1.6} />
            Annotate
          </button>
          <button
            className={`iab-chrome-btn iab-pins-btn ${pinsOpen ? "active" : ""}`}
            title="Annotationen dieses Dokuments prüfen"
            onClick={() => setPinsOpen((v) => !v)}
            style={{
              ...iconBtnStyle,
              width: "auto",
              gap: 4,
              padding: "0 8px",
              fontSize: "var(--text-2xs)",
              fontFamily: "var(--font-sans)",
              color: fileAnnotations.length > 0 ? "var(--ink-primary)" : "var(--ink-muted)",
              background: pinsOpen ? "var(--bg-active)" : "transparent",
              border: pinsOpen ? "1px solid var(--border-strong)" : "1px solid transparent",
            }}
          >
            <Pin size={12} strokeWidth={1.6} />
            Pins ({fileAnnotations.length})
          </button>
          <button
            className="iab-chrome-btn iab-expand"
            aria-label={expanded ? "Ansicht verkleinern" : "Ansicht maximieren"}
            title={expanded ? "Verkleinern" : "Maximieren"}
            onClick={onToggleExpand}
            style={iconBtnStyle}
          >
            {expanded ? <Minimize2 size={13} strokeWidth={1.6} /> : <Maximize2 size={13} strokeWidth={1.6} />}
          </button>
          <button
            className="iab-chrome-btn iab-close"
            aria-label="Browser schließen"
            title="Browser schließen"
            onClick={onCloseBrowser}
            style={iconBtnStyle}
          >
            <X size={14} strokeWidth={1.6} />
          </button>
        </div>
      </div>

      {/* ========================= ROW 2: ADDRESS BAR =========================== */}
      <div
        className="iab-addressbar"
        style={{
          height: 34,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 4,
          background: "#FFFFFF",
          borderBottom: "1px solid var(--border-subtle)",
          padding: "0 8px",
        }}
      >
        <button
          className="iab-nav-btn"
          aria-label="Zurück"
          title="Zurück"
          disabled={!canBack}
          onClick={goBack}
          style={{ ...iconBtnStyle, opacity: canBack ? 1 : 0.35 }}
        >
          <ArrowLeft size={14} strokeWidth={1.6} />
        </button>
        <button
          className="iab-nav-btn"
          aria-label="Vorwärts"
          title="Vorwärts"
          disabled={!canForward}
          onClick={goForward}
          style={{ ...iconBtnStyle, opacity: canForward ? 1 : 0.35 }}
        >
          <ArrowRight size={14} strokeWidth={1.6} />
        </button>
        <button
          className="iab-nav-btn"
          aria-label="Neu laden"
          title="Inhalt neu laden"
          onClick={() => {
            setReloadNonce((n) => n + 1);
            if (activeTab?.kind === "diff") onRefreshDiff();
          }}
          style={iconBtnStyle}
        >
          <RefreshCw size={13} strokeWidth={1.6} />
        </button>

        <div
          className="iab-omnibox"
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            height: 24,
            marginLeft: 4,
            padding: "0 10px",
            borderRadius: "var(--radius-pill)",
            border: omniboxEditing ? "1px solid var(--border-strong)" : "1px solid transparent",
            background: omniboxEditing ? "#FFFFFF" : "var(--bg-surface)",
            transition: "background var(--duration-fast) var(--ease-out-quiet)",
          }}
        >
          {activeTab?.kind === "web" && (
            <Lock size={11} strokeWidth={1.6} color="var(--ink-faint)" style={{ marginRight: 6, flexShrink: 0 }} />
          )}
          <input
            className="iab-omnibox-input"
            aria-label="Adresse oder Pfad"
            value={omniboxValue}
            placeholder="http://localhost:5173 oder 127.0.0.1:3000 …"
            spellCheck={false}
            onFocus={() => {
              setOmniboxEditing(true);
              setOmniboxDraft(omniboxValue);
            }}
            onBlur={() => setOmniboxEditing(false)}
            onChange={(e) => setOmniboxDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
                commitOmnibox();
              } else if (e.key === "Escape") {
                setOmniboxEditing(false);
                e.currentTarget.blur();
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
        </div>
      </div>

      {/* ============================ CONTENT CANVAS ============================ */}
      <div
        className="iab-canvas"
        style={{ flex: 1, minHeight: 0, position: "relative", background: "#FFFFFF", overflow: "hidden" }}
      >
        {!activeTab && (
          <div
            className="iab-empty"
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              color: "var(--ink-muted)",
              fontSize: "var(--text-sm)",
            }}
          >
            <Globe size={22} strokeWidth={1.4} color="var(--ink-faint)" />
            <span>Kein Tab geöffnet — nutze + um Pläne, Bilder, 3D-Modelle, Code oder eine lokale URL zu öffnen.</span>
          </div>
        )}
        {activeTab?.kind === "doc" && projectId && (
          <DocViewer
            key={`${activeTab.id}:${reloadNonce}`}
            projectId={projectId}
            filePath={activeTab.path}
            annotate={annotate}
            annotations={fileAnnotations}
            onPickAnchor={pickAnchor}
          />
        )}
        {activeTab?.kind === "image" && projectId && (
          <ImageViewer
            key={`${activeTab.id}:${reloadNonce}`}
            projectId={projectId}
            filePath={activeTab.path}
            annotate={annotate}
            annotations={fileAnnotations}
            onPickAnchor={pickAnchor}
          />
        )}
        {activeTab?.kind === "model_3d" && projectId && (
          <Model3DViewer
            key={`${activeTab.id}:${reloadNonce}`}
            projectId={projectId}
            filePath={activeTab.path}
            annotate={annotate}
            annotations={fileAnnotations}
            focusCameraPose={focusCameraPose}
            onPickAnchor={pickAnchor}
          />
        )}
        {activeTab?.kind === "code" && projectId && (
          <CodeViewer
            key={`${activeTab.id}:${reloadNonce}`}
            projectId={projectId}
            agentId={activeAgentId}
            filePath={activeTab.path}
          />
        )}
        {activeTab?.kind === "diff" && (
          <DiffViewer gitDiff={gitDiff} onRefreshDiff={onRefreshDiff} />
        )}
        {activeTab?.kind === "web" && <WebViewer key={`${activeTab.id}:${reloadNonce}`} url={activeTab.url ?? activeTab.path} />}
        {activeTab && !projectId && activeTab.kind !== "diff" && activeTab.kind !== "web" && (
          <div
            className="iab-error-banner"
            style={{
              margin: 16,
              padding: "10px 14px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--status-warning-border)",
              background: "var(--status-warning-bg)",
              color: "var(--status-warning-ink)",
              fontSize: "var(--text-sm)",
            }}
          >
            Kein Projekt ausgewählt — Inhalt kann nicht geladen werden.
          </div>
        )}
      </div>

      {/* ======================== QUICK-OPEN POPOVER ============================ */}
      {quickOpenVisible && (
        <>
          <div
            className="iab-popover-backdrop"
            onClick={() => setQuickOpenVisible(false)}
            style={{ position: "absolute", inset: 0, zIndex: "var(--z-popover)" as unknown as number }}
          />
          <div
            className="iab-quickopen"
            role="menu"
            style={{
              position: "absolute",
              top: 38,
              left: 8,
              width: 300,
              maxHeight: 420,
              overflowY: "auto",
              background: "#FFFFFF",
              border: "1px solid var(--border-hairline)",
              borderRadius: "var(--radius-lg)",
              boxShadow: "var(--shadow-popover)",
              zIndex: 31,
              padding: 6,
              fontSize: "var(--text-xs)",
            }}
          >
            <QuickGroup label="Pläne & Dokumente">
              {docArtifacts.length === 0 && <QuickEmpty text="Keine Dokumente" />}
              {docArtifacts.map((a) => (
                <QuickItem
                  key={a.relativePath}
                  icon={<FileText size={13} strokeWidth={1.6} color="var(--ink-secondary)" />}
                  primary={a.name}
                  secondary={a.relativePath}
                  onClick={() => openQuickItem({ kind: "doc", title: a.name, path: a.relativePath })}
                />
              ))}
            </QuickGroup>

            <QuickGroup label="Bilder & 3D-Modelle">
              {visualArtifacts.length === 0 && <QuickEmpty text="Keine Bilder/Modelle" />}
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
                    openQuickItem({ kind: a.kind === "image" ? "image" : "model_3d", title: a.name, path: a.relativePath })
                  }
                />
              ))}
            </QuickGroup>

            <QuickGroup label="Code-Dateien">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  marginBottom: 2,
                  borderRadius: "var(--radius-sm)",
                  background: "var(--bg-surface)",
                }}
              >
                <Search size={12} strokeWidth={1.6} color="var(--ink-muted)" />
                <input
                  className="iab-quickopen-search"
                  placeholder="Dateien filtern…"
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
              {filteredFiles.length === 0 && <QuickEmpty text="Keine Dateien gefunden" />}
              {filteredFiles.map((f) => (
                <QuickItem
                  key={f.relativePath}
                  icon={<FileCode2 size={13} strokeWidth={1.6} color="var(--ink-secondary)" />}
                  primary={f.name}
                  secondary={`${f.relativePath} · ${formatBytes(f.sizeBytes)}`}
                  onClick={() => openQuickItem({ kind: "code", title: f.name, path: f.relativePath })}
                />
              ))}
            </QuickGroup>

            <QuickGroup label="Git Diff">
              <QuickItem
                icon={<GitCompareArrows size={13} strokeWidth={1.6} color="var(--ink-secondary)" />}
                primary="diff://HEAD"
                secondary={
                  gitDiff
                    ? `${gitDiff.filesChanged} Dateien · +${gitDiff.insertions} −${gitDiff.deletions}`
                    : "Workspace-Diff öffnen"
                }
                onClick={() => openQuickItem({ kind: "diff", title: "diff://HEAD", path: "diff://HEAD" })}
              />
            </QuickGroup>

            <QuickGroup label="Lokale Web-URL">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--bg-surface)",
                }}
              >
                <Globe size={12} strokeWidth={1.6} color="var(--ink-muted)" />
                <input
                  className="iab-quickopen-url"
                  placeholder="http://127.0.0.1:5173"
                  value={webUrlDraft}
                  spellCheck={false}
                  onChange={(e) => setWebUrlDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const url = normalizeUrlInput(webUrlDraft);
                      if (url) {
                        openQuickItem({ kind: "web", title: url, path: url, url });
                        setWebUrlDraft("");
                      }
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
                <button
                  className="btn sm"
                  style={{ fontSize: "var(--text-2xs)", padding: "2px 8px" }}
                  onClick={() => {
                    const url = normalizeUrlInput(webUrlDraft);
                    if (url) {
                      openQuickItem({ kind: "web", title: url, path: url, url });
                      setWebUrlDraft("");
                    }
                  }}
                >
                  Öffnen
                </button>
              </div>
            </QuickGroup>
          </div>
        </>
      )}

      {/* ================= FLOATING ANNOTATION COMPOSER ========================= */}
      {pendingAnchor && (
        <div
          className="iab-composer"
          style={{
            position: "absolute",
            right: 12,
            bottom: 12,
            width: 300,
            background: "#FFFFFF",
            border: "1px solid var(--border-hairline)",
            borderRadius: "var(--radius-lg)",
            boxShadow: "var(--shadow-modal)",
            zIndex: 40,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
              fontSize: "var(--text-xs)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink-primary)",
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <PinCommentGlyph />
              Neuer Pin ({pendingAnchor.kind})
            </span>
            {submitting && <BotThinkingOrb activity="shaping" size={20} />}
          </div>
          <div
            className="mono-tag"
            style={{ overflowWrap: "anywhere", fontSize: "var(--text-2xs)", color: "var(--ink-muted)" }}
          >
            {pendingAnchor.kind === "doc" && `block: ${pendingAnchor.blockId}`}
            {pendingAnchor.kind === "image" &&
              (pendingAnchor.pin
                ? `pin: (${pendingAnchor.pin.x.toFixed(2)}, ${pendingAnchor.pin.y.toFixed(2)})`
                : pendingAnchor.rect
                  ? `rect: (${pendingAnchor.rect.x.toFixed(2)}, ${pendingAnchor.rect.y.toFixed(2)}, ${pendingAnchor.rect.w.toFixed(2)} × ${pendingAnchor.rect.h.toFixed(2)})`
                  : "region")}
            {pendingAnchor.kind === "model_3d" &&
              `mesh: ${pendingAnchor.meshName} @ [${pendingAnchor.point.map((n) => n.toFixed(2)).join(", ")}]`}
          </div>
          {pendingSnapshot && (
            <img
              src={pendingSnapshot}
              alt="3D Kamera-Snapshot"
              style={{
                width: "100%",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border-hairline)",
                display: "block",
              }}
            />
          )}
          <textarea
            className="field-textarea iab-composer-text"
            rows={3}
            placeholder="Was soll der zuständige Bot hier fixen?"
            value={comment}
            autoFocus
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitAnnotation();
              if (e.key === "Escape") setPendingAnchor(null);
            }}
            style={{
              width: "100%",
              resize: "vertical",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-sm)",
              lineHeight: "var(--leading-normal)",
              border: "1px solid var(--border-hairline)",
              borderRadius: "var(--radius-sm)",
              padding: "6px 8px",
              outline: "none",
              color: "var(--ink-primary)",
            }}
          />
          {actionError && <div className="inline-error" style={{ fontSize: "var(--text-xs)", color: "var(--status-danger-ink)" }}>{actionError}</div>}
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button className="btn sm" onClick={() => setPendingAnchor(null)}>
              Abbrechen
            </button>
            <button
              className="btn sm primary"
              onClick={() => void submitAnnotation()}
              disabled={submitting || !comment.trim()}
              style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
            >
              <Send size={12} strokeWidth={1.6} /> Fix-Task auslösen
            </button>
          </div>
        </div>
      )}

      {/* ===================== ANNOTATIONS REVIEW POPOVER ======================= */}
      {pinsOpen && !pendingAnchor && (
        <div
          className="iab-pins-popover"
          style={{
            position: "absolute",
            right: 12,
            bottom: 12,
            width: 320,
            maxHeight: 380,
            overflowY: "auto",
            background: "#FFFFFF",
            border: "1px solid var(--border-hairline)",
            borderRadius: "var(--radius-lg)",
            boxShadow: "var(--shadow-modal)",
            zIndex: 40,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: "var(--text-xs)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink-primary)",
            }}
          >
            <span>Annotationen ({fileAnnotations.length})</span>
            <button
              aria-label="Schließen"
              onClick={() => setPinsOpen(false)}
              style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-muted)", padding: 2 }}
            >
              <X size={13} strokeWidth={1.6} />
            </button>
          </div>
          {fileAnnotations.length === 0 && (
            <div style={{ color: "var(--ink-muted)", fontSize: "var(--text-xs)", lineHeight: "var(--leading-normal)" }}>
              Keine Pins auf diesem Dokument — aktiviere <b>Annotate</b> und klicke oder ziehe direkt im Canvas.
            </div>
          )}
          {fileAnnotations.map((ann, idx) => (
            <div
              key={ann.id}
              className={`ann-item iab-ann-item ${ann.anchor.kind === "model_3d" ? "clickable" : ""}`}
              onClick={() => {
                if (ann.anchor.kind === "model_3d") {
                  setFocusCameraPose({ pos: ann.anchor.camera.pos, target: ann.anchor.camera.target });
                  setPinsOpen(false);
                }
              }}
              style={{
                cursor: ann.anchor.kind === "model_3d" ? "pointer" : "default",
                border: "1px solid var(--border-hairline)",
                borderRadius: "var(--radius-md)",
                padding: "8px 10px",
                fontSize: "var(--text-xs)",
                display: "flex",
                flexDirection: "column",
                gap: 5,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                <span style={{ fontWeight: "var(--weight-semibold)", color: "var(--ink-primary)" }}>
                  #{idx + 1} · {ann.targetType}
                </span>
                <span
                  className={`pill ${
                    ann.status === "approved" ? "success" : ann.status === "resolved_pending_review" ? "warning" : "active"
                  }`}
                  style={{ fontSize: "var(--text-2xs)" }}
                >
                  {ann.status}
                </span>
              </div>
              <div style={{ color: "var(--ink-secondary)", lineHeight: "var(--leading-normal)" }}>{ann.comment}</div>
              {ann.linkedTaskId && (
                <span className="mono-tag" style={{ fontSize: "var(--text-2xs)" }}>
                  Task: {ann.linkedTaskId}
                </span>
              )}
              {ann.status !== "approved" && (
                <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                  <button
                    className="btn sm primary"
                    style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      resolveAnnotation(ann.id, "approved");
                    }}
                  >
                    <Check size={12} strokeWidth={1.6} /> Freigeben
                  </button>
                  {ann.status === "resolved_pending_review" && (
                    <button
                      className="btn sm"
                      style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        resolveAnnotation(ann.id, "open");
                      }}
                    >
                      <RotateCcw size={12} strokeWidth={1.6} /> Nachbessern
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Quick-open popover building blocks
   --------------------------------------------------------------------------- */

function QuickGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="iab-quickgroup" style={{ marginBottom: 4 }}>
      <div
        style={{
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-wide)",
          textTransform: "uppercase",
          color: "var(--ink-faint)",
          padding: "6px 8px 4px",
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
      className="iab-quickitem"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        textAlign: "left",
        padding: "6px 8px",
        border: "none",
        background: "transparent",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-xs)",
        color: "var(--ink-primary)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <span style={{ flexShrink: 0, display: "inline-flex" }}>{icon}</span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
  return (
    <div style={{ padding: "4px 8px", color: "var(--ink-faint)", fontSize: "var(--text-2xs)" }}>{text}</div>
  );
}

function PinCommentGlyph() {
  return <MessageSquare size={13} strokeWidth={1.6} color="var(--ink-secondary)" />;
}

/* ---------------------------------------------------------------------------
   DOC VIEWER — fetches artifact markdown, renders formatted HTML blocks
   --------------------------------------------------------------------------- */

function DocViewer({
  projectId,
  filePath,
  annotate,
  annotations,
  onPickAnchor,
}: {
  projectId: string;
  filePath: string;
  annotate: boolean;
  annotations: AnnotationRecord[];
  onPickAnchor: (anchor: AnnotationAnchor) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const artifactUrl = `/api/projects/${encodeURIComponent(projectId)}/artifact?path=${encodeURIComponent(filePath)}`;

  useEffect(() => {
    let alive = true;
    setText(null);
    setError(null);
    fetch(artifactUrl)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((t) => {
        if (alive) setText(t);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [artifactUrl]);

  const blocks = useMemo(() => (text === null ? [] : parseMdBlocks(text)), [text]);

  return (
    <div className="iab-doc-stage doc-stage" style={{ height: "100%", overflowY: "auto", padding: "24px 32px 48px" }}>
      {error && (
        <div
          className="iab-error-banner"
          style={{
            padding: "10px 14px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--status-danger-border)",
            background: "var(--status-danger-bg)",
            color: "var(--status-danger-ink)",
            fontSize: "var(--text-sm)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <FileWarning size={14} strokeWidth={1.6} /> Dokument konnte nicht geladen werden ({error})
        </div>
      )}
      {text === null && !error && (
        <div style={{ color: "var(--ink-muted)", fontSize: "var(--text-sm)" }}>Lade Dokument…</div>
      )}
      <div style={{ maxWidth: "var(--measure-prose)", margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
        {blocks.map((b) => {
          const pinned = annotations.some(
            (a) => a.anchor.kind === "doc" && (a.anchor.blockId === b.blockId || a.anchor.contentHash === b.contentHash),
          );
          return (
            <div
              key={b.blockId}
              data-block-id={b.blockId}
              className={`doc-block iab-doc-block ${annotate ? "annotatable" : ""} ${pinned ? "has-pin" : ""}`}
              onClick={() => {
                if (!annotate) return;
                onPickAnchor({
                  kind: "doc",
                  filePath,
                  blockId: b.blockId,
                  contentHash: b.contentHash,
                  quote: b.text.slice(0, 140),
                });
              }}
              style={{
                borderRadius: "var(--radius-sm)",
                padding: annotate ? "4px 8px" : "4px 0",
                margin: annotate ? "-4px -8px" : 0,
                cursor: annotate ? "crosshair" : "default",
                outline: pinned ? "1px solid var(--status-active-border)" : "1px solid transparent",
                outlineOffset: 1,
                background: pinned ? "var(--status-active-bg)" : "transparent",
                transition: "background var(--duration-fast) var(--ease-out-quiet)",
              }}
            >
              <MarkdownBlockBody text={b.text} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   IMAGE VIEWER — light studio stage, pin click + drag-rect annotations
   --------------------------------------------------------------------------- */

function ImageViewer({
  projectId,
  filePath,
  annotate,
  annotations,
  onPickAnchor,
}: {
  projectId: string;
  filePath: string;
  annotate: boolean;
  annotations: AnnotationRecord[];
  onPickAnchor: (anchor: AnnotationAnchor) => void;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [draftRect, setDraftRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [loadError, setLoadError] = useState(false);

  const artifactUrl = `/api/projects/${encodeURIComponent(projectId)}/artifact?path=${encodeURIComponent(filePath)}`;

  const norm = (clientX: number, clientY: number) => {
    const img = imgRef.current;
    if (!img) return { x: 0, y: 0 };
    const rect = img.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  };

  const rectInPx = (r: { x: number; y: number; w: number; h: number }) => {
    const img = imgRef.current;
    if (!img) return { left: 0, top: 0, width: 0, height: 0 };
    const b = img.getBoundingClientRect();
    return { left: r.x * b.width, top: r.y * b.height, width: r.w * b.width, height: r.h * b.height };
  };

  return (
    <div
      className="iab-image-stage"
      style={{
        height: "100%",
        overflowY: "auto",
        background: "#F5F5F5",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      {annotate && (
        <div
          className="iab-stage-hint"
          style={{
            position: "sticky",
            top: 10,
            zIndex: 5,
            alignSelf: "center",
            marginTop: 10,
            padding: "4px 12px",
            borderRadius: "var(--radius-pill)",
            background: "rgba(255,255,255,0.9)",
            border: "1px solid var(--border-hairline)",
            color: "var(--ink-muted)",
            fontSize: "var(--text-2xs)",
            pointerEvents: "none",
          }}
        >
          Ziehe einen Bereich auf oder klicke zum Kommentieren
        </div>
      )}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, width: "100%" }}>
        {loadError ? (
          <div style={{ color: "var(--ink-muted)", fontSize: "var(--text-sm)", display: "flex", alignItems: "center", gap: 8 }}>
            <FileWarning size={14} strokeWidth={1.6} /> Bild konnte nicht geladen werden
          </div>
        ) : (
          <div
            className="img-stage iab-img-stage"
            style={{
              position: "relative",
              display: "inline-block",
              width: filePath.toLowerCase().endsWith(".svg") ? "min(100%, 720px)" : undefined,
              maxWidth: "100%",
              cursor: annotate ? "crosshair" : "grab",
              touchAction: "none",
            }}
            onPointerDown={(e) => {
              if (!annotate || e.button !== 0) return;
              startRef.current = norm(e.clientX, e.clientY);
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const start = startRef.current;
              if (!start || !imgRef.current) return;
              const cur = norm(e.clientX, e.clientY);
              const b = imgRef.current.getBoundingClientRect();
              const dx = Math.abs(cur.x - start.x) * b.width;
              const dy = Math.abs(cur.y - start.y) * b.height;
              if (dx > 12 || dy > 12) {
                setDraftRect({
                  x: Math.min(start.x, cur.x),
                  y: Math.min(start.y, cur.y),
                  w: Math.abs(cur.x - start.x),
                  h: Math.abs(cur.y - start.y),
                });
              }
            }}
            onPointerUp={(e) => {
              const start = startRef.current;
              startRef.current = null;
              if (!start || !annotate) {
                setDraftRect(null);
                return;
              }
              if (draftRect && draftRect.w > 0.005 && draftRect.h > 0.005) {
                onPickAnchor({ kind: "image", filePath, rect: draftRect });
              } else {
                const p = norm(e.clientX, e.clientY);
                onPickAnchor({ kind: "image", filePath, pin: p });
              }
              setDraftRect(null);
            }}
            onPointerCancel={() => {
              startRef.current = null;
              setDraftRect(null);
            }}
          >
            <img
              ref={imgRef}
              src={artifactUrl}
              alt={filePath}
              draggable={false}
              onError={() => setLoadError(true)}
              style={{
                display: "block",
                width: filePath.toLowerCase().endsWith(".svg") ? "100%" : "auto",
                height: "auto",
                maxWidth: "100%",
                maxHeight: "calc(100vh - 180px)",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-hairline)",
                background: "#FFFFFF",
                userSelect: "none",
              }}
            />
            {/* Existing pin markers */}
            {annotations.map((ann, idx) => {
              if (ann.anchor.kind !== "image") return null;
              if (ann.anchor.pin) {
                return (
                  <div
                    key={ann.id}
                    className="pin-marker iab-pin-marker"
                    title={ann.comment}
                    style={{
                      position: "absolute",
                      left: `${ann.anchor.pin.x * 100}%`,
                      top: `${ann.anchor.pin.y * 100}%`,
                      transform: "translate(-50%, -50%)",
                      width: 18,
                      height: 18,
                      borderRadius: "50%",
                      background: "var(--stage-3d-pin-bg)",
                      color: "var(--stage-3d-pin-fg)",
                      fontSize: 10,
                      fontWeight: "var(--weight-semibold)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: "0 0 0 2px rgba(255,255,255,0.85)",
                      pointerEvents: "none",
                    }}
                  >
                    {idx + 1}
                  </div>
                );
              }
              if (ann.anchor.rect) {
                const px = rectInPx(ann.anchor.rect);
                return (
                  <div
                    key={ann.id}
                    className="iab-rect-marker"
                    title={ann.comment}
                    style={{
                      position: "absolute",
                      left: px.left,
                      top: px.top,
                      width: px.width,
                      height: px.height,
                      border: "1.5px solid var(--ink-primary)",
                      borderRadius: 3,
                      background: "rgba(23,23,23,0.05)",
                      pointerEvents: "none",
                    }}
                  />
                );
              }
              return null;
            })}
            {/* In-progress drag rectangle */}
            {draftRect &&
              (() => {
                const px = rectInPx(draftRect);
                return (
                  <div
                    className="iab-rect-draft"
                    style={{
                      position: "absolute",
                      left: px.left,
                      top: px.top,
                      width: px.width,
                      height: px.height,
                      border: "1.5px dashed var(--ink-primary)",
                      borderRadius: 3,
                      background: "rgba(23,23,23,0.07)",
                      pointerEvents: "none",
                    }}
                  />
                );
              })()}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   MODEL 3D VIEWER — Light Museum Studio (ported from PreviewStudio)
   --------------------------------------------------------------------------- */

const CAMERA_PRESETS: Record<string, { pos: [number, number, number]; target: [number, number, number] }> = {
  Iso: { pos: [4.8, 3.8, 5.8], target: [0, 1.15, 0] },
  Front: { pos: [0, 1.6, 6.4], target: [0, 1.15, 0] },
  Top: { pos: [0.001, 7.6, 0.001], target: [0, 1.0, 0] },
};

function Model3DViewer({
  projectId,
  filePath,
  annotate,
  annotations,
  focusCameraPose,
  onPickAnchor,
}: {
  projectId: string;
  filePath: string;
  annotate: boolean;
  annotations: AnnotationRecord[];
  focusCameraPose: { pos: [number, number, number]; target: [number, number, number] } | null;
  onPickAnchor: (anchor: AnnotationAnchor, snapshotDataUrl?: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const annotateRef = useRef(annotate);
  const onPickRef = useRef(onPickAnchor);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pinsGroupRef = useRef<THREE.Group | null>(null);
  const pinAssetsRef = useRef<{ geo: THREE.SphereGeometry; mat: THREE.MeshBasicMaterial } | null>(null);
  const [loadStatus, setLoadStatus] = useState("Lade 3D-Asset…");
  const [activePreset, setActivePreset] = useState<string>("Iso");

  annotateRef.current = annotate;
  onPickRef.current = onPickAnchor;

  const artifactUrl = `/api/projects/${encodeURIComponent(projectId)}/artifact?path=${encodeURIComponent(filePath)}`;

  const applyPreset = (name: string) => {
    const preset = CAMERA_PRESETS[name];
    if (!preset || !cameraRef.current || !controlsRef.current) return;
    cameraRef.current.position.set(...preset.pos);
    controlsRef.current.target.set(...preset.target);
    controlsRef.current.update();
    setActivePreset(name);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f5f5);

    const width = Math.max(host.clientWidth, 320);
    const height = Math.max(host.clientHeight, 360);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 200);
    camera.position.set(...CAMERA_PRESETS.Iso!.pos);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.innerHTML = "";
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(...CAMERA_PRESETS.Iso!.target);
    controlsRef.current = controls;

    // Neutral museum studio daylight (Light-Mode Harmony)
    scene.add(new THREE.HemisphereLight(0xffffff, 0xe5e5e8, 1.15));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.25);
    keyLight.position.set(4, 7, 5);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xeef2f7, 0.55);
    fillLight.position.set(-4, 4, -3);
    scene.add(fillLight);
    scene.add(new THREE.GridHelper(8, 16, 0xd4d4d8, 0xe6e6ea));

    const modelGroup = new THREE.Group();
    scene.add(modelGroup);
    const pinsGroup = new THREE.Group();
    scene.add(pinsGroup);
    pinsGroupRef.current = pinsGroup;

    // Shared GPU resources for 3D annotation pins (reused across updates, disposed on unmount)
    const pinGeo = new THREE.SphereGeometry(0.065, 16, 16);
    const pinMat = new THREE.MeshBasicMaterial({ color: 0x171717, depthTest: false });
    pinAssetsRef.current = { geo: pinGeo, mat: pinMat };

    const loader = new GLTFLoader();
    loader.load(
      artifactUrl,
      (gltf) => {
        if (cancelled) {
          disposeObjectTree(gltf.scene);
          return;
        }
        modelGroup.add(gltf.scene);
        // Auto-frame loaded GLB cleanly inside museum viewport
        const box = new THREE.Box3().setFromObject(gltf.scene);
        if (!box.isEmpty()) {
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z, 1);
          const dist = maxDim * 2.15;
          camera.position.set(center.x + dist * 0.72, center.y + dist * 0.56, center.z + dist * 0.88);
          controls.target.copy(center);
          controls.update();
        }
        setLoadStatus(`GLB geladen (${filePath})`);
      },
      undefined,
      () => {
        if (cancelled) return;
        const fallback = new THREE.Mesh(
          new THREE.BoxGeometry(1.2, 1.8, 1.2),
          new THREE.MeshStandardMaterial({ color: 0x525252, metalness: 0.15, roughness: 0.55 }),
        );
        fallback.name = "FallbackMonolith";
        fallback.position.y = 0.9;
        modelGroup.add(fallback);
        setLoadStatus("Fallback-Mesh aktiv");
      },
    );

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downPos: { x: number; y: number } | null = null;

    const handlePointerDown = (ev: PointerEvent) => {
      downPos = { x: ev.clientX, y: ev.clientY };
    };

    const handleClick = (ev: MouseEvent) => {
      if (!annotateRef.current) return;
      if (downPos) {
        const moved = Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y);
        if (moved > 6) return; // was an orbit drag, not a click
      }
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(modelGroup.children, true);
      if (hits.length === 0) return;

      const hit = hits[0]!;
      const normal = hit.face?.normal
        ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
        : new THREE.Vector3(0, 1, 0);

      renderer.render(scene, camera);
      let snapshotDataUrl: string | undefined;
      try {
        snapshotDataUrl = renderer.domElement.toDataURL("image/png");
      } catch {
        snapshotDataUrl = undefined;
      }

      onPickRef.current(
        {
          kind: "model_3d",
          filePath,
          meshName: hit.object.name || "Mesh",
          point: [hit.point.x, hit.point.y, hit.point.z],
          normal: [normal.x, normal.y, normal.z],
          camera: {
            pos: [camera.position.x, camera.position.y, camera.position.z],
            target: [controls.target.x, controls.target.y, controls.target.z],
            fov: camera.fov,
          },
        },
        snapshotDataUrl,
      );
    };

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("click", handleClick);

    const resizeObserver = new ResizeObserver(() => {
      const w = Math.max(host.clientWidth, 320);
      const h = Math.max(host.clientHeight, 360);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(host);

    let rafId = 0;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("click", handleClick);
      controls.dispose();
      disposeObjectTree(scene);
      pinGeo.dispose();
      pinMat.dispose();
      pinAssetsRef.current = null;
      pinsGroupRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      renderer.dispose();
      renderer.forceContextLoss();
    };
  }, [artifactUrl, filePath]);

  useEffect(() => {
    const group = pinsGroupRef.current;
    const assets = pinAssetsRef.current;
    if (!group || !assets) return;
    while (group.children.length > 0) {
      group.remove(group.children[0]!);
    }
    for (const ann of annotations) {
      if (ann.anchor.kind !== "model_3d") continue;
      const [px, py, pz] = ann.anchor.point;
      const [nx, ny, nz] = ann.anchor.normal;
      const pin = new THREE.Mesh(assets.geo, assets.mat);
      pin.position.set(px + nx * 0.08, py + ny * 0.08, pz + nz * 0.08);
      pin.renderOrder = 999;
      group.add(pin);
    }
  }, [annotations, artifactUrl]);

  useEffect(() => {
    if (!focusCameraPose || !cameraRef.current || !controlsRef.current) return;
    cameraRef.current.position.set(...focusCameraPose.pos);
    controlsRef.current.target.set(...focusCameraPose.target);
    controlsRef.current.update();
    setActivePreset("");
  }, [focusCameraPose]);

  return (
    <div className="iab-3d-stage" style={{ position: "relative", width: "100%", height: "100%", minHeight: 320 }}>
      <div
        ref={hostRef}
        style={{ width: "100%", height: "100%", cursor: annotate ? "crosshair" : "grab" }}
      />
      {/* Camera preset pills — compact top-right */}
      <div
        className="iab-camera-presets"
        style={{
          position: "absolute",
          top: 10,
          right: 10,
          display: "flex",
          gap: 4,
          zIndex: 5,
        }}
      >
        {Object.keys(CAMERA_PRESETS).map((name) => (
          <button
            key={name}
            className={`iab-preset-pill ${activePreset === name ? "active" : ""}`}
            onClick={() => applyPreset(name)}
            style={{
              padding: "3px 10px",
              fontSize: "var(--text-2xs)",
              fontFamily: "var(--font-sans)",
              fontWeight: activePreset === name ? "var(--weight-semibold)" : "var(--weight-regular)",
              color: activePreset === name ? "var(--ink-primary)" : "var(--ink-secondary)",
              background: activePreset === name ? "#FFFFFF" : "rgba(255,255,255,0.72)",
              border: "1px solid var(--border-hairline)",
              borderRadius: "var(--radius-pill)",
              cursor: "pointer",
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        className="stage-3d-hud iab-3d-hud"
        style={{
          position: "absolute",
          left: 10,
          bottom: 10,
          fontSize: "var(--text-2xs)",
          color: "var(--ink-muted)",
          background: "rgba(255,255,255,0.72)",
          border: "1px solid var(--border-hairline)",
          borderRadius: "var(--radius-pill)",
          padding: "3px 10px",
          pointerEvents: "none",
        }}
      >
        {loadStatus} ·{" "}
        {annotate ? "Annotate (Klick auf 3D-Mesh setzt Pin + Kamera-Snapshot)" : "Navigate (Orbit/Zoom)"}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   CODE VIEWER — /file endpoint, line numbers, light syntax tint
   --------------------------------------------------------------------------- */

interface RepoFileContent {
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
}

function CodeViewer({
  projectId,
  agentId,
  filePath,
}: {
  projectId: string;
  agentId: string | null;
  filePath: string;
}) {
  const [file, setFile] = useState<RepoFileContent | null>(null);
  const [error, setError] = useState<{ code: number; message: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const fileUrl =
    `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(filePath)}` +
    (agentId ? `&agentId=${encodeURIComponent(agentId)}` : "");

  useEffect(() => {
    let alive = true;
    setFile(null);
    setError(null);
    fetch(fileUrl)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => "");
          throw { code: r.status, message: body || `HTTP ${r.status}` } as { code: number; message: string };
        }
        return (await r.json()) as RepoFileContent;
      })
      .then((data) => {
        if (alive) setFile(data);
      })
      .catch((err: { code?: number; message?: string }) => {
        if (alive) setError({ code: err.code ?? 0, message: err.message ?? "Unbekannter Fehler" });
      });
    return () => {
      alive = false;
    };
  }, [fileUrl]);

  const lines = useMemo(() => (file ? file.content.split("\n") : []), [file]);

  const copyContent = async () => {
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="iab-code-stage" style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div
        className="iab-code-meta"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-surface)",
          fontSize: "var(--text-2xs)",
          color: "var(--ink-muted)",
          flexShrink: 0,
        }}
      >
        <FileCode2 size={12} strokeWidth={1.6} />
        <span className="mono-tag" style={{ overflowWrap: "anywhere" }}>{filePath}</span>
        {file && <span className="mono-tag">{formatBytes(file.sizeBytes)}</span>}
        {file?.truncated && <span className="pill warning" style={{ fontSize: "var(--text-2xs)" }}>truncated</span>}
        <span style={{ flex: 1 }} />
        <button
          className="iab-copy-btn"
          onClick={() => void copyContent()}
          disabled={!file}
          title="Dateiinhalt kopieren"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            border: "1px solid var(--border-hairline)",
            background: "#FFFFFF",
            borderRadius: "var(--radius-sm)",
            padding: "2px 8px",
            fontSize: "var(--text-2xs)",
            fontFamily: "var(--font-sans)",
            color: "var(--ink-secondary)",
            cursor: file ? "pointer" : "default",
          }}
        >
          {copied ? <Check size={11} strokeWidth={1.8} /> : <Copy size={11} strokeWidth={1.6} />}
          {copied ? "Kopiert" : "Kopieren"}
        </button>
      </div>

      {error && (
        <div
          className="iab-error-banner"
          style={{
            margin: 14,
            padding: "10px 14px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--status-danger-border)",
            background: "var(--status-danger-bg)",
            color: "var(--status-danger-ink)",
            fontSize: "var(--text-sm)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <ShieldAlert size={14} strokeWidth={1.6} />
          {error.code === 403
            ? "Zugriff verweigert — diese Datei liegt außerhalb des erlaubten Bereichs."
            : error.code === 415
              ? "Binärdatei kann nicht als Code angezeigt werden."
              : error.code === 413
                ? "Datei ist zu groß für die Vorschau."
                : error.code === 404
                  ? "Datei wurde nicht gefunden."
                  : `Datei konnte nicht geladen werden (${error.message})`}
        </div>
      )}

      {!file && !error && (
        <div style={{ padding: 16, color: "var(--ink-muted)", fontSize: "var(--text-sm)" }}>Lade Datei…</div>
      )}

      {file && (
        <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
          <pre
            className="iab-code-pre"
            style={{
              margin: 0,
              padding: "10px 0",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              lineHeight: 1.6,
              color: "var(--ink-primary)",
              counterReset: "line",
            }}
          >
            {lines.map((line, i) => (
              <div key={i} className="iab-code-line" style={{ display: "flex", minHeight: "1.6em" }}>
                <span
                  className="iab-code-linenum"
                  aria-hidden
                  style={{
                    width: 44,
                    flexShrink: 0,
                    textAlign: "right",
                    paddingRight: 12,
                    color: "var(--ink-faint)",
                    userSelect: "none",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {i + 1}
                </span>
                <code style={{ whiteSpace: "pre", flex: 1, paddingRight: 16 }}>
                  {line.length === 0
                    ? " "
                    : tokenizeCodeLine(line).map((tok, j) =>
                        tok.cls ? (
                          <span key={j} style={CODE_TOKEN_STYLE[tok.cls]}>
                            {tok.text}
                          </span>
                        ) : (
                          <span key={j}>{tok.text}</span>
                        ),
                      )}
                </code>
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   DIFF VIEWER — workspace git diff, collapsible per-file patches
   --------------------------------------------------------------------------- */

function DiffViewer({
  gitDiff,
  onRefreshDiff,
}: {
  gitDiff: GitDiffResponse | null;
  onRefreshDiff: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const statusLabel: Record<string, string> = {
    modified: "M",
    added: "A",
    deleted: "D",
    untracked: "U",
    renamed: "R",
  };

  return (
    <div className="iab-diff-stage" style={{ height: "100%", overflowY: "auto", background: "#FFFFFF" }}>
      <div
        className="iab-diff-meta"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 2,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 14px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-surface)",
          fontSize: "var(--text-xs)",
          color: "var(--ink-secondary)",
        }}
      >
        <GitCompareArrows size={13} strokeWidth={1.6} />
        {gitDiff ? (
          <>
            <span className="mono-tag" style={{ fontWeight: "var(--weight-semibold)", color: "var(--ink-primary)" }}>
              {gitDiff.branch}
            </span>
            <span>
              {gitDiff.filesChanged} {gitDiff.filesChanged === 1 ? "file" : "files"} changed
            </span>
            <span style={{ color: "#166534" }}>+{gitDiff.insertions}</span>
            <span style={{ color: "#9E2626" }}>−{gitDiff.deletions}</span>
          </>
        ) : (
          <span style={{ color: "var(--ink-muted)" }}>Kein Diff geladen</span>
        )}
        <span style={{ flex: 1 }} />
        <button
          className="btn sm"
          onClick={onRefreshDiff}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--text-2xs)" }}
        >
          <RefreshCw size={11} strokeWidth={1.6} /> Refresh
        </button>
      </div>

      {gitDiff && gitDiff.files.length === 0 && (
        <div style={{ padding: 24, color: "var(--ink-muted)", fontSize: "var(--text-sm)", textAlign: "center" }}>
          Arbeitsbereich ist sauber — keine Änderungen gegenüber HEAD.
        </div>
      )}

      {gitDiff?.files.map((f) => {
        const isCollapsed = collapsed.has(f.path);
        return (
          <div key={f.path} className="iab-diff-file" style={{ borderBottom: "1px solid var(--border-hairline)" }}>
            <button
              className="iab-diff-file-head"
              onClick={() => toggle(f.path)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                textAlign: "left",
                padding: "7px 14px",
                border: "none",
                background: "#FAFAFA",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--ink-primary)",
              }}
            >
              <ChevronDown
                size={12}
                strokeWidth={1.8}
                style={{
                  transform: isCollapsed ? "rotate(-90deg)" : "none",
                  transition: "transform var(--duration-fast) var(--ease-out-quiet)",
                  color: "var(--ink-muted)",
                }}
              />
              <span
                className="mono-tag"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: f.status === "added" || f.status === "untracked" ? "#166534" : f.status === "deleted" ? "#9E2626" : "var(--ink-secondary)",
                }}
              >
                {statusLabel[f.status] ?? f.status}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
              <span style={{ flex: 1 }} />
              <span style={{ color: "#166534", fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)" }}>+{f.added}</span>
              <span style={{ color: "#9E2626", fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)" }}>−{f.removed}</span>
            </button>
            {!isCollapsed && f.patch && (
              <pre
                className="iab-diff-patch"
                style={{
                  margin: 0,
                  padding: "6px 0",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-2xs)",
                  lineHeight: 1.55,
                  overflowX: "auto",
                }}
              >
                {f.patch.split("\n").map((line, i) => {
                  const isAdd = line.startsWith("+") && !line.startsWith("+++");
                  const isDel = line.startsWith("-") && !line.startsWith("---");
                  const isHunk = line.startsWith("@@");
                  const isMeta = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ");
                  return (
                    <div
                      key={i}
                      className={`iab-diff-line ${isAdd ? "add" : isDel ? "del" : isHunk ? "hunk" : ""}`}
                      style={{
                        padding: "0 14px",
                        whiteSpace: "pre",
                        background: isAdd ? "#F0FDF4" : isDel ? "#FEF2F2" : isHunk ? "var(--status-active-bg)" : "transparent",
                        color: isAdd ? "#166534" : isDel ? "#9E2626" : isHunk ? "var(--status-active-ink)" : isMeta ? "var(--ink-faint)" : "var(--ink-secondary)",
                      }}
                    >
                      {line.length === 0 ? " " : line}
                    </div>
                  );
                })}
              </pre>
            )}
            {!isCollapsed && !f.patch && (
              <div style={{ padding: "8px 14px", color: "var(--ink-faint)", fontSize: "var(--text-2xs)" }}>
                Keine Text-Patch-Vorschau (binär oder zu groß).
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   WEB VIEWER — loopback-only sandboxed iframe
   --------------------------------------------------------------------------- */

function WebViewer({ url }: { url: string }) {
  const allowed = isAllowedWebUrl(url);

  if (!allowed) {
    return (
      <div
        className="iab-web-blocked"
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          padding: 32,
          textAlign: "center",
        }}
      >
        <ShieldAlert size={22} strokeWidth={1.4} color="var(--status-warning-ink)" />
        <div
          style={{
            maxWidth: 420,
            padding: "12px 16px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--status-warning-border)",
            background: "var(--status-warning-bg)",
            color: "var(--status-warning-ink)",
            fontSize: "var(--text-sm)",
            lineHeight: "var(--leading-normal)",
          }}
        >
          Nur lokale Loopback-Adressen werden im In-App-Browser geöffnet (<code>http://127.0.0.1:…</code>,{" "}
          <code>http://localhost:…</code>). Die Adresse <code style={{ overflowWrap: "anywhere" }}>{url}</code> wurde
          blockiert.
        </div>
      </div>
    );
  }

  return (
    <iframe
      className="iab-web-frame"
      title={url}
      src={url}
      sandbox="allow-scripts allow-forms allow-same-origin"
      style={{ width: "100%", height: "100%", border: "none", display: "block", background: "#FFFFFF" }}
    />
  );
}
