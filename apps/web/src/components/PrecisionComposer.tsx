import type { GitDiffResponse, ProjectRecord } from "@bot-factory/shared";
import { Box, ChevronDown, FileText, FolderGit2, Image as ImageIcon, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useId, type JSX } from "react";
import type { ComposerAttachment } from "../browser/types";
import type { ProviderSummary } from "../client/useBotFactory";
import {
  AutonomyBarsIcon,
  BrowserPaneIcon,
  DiffBranchIcon,
  SendArrowIcon,
  SlashKeyIcon,
} from "./BotFactoryIcons";
import { ReasoningEffortControl, type ReasoningEffort } from "./ReasoningEffortSlider";
import "./PrecisionComposer.css";

export type { ComposerAttachment };

export type AutonomyLevel = "spec" | "low" | "medium" | "high";

export interface ModelTargetSelection {
  provider: string;
  model: string;
}

export interface PrecisionComposerProps {
  mode: "chat" | "steer";
  placeholder: string;
  busy?: boolean;
  disabled?: boolean;
  activeProject: ProjectRecord | null;
  projects: ProjectRecord[];
  onSelectProject?: (projectId: string) => void;
  activeModelLabel: string;
  providers?: ProviderSummary[];
  selectedTarget?: ModelTargetSelection | null;
  onSelectTarget?: (target: ModelTargetSelection) => void;
  contextPercent?: number;
  contextTooltip?: string;
  gitDiff: GitDiffResponse | null;
  showDiffTray?: boolean;
  onViewDiff?: () => void;
  onQuickReview?: () => void;
  onOpenBrowser?: () => void;
  effort: ReasoningEffort;
  onChangeEffort: (v: ReasoningEffort) => void;
  autonomy: AutonomyLevel;
  onChangeAutonomy: (v: AutonomyLevel) => void;
  attachments?: ComposerAttachment[];
  onRemoveAttachment?: (id: string) => void;
  onClearAttachments?: (sent: ComposerAttachment[]) => void;
  draft?: string;
  onDraftChange?: (text: string) => void;
  onSubmit: (text: string) => Promise<void>;
  onSlashAction?: (command: string) => void;
}

const SLASH_COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: "/goal", desc: "Set the goal, then describe the outcome" },
  { cmd: "/plan", desc: "Draft an implementation plan first" },
  { cmd: "/verify", desc: "Run fresh cross-family verification" },
  { cmd: "/preview", desc: "Open project preview in In-App Browser" },
  { cmd: "/spawn-bot", desc: "Spawn a new peer bot in the team" },
  { cmd: "/diff", desc: "Inspect current Git diff" },
];

const AUTONOMY_OPTIONS: { value: AutonomyLevel; label: string; desc: string }[] = [
  { value: "spec", label: "Spec", desc: "Plan and specify only — no tool execution." },
  { value: "low", label: "Low", desc: "Ask before executing side-effect tools." },
  { value: "medium", label: "Medium", desc: "Scoped edits; confirm destructive actions." },
  { value: "high", label: "High", desc: "Full autonomous speed; review diff after." },
];

const AUTONOMY_LABEL: Record<AutonomyLevel, string> = {
  spec: "Spec",
  low: "Low",
  medium: "Medium",
  high: "High",
};

const COMPOSER_MIN_H = 56;
const COMPOSER_MAX_H = 300;

function formatRuntimeLabel(runtime: string): string {
  if (runtime === "native_http") return "API";
  if (runtime === "acp_stdio") return "ACP";
  if (runtime === "cli_stream") return "CLI";
  return runtime.replaceAll("_", " ").toUpperCase();
}

function formatProviderLabel(provider: string): string {
  return provider
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function ProviderLogo({ provider, size = 18 }: { provider: string; size?: number }): JSX.Element {
  const gradientId = useId().replace(/:/g, "");
  const key = provider.toLowerCase();
  const label = formatProviderLabel(provider);
  let mark: JSX.Element;
  if (key.includes("mistral")) {
    mark = (
      <>
        <rect x="4" y="4" width="16" height="3" rx="1.5" fill="#ff9d42" />
        <rect x="6" y="9" width="12" height="3" rx="1.5" fill="#ff5f45" />
        <rect x="8" y="14" width="8" height="3" rx="1.5" fill="#d93662" />
      </>
    );
  } else if (key.includes("google") || key.includes("gemini")) {
    mark = (
      <path d="M12 3 L14 10 L21 12 L14 14 L12 21 L10 14 L3 12 L10 10 Z" fill={`url(#${gradientId})`} />
    );
  } else if (key.includes("anthropic") || key.includes("claude")) {
    mark = <path d="M5 18 L12 5 L19 18 H15.7 L12 10.8 L8.3 18 Z" fill="#f4b183" />;
  } else if (key.includes("openai")) {
    mark = (
      <g fill="none" stroke="#d8f3ff" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="7" />
        <path d="M12 5 V19 M5 12 H19 M7 7 L17 17 M17 7 L7 17" opacity="0.58" />
      </g>
    );
  } else if (key.includes("devin") || key.includes("acp")) {
    mark = (
      <>
        <path d="M12 3 L19 7 V17 L12 21 L5 17 V7 Z" fill="#8fd8ff" opacity="0.92" />
        <path d="M9 8 H12.3 A4.2 4.2 0 0 1 12.3 16 H9 Z" fill="#06101a" />
      </>
    );
  } else {
    const initials = label.split(" ").map((part) => part.charAt(0)).join("").slice(0, 2).toUpperCase();
    mark = <text x="12" y="15" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="#dff6ff">{initials}</text>;
  }
  return (
    <svg className="pc-provider-logo" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={`${label} provider`}>
      <defs>
        <linearGradient id={gradientId} x1="4" y1="4" x2="20" y2="20">
          <stop offset="0" stopColor="#8fd8ff" />
          <stop offset="1" stopColor="#b99cff" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="rgba(125, 211, 252, 0.1)" stroke="rgba(191, 232, 255, 0.24)" />
      {mark}
    </svg>
  );
}

type PopKind = "slash" | "autonomy" | "project" | "attach" | "model" | null;

function formatComposerSubmission(text: string, attachments?: ComposerAttachment[]): string {
  const trimmed = text.trim();
  if (!attachments || attachments.length === 0) return trimmed;

  const blocks = attachments.map((att) => {
    const heading =
      att.kind === "doc_comment"
        ? `**Doc Comment** (\`${att.filePath}\`)`
        : att.kind === "image_comment"
          ? `**Image Review** (\`${att.filePath}\`)`
          : `**3D Model Review** (\`${att.filePath}\`)`;
    const parts = [heading];
    if (att.region) {
      parts.push(
        `Region: (${(att.region.x * 100).toFixed(0)}%, ${(att.region.y * 100).toFixed(0)}%, ${(att.region.w * 100).toFixed(0)}% x ${(att.region.h * 100).toFixed(0)}%)`,
      );
    }
    if (att.quote) {
      const quoted = att.quote
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join("\n");
      parts.push(quoted);
    }
    if (att.comment) {
      parts.push(att.comment);
    }
    return parts.join("\n");
  });

  const attachmentSection = blocks.join("\n\n");
  return trimmed ? `${attachmentSection}\n\n${trimmed}` : attachmentSection;
}

function ContextRingGauge({ percent, tooltip }: { percent: number; tooltip?: string }): JSX.Element {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const r = 6;
  const c = 2 * Math.PI * r;
  const offset = c - (clamped / 100) * c;
  const strokeColor =
    clamped >= 85
      ? "var(--accent-orange, #D95D22)"
      : clamped >= 65
        ? "var(--status-warning-ink, #8A530B)"
        : "var(--ink-primary, #171717)";

  return (
    <span
      className="pc-context-ring"
      title={tooltip ?? `L1 Memory & Context budget: ${clamped}%`}
      aria-label={tooltip ?? `Context usage ${clamped}%`}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r={r} fill="none" stroke="var(--border-hairline, #E5E5E7)" strokeWidth="2" />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke={strokeColor}
          strokeWidth="2"
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 8 8)"
        />
      </svg>
      <span>{clamped}%</span>
    </span>
  );
}

export function PrecisionComposer({
  mode,
  placeholder,
  busy,
  disabled,
  activeProject,
  projects,
  onSelectProject,
  activeModelLabel,
  providers,
  selectedTarget,
  onSelectTarget,
  contextPercent = 18,
  contextTooltip,
  gitDiff,
  showDiffTray,
  onViewDiff,
  onOpenBrowser,
  effort,
  onChangeEffort,
  autonomy,
  onChangeAutonomy,
  attachments,
  onRemoveAttachment,
  onClearAttachments,
  draft,
  onDraftChange,
  onSubmit,
  onSlashAction,
}: PrecisionComposerProps): JSX.Element {
  const [localText, setLocalText] = useState("");
  const text = draft ?? localText;
  const setText = onDraftChange ?? setLocalText;
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [openPop, setOpenPop] = useState<PopKind>(null);
  const [focusedSlashIdx, setFocusedSlashIdx] = useState(0);
  const [trayDismissed, setTrayDismissed] = useState(false);
  const [manualHeight, setManualHeight] = useState<number | null>(null);
  const [resizingHeight, setResizingHeight] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [focusedModelIdx, setFocusedModelIdx] = useState(0);
  const modelPickerId = useId().replace(/:/g, "");
  const modelListId = `${modelPickerId}-list`;

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const modelButtonRef = useRef<HTMLButtonElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  const isBusy = Boolean(busy) || sending;
  const isDisabled = Boolean(disabled);
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  const canSend = !isDisabled && !isBusy && (text.trim().length > 0 || hasAttachments);

  const diffHash = `${activeProject?.id ?? "none"}:${gitDiff?.branch ?? ""}:${gitDiff?.filesChanged ?? 0}:${gitDiff?.insertions ?? 0}:${gitDiff?.deletions ?? 0}`;
  useEffect(() => {
    setTrayDismissed(false);
  }, [diffHash]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (manualHeight !== null) {
      el.style.height = `${manualHeight}px`;
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text, manualHeight]);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!openPop) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenPop(null);
    };
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenPop(null);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onDocKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onDocKey);
    };
  }, [openPop]);

  const modelChoices = useMemo(() => {
    const list: { provider: string; model: string; runtime: string }[] = [];
    for (const p of providers ?? []) {
      for (const m of p.models ?? []) {
        list.push({ provider: p.name, model: m, runtime: p.runtime });
      }
    }
    return list;
  }, [providers]);

  const displayModelLabel = selectedTarget
    ? `${selectedTarget.provider}/${selectedTarget.model}`
    : activeModelLabel;
  const activeProviderName = selectedTarget?.provider ?? displayModelLabel.split("/")[0] ?? "";
  const activeModelName = selectedTarget?.model ?? (displayModelLabel.includes("/") ? displayModelLabel.split("/").slice(1).join("/") : displayModelLabel);
  const activeRuntime = providers?.find((provider) => provider.name === activeProviderName)?.runtime ?? "";

  const filteredModelChoices = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return modelChoices;
    return modelChoices.filter((choice) =>
      `${choice.provider}/${choice.model} ${choice.runtime}`.toLowerCase().includes(q),
    );
  }, [modelChoices, modelQuery]);

  const modelSections = useMemo(() => {
    const sections: {
      provider: string;
      items: ({ provider: string; model: string; runtime: string } & { flatIndex: number })[];
    }[] = [];
    filteredModelChoices.forEach((choice, flatIndex) => {
      let section = sections[sections.length - 1];
      if (!section || section.provider !== choice.provider) {
        section = { provider: choice.provider, items: [] };
        sections.push(section);
      }
      section.items.push({ ...choice, flatIndex });
    });
    return sections;
  }, [filteredModelChoices]);

  useEffect(() => {
    if (openPop !== "model") {
      setModelQuery("");
      setFocusedModelIdx(0);
    }
  }, [openPop]);

  useEffect(() => {
    setFocusedModelIdx((idx) => Math.max(0, Math.min(idx, filteredModelChoices.length - 1)));
  }, [filteredModelChoices.length]);

  useEffect(() => {
    if (openPop !== "model" || filteredModelChoices.length === 0) return;
    document
      .getElementById(`${modelListId}-option-${focusedModelIdx}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focusedModelIdx, filteredModelChoices.length, modelListId, openPop]);

  const closeModelPicker = (restoreFocus = false) => {
    setOpenPop(null);
    if (restoreFocus) requestAnimationFrame(() => modelButtonRef.current?.focus());
  };

  const selectModelChoice = (choice: { provider: string; model: string }) => {
    onSelectTarget?.({ provider: choice.provider, model: choice.model });
    closeModelPicker(true);
  };

  const highlightedText = useMemo(() => {
    const re = /(^|\s)(\/(?:goal|plan|verify|preview|spawn-bot|diff))(?=\s|$)/g;
    const parts: (string | JSX.Element)[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    let key = 0;
    while ((match = re.exec(text)) !== null) {
      const leading = match[1];
      const token = match[2];
      const tokenStart = match.index + leading.length;
      parts.push(text.slice(last, tokenStart));
      parts.push(
        <span key={`cmd-${key++}`} className="pc-command-token">
          {token}
        </span>,
      );
      last = tokenStart + token.length;
    }
    parts.push(text.slice(last));
    return parts;
  }, [text]);

  const slashFilter = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const slashItems = useMemo(
    () =>
      slashFilter === null
        ? SLASH_COMMANDS
        : SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(slashFilter)),
    [slashFilter],
  );
  const slashOpen = openPop === "slash" || slashFilter !== null;

  useEffect(() => {
    setFocusedSlashIdx(0);
  }, [slashFilter, slashOpen]);

  const pickSlash = (cmd: string) => {
    setOpenPop(null);
    if (cmd === "/goal" || !onSlashAction) {
      setText(`${cmd} `);
    } else {
      onSlashAction(cmd);
      setText("");
    }
    textareaRef.current?.focus();
  };

  const submit = async () => {
    if (!canSend) return;
    const payload = formatComposerSubmission(text, attachments);
    if (!payload) return;
    setSending(true);
    setError(null);
    setOpenPop(null);
    try {
      await onSubmit(payload);
      setText("");
      onClearAttachments?.(attachments ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const togglePop = (pop: Exclude<PopKind, null>) => {
    setOpenPop((cur) => (cur === pop ? null : pop));
  };

  const startResizeGrip = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || isDisabled) return;
    e.preventDefault();
    resizeCleanupRef.current?.();

    const startY = e.clientY;
    const currentH = textareaRef.current ? textareaRef.current.getBoundingClientRect().height : 56;
    const startHeight = Math.max(COMPOSER_MIN_H, Math.min(COMPOSER_MAX_H, Math.round(currentH)));
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    setResizingHeight(true);

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore capture fallback.
    }

    const onMove = (ev: PointerEvent) => {
      const deltaY = ev.clientY - startY;
      const next = Math.max(COMPOSER_MIN_H, Math.min(COMPOSER_MAX_H, Math.round(startHeight - deltaY)));
      setManualHeight(next);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      setResizingHeight(false);
      resizeCleanupRef.current = null;
    };

    resizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  };

  const showTray =
    Boolean(showDiffTray) && !trayDismissed && gitDiff !== null && gitDiff.filesChanged > 0;

  return (
    <div className="pc-root" ref={rootRef}>
      {showTray && (
        <div className="pc-diff-tray">
          <div className="pc-diff-left">
            <DiffBranchIcon size={14} />
            <span className="pc-diff-count">
              {gitDiff.filesChanged} {gitDiff.filesChanged === 1 ? "file" : "files"} changed
            </span>
            <span className="pc-diff-add">+{gitDiff.insertions}</span>
            <span className="pc-diff-del">−{gitDiff.deletions}</span>
          </div>
          <div className="pc-diff-actions">
            {onViewDiff && (
              <button type="button" className="pc-diff-btn" onClick={onViewDiff}>
                View diff
              </button>
            )}
            <button
              type="button"
              className="pc-diff-close"
              onClick={() => setTrayDismissed(true)}
              aria-label="Dismiss diff tray"
            >
              <X size={12} strokeWidth={1.6} />
            </button>
          </div>
        </div>
      )}

      <div className="pc-card">
        <div
          className="pc-resize-grip"
          data-testid="pc-resize-grip"
          data-dragging={resizingHeight ? "true" : "false"}
          role="separator"
          aria-orientation="horizontal"
          aria-valuenow={manualHeight ?? COMPOSER_MIN_H}
          aria-valuemin={COMPOSER_MIN_H}
          aria-valuemax={COMPOSER_MAX_H}
          aria-label="Resize composer height"
          title="Drag to resize composer (double-click to reset)"
          onPointerDown={startResizeGrip}
          onDoubleClick={() => setManualHeight(null)}
        >
          <span className="pc-resize-grip-bar" />
        </div>

        {hasAttachments && attachments && (
          <div className="pc-attachments" data-testid="pc-attachments">
            {attachments.map((att) => (
              <div key={att.id} className="pc-att-chip" data-attachment-id={att.id}>
                {att.thumbnailDataUrl ? (
                  <img src={att.thumbnailDataUrl} alt={att.label} className="pc-att-thumb" />
                ) : (
                  <span className="pc-att-icon" aria-hidden="true">
                    {att.kind === "doc_comment" ? (
                      <FileText size={13} strokeWidth={1.7} />
                    ) : att.kind === "image_comment" ? (
                      <ImageIcon size={13} strokeWidth={1.7} />
                    ) : (
                      <Box size={13} strokeWidth={1.7} />
                    )}
                  </span>
                )}
                <div className="pc-att-copy">
                  <span className="pc-att-title" title={att.filePath}>
                    {att.label}
                  </span>
                  <span className="pc-att-sub" title={att.comment || att.quote || ""}>
                    {att.comment || att.quote || att.filePath}
                  </span>
                </div>
                <button
                  type="button"
                  className="pc-att-remove"
                  aria-label={`Remove attachment ${att.label}`}
                  title="Remove attachment"
                  onClick={() => onRemoveAttachment?.(att.id)}
                >
                  <X size={12} strokeWidth={1.8} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="pc-input-layer">
          <pre ref={highlightRef} className="pc-input-highlight" aria-hidden="true">
            {highlightedText}
            {"\n"}
          </pre>
        <textarea
          ref={textareaRef}
          className="pc-input pc-input-resizable"
          rows={1}
          placeholder={placeholder}
          value={text}
          readOnly={draft !== undefined && isBusy}
          disabled={isDisabled}
          onChange={(e) => {
            setText(e.target.value);
            if (openPop === "slash" && !e.target.value.startsWith("/")) setOpenPop(null);
          }}
          onScroll={(e) => {
            if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onKeyDown={(e) => {
            if (slashOpen && slashItems.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setFocusedSlashIdx((i) => (i + 1) % slashItems.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setFocusedSlashIdx((i) => (i - 1 + slashItems.length) % slashItems.length);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setOpenPop(null);
                if (text.startsWith("/")) setText("");
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const picked = slashItems[focusedSlashIdx] ?? slashItems[0];
                if (picked) pickSlash(picked.cmd);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        </div>

        <div className="pc-bar">
          <span className="pc-anchor">
            <button
              type="button"
              className={`pc-btn ${openPop === "attach" ? "on" : ""}`}
              title="Quick actions"
              aria-label="Quick actions"
              disabled={isDisabled}
              onClick={() => togglePop("attach")}
            >
              <Plus size={15} strokeWidth={1.6} />
            </button>
            {openPop === "attach" && (
              <div className="pc-pop" role="menu">
                <div className="pc-pop-sec">Quick Actions</div>
                <button
                  type="button"
                  className="pc-pop-item"
                  disabled={!onViewDiff}
                  onClick={() => {
                    setOpenPop(null);
                    onViewDiff?.();
                  }}
                >
                  <DiffBranchIcon size={14} />
                  <span>View diff</span>
                  <span className="pc-pi-sub">git</span>
                </button>
                <button
                  type="button"
                  className="pc-pop-item"
                  disabled={!onOpenBrowser}
                  onClick={() => {
                    setOpenPop(null);
                    onOpenBrowser?.();
                  }}
                >
                  <BrowserPaneIcon size={14} />
                  <span>Open browser</span>
                  <span className="pc-pi-sub">preview</span>
                </button>
                {onSlashAction && (
                  <>
                    <div className="pc-pop-sec">Workflows</div>
                    <button type="button" className="pc-pop-item" onClick={() => pickSlash("/plan")}>
                      <span className="pc-pi-cmd">/plan</span>
                      <span className="pc-pi-sub">roadmap</span>
                    </button>
                    <button type="button" className="pc-pop-item" onClick={() => pickSlash("/verify")}>
                      <span className="pc-pi-cmd">/verify</span>
                      <span className="pc-pi-sub">fresh audit</span>
                    </button>
                    <button type="button" className="pc-pop-item" onClick={() => pickSlash("/spawn-bot")}>
                      <span className="pc-pi-cmd">/spawn-bot</span>
                      <span className="pc-pi-sub">team</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </span>

          <span className="pc-anchor">
            <button
              type="button"
              className={`pc-btn ${slashOpen ? "on" : ""}`}
              title="Slash commands"
              aria-label="Slash commands"
              disabled={isDisabled}
              onClick={() => togglePop("slash")}
            >
              <SlashKeyIcon size={15} />
            </button>
            {slashOpen && (
              <div className="pc-pop pc-pop-slash" role="menu">
                <div className="pc-pop-sec">Commands</div>
                {slashItems.length === 0 && (
                  <div className="pc-pop-desc" style={{ padding: "4px 9px 8px" }}>
                    No matching commands
                  </div>
                )}
                {slashItems.map((c, idx) => (
                  <button
                    type="button"
                    key={c.cmd}
                    className={`pc-pop-item ${idx === focusedSlashIdx ? "focused" : ""}`.trim()}
                    onMouseEnter={() => setFocusedSlashIdx(idx)}
                    onClick={() => pickSlash(c.cmd)}
                  >
                    <span className="pc-pi-cmd">{c.cmd}</span>
                    <span className="pc-pi-sub">{c.desc}</span>
                  </button>
                ))}
              </div>
            )}
          </span>

          <span className="pc-anchor">
            <button
              type="button"
              className="pc-autonomy"
              title="Autonomy level"
              data-level={autonomy}
              disabled={isDisabled}
              onClick={() => togglePop("autonomy")}
            >
              <AutonomyBarsIcon level={autonomy} size={14} />
              <span>{AUTONOMY_LABEL[autonomy]}</span>
            </button>
            {openPop === "autonomy" && (
              <div className="pc-pop" role="menu">
                <div className="pc-pop-sec">Autonomy</div>
                {AUTONOMY_OPTIONS.map((o) => (
                  <button
                    type="button"
                    key={o.value}
                    className={`pc-pop-item ${o.value === autonomy ? "on" : ""}`}
                    onClick={() => {
                      onChangeAutonomy(o.value);
                      setOpenPop(null);
                    }}
                  >
                    <AutonomyBarsIcon level={o.value} size={14} />
                    <span>
                      <span style={{ fontWeight: "var(--weight-medium)", color: "var(--ink-primary)" }}>
                        {o.label}
                      </span>
                      <span className="pc-pop-desc" style={{ display: "block" }}>
                        {o.desc}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </span>

          <span className="pc-spacer" />

          {modelChoices.length > 0 && onSelectTarget ? (
            <span className="pc-anchor">
              <button
                ref={modelButtonRef}
                type="button"
                className="pc-model-btn"
                title={`Active model: ${displayModelLabel}`}
                aria-haspopup="dialog"
                aria-expanded={openPop === "model"}
                aria-controls={openPop === "model" ? modelPickerId : undefined}
                disabled={isDisabled}
                onClick={() => togglePop("model")}
              >
                <ProviderLogo provider={activeProviderName} size={17} />
                <span className="pc-model-label">{activeModelName}</span>
                {activeRuntime && <span className="pc-model-type">{formatRuntimeLabel(activeRuntime)}</span>}
                <ChevronDown size={11} strokeWidth={1.6} />
              </button>
              {openPop === "model" && (
                <div className="pc-pop right pc-model-pop" role="dialog" id={modelPickerId} aria-label="Model target">
                  <div className="pc-model-head">
                    <span className="pc-pop-sec">Model target</span>
                    <span className="pc-model-count">{filteredModelChoices.length} routes</span>
                  </div>
                  <input
                    className="pc-model-search"
                    type="search"
                    role="combobox"
                    aria-expanded="true"
                    aria-controls={modelListId}
                    aria-activedescendant={
                      filteredModelChoices.length > 0 ? `${modelListId}-option-${focusedModelIdx}` : undefined
                    }
                    aria-label="Search models"
                    placeholder="Search models, providers, runtimes"
                    value={modelQuery}
                    onChange={(e) => {
                      setModelQuery(e.target.value);
                      setFocusedModelIdx(0);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown" && filteredModelChoices.length > 0) {
                        e.preventDefault();
                        setFocusedModelIdx((idx) => (idx + 1) % filteredModelChoices.length);
                      } else if (e.key === "ArrowUp" && filteredModelChoices.length > 0) {
                        e.preventDefault();
                        setFocusedModelIdx((idx) => (idx - 1 + filteredModelChoices.length) % filteredModelChoices.length);
                      } else if (e.key === "Home" && filteredModelChoices.length > 0) {
                        e.preventDefault();
                        setFocusedModelIdx(0);
                      } else if (e.key === "End" && filteredModelChoices.length > 0) {
                        e.preventDefault();
                        setFocusedModelIdx(filteredModelChoices.length - 1);
                      } else if (e.key === "Enter" && filteredModelChoices.length > 0) {
                        e.preventDefault();
                        selectModelChoice(filteredModelChoices[focusedModelIdx] ?? filteredModelChoices[0]);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        closeModelPicker(true);
                      }
                    }}
                    autoFocus
                  />
                  <div className="pc-model-options" id={modelListId} role="listbox" aria-label="Available model routes">
                    {filteredModelChoices.length === 0 && (
                      <div className="pc-model-empty">No models match “{modelQuery}”.</div>
                    )}
                    {modelSections.map((section) => (
                      <div className="pc-model-section" key={section.provider}>
                        <div className="pc-model-provider-head">
                          <ProviderLogo provider={section.provider} size={16} />
                          <span>{formatProviderLabel(section.provider)}</span>
                        </div>
                        {section.items.map((choice) => {
                          const isCurrent =
                            selectedTarget?.provider === choice.provider &&
                            selectedTarget?.model === choice.model;
                          const isFocused = choice.flatIndex === focusedModelIdx;
                          return (
                            <button
                              type="button"
                              key={`${choice.provider}/${choice.model}`}
                              id={`${modelListId}-option-${choice.flatIndex}`}
                              className={`pc-model-option ${isCurrent ? "on" : ""} ${isFocused ? "focused" : ""}`.trim()}
                              role="option"
                              aria-selected={isCurrent}
                              onMouseEnter={() => setFocusedModelIdx(choice.flatIndex)}
                              onClick={() => selectModelChoice(choice)}
                            >
                              <ProviderLogo provider={choice.provider} size={20} />
                              <span className="pc-model-copy">
                                <span className="pc-model-name">{choice.model}</span>
                                <span className="pc-model-provider">{formatProviderLabel(choice.provider)}</span>
                              </span>
                              <span className="pc-model-runtime">{formatRuntimeLabel(choice.runtime)}</span>
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  <div className="pc-model-foot">
                    <span>Enter selects</span>
                    <span className="pc-model-footnote">Next idle turn</span>
                    <span>Esc closes</span>
                  </div>
                </div>
              )}
            </span>
          ) : (
            <span className="pc-model-static" title="Model target">
              {displayModelLabel}
            </span>
          )}

          <ReasoningEffortControl
            value={effort}
            onChange={onChangeEffort}
            disabled={isDisabled}
          />

          <ContextRingGauge percent={contextPercent} tooltip={contextTooltip} />

        </div>
        <div className="pc-send-slot">
          {sending && <span className="pc-sending" role="status">Sending...</span>}
          <button
            type="button"
            className="pc-send"
            title={mode === "steer" ? "Send to Team Lead" : "Send message"}
            aria-label={mode === "steer" ? "Send to Team Lead" : "Send message"}
            aria-busy={sending}
            disabled={!canSend}
            onClick={() => void submit()}
          >
            <SendArrowIcon size={18} />
          </button>
        </div>
      </div>

      {error && (
        <div className="pc-error">
          <div className="inline-error" role="alert">
            <span>{error}</span>
            <button
              type="button"
              className="btn ghost xs"
              onClick={() => setError(null)}
              aria-label="Dismiss error"
            >
              <X size={12} strokeWidth={1.6} />
            </button>
          </div>
        </div>
      )}

      <div className="pc-strip">
        <span className="pc-chip static">
          <span className={`pc-mode-dot ${mode === "steer" ? "steer" : ""}`} />
          {mode === "steer" ? "Steer → Team Lead" : "Local · 127.0.0.1"}
        </span>
        <span className="pc-strip-sep" />
        {projects.length > 0 && (mode === "chat" || onSelectProject) && (
          <span className="pc-anchor">
            <button
              type="button"
              className="pc-chip"
              onClick={() => togglePop("project")}
              disabled={!onSelectProject}
            >
              <FolderGit2 size={12} strokeWidth={1.6} />
              <span>{activeProject?.name ?? "Select project"}</span>
              <ChevronDown size={10} strokeWidth={1.6} />
            </button>
            {openPop === "project" && (
              <div className="pc-pop" role="menu" style={{ minWidth: 220 }}>
                <div className="pc-pop-sec">Project</div>
                {projects.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    className={`pc-pop-item ${p.id === activeProject?.id ? "on" : ""}`}
                    onClick={() => {
                      onSelectProject?.(p.id);
                      setOpenPop(null);
                    }}
                  >
                    <FolderGit2 size={13} strokeWidth={1.6} />
                    <span>{p.name}</span>
                    <span className="pc-pi-sub">{p.slug}</span>
                  </button>
                ))}
              </div>
            )}
          </span>
        )}
        <span className="pc-chip static">
          <DiffBranchIcon size={12} />
          <span className="bf-tabular">{gitDiff?.branch ?? "main"}</span>
        </span>
        <span className="pc-strip-right">
          {onOpenBrowser && (
            <button type="button" className="pc-chip" onClick={onOpenBrowser}>
              <BrowserPaneIcon size={12} />
              Browser
            </button>
          )}
          <kbd className="pc-kbd">Ctrl+E</kbd>
          <kbd className="pc-kbd">Ctrl+K</kbd>
        </span>
      </div>
    </div>
  );
}
