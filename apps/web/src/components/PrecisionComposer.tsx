import type { GitDiffResponse, ProjectRecord } from "@bot-factory/shared";
import { ChevronDown, FolderGit2, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import {
  AutonomyBarsIcon,
  BrowserPaneIcon,
  DiffBranchIcon,
  QuickReviewIcon,
  SendArrowIcon,
  SlashKeyIcon,
} from "./BotFactoryIcons";
import { BotThinkingOrb } from "./BotThinkingOrb";
import { ReasoningEffortControl, type ReasoningEffort } from "./ReasoningEffortSlider";

export type AutonomyLevel = "spec" | "low" | "medium" | "high";

export interface PrecisionComposerProps {
  mode: "chat" | "steer";
  placeholder: string;
  busy?: boolean;
  disabled?: boolean;
  activeProject: ProjectRecord | null;
  projects: ProjectRecord[];
  onSelectProject?: (projectId: string) => void;
  activeModelLabel: string;
  gitDiff: GitDiffResponse | null;
  showDiffTray?: boolean;
  onViewDiff?: () => void;
  onQuickReview?: () => void;
  onOpenBrowser?: () => void;
  effort: ReasoningEffort;
  onChangeEffort: (v: ReasoningEffort) => void;
  autonomy: AutonomyLevel;
  onChangeAutonomy: (v: AutonomyLevel) => void;
  onSubmit: (text: string) => Promise<void>;
  onSlashAction?: (command: string) => void;
}

const SLASH_COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: "/plan", desc: "Erst einen Umsetzungsplan entwerfen" },
  { cmd: "/verify", desc: "Frische Verifikation durch den Verifier" },
  { cmd: "/preview", desc: "Artefakt im In-App-Browser öffnen" },
  { cmd: "/spawn-bot", desc: "Neuen Peer-Bot im Projekt starten" },
  { cmd: "/diff", desc: "Aktuellen Git-Diff reviewen" },
];

const AUTONOMY_OPTIONS: { value: AutonomyLevel; label: string; desc: string }[] = [
  { value: "spec", label: "Spec", desc: "Nur planen & spezifizieren — keine Ausführung." },
  { value: "low", label: "Niedrig", desc: "Vor jedem Tool-Aufruf nachfragen." },
  { value: "medium", label: "Mittel", desc: "Scoped Edits, bei destruktiven Ops fragen." },
  { value: "high", label: "Hoch", desc: "Volle Geschwindigkeit, Diff danach reviewen." },
];

const AUTONOMY_LABEL: Record<AutonomyLevel, string> = {
  spec: "Spec",
  low: "Niedrig",
  medium: "Mittel",
  high: "Hoch",
};

type PopKind = "slash" | "autonomy" | "project" | "attach" | null;

const PC_CSS = `
.pc-root{position:relative;width:100%}
.pc-diff-tray{display:flex;align-items:center;justify-content:space-between;gap:10px;max-width:704px;margin:0 auto 6px;background:#F5F5F5;border:var(--hairline);border-radius:var(--radius-lg);padding:6px 8px 6px 11px;font-size:var(--text-xs);color:var(--ink-secondary)}
.pc-diff-left{display:flex;align-items:center;gap:8px;min-width:0}
.pc-diff-left>svg{color:var(--ink-muted);flex:0 0 auto}
.pc-diff-count{color:var(--ink-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-diff-add{color:var(--status-success-ink);font-family:var(--font-mono);font-variant-numeric:tabular-nums;flex:0 0 auto}
.pc-diff-del{color:var(--status-danger-ink);font-family:var(--font-mono);font-variant-numeric:tabular-nums;flex:0 0 auto}
.pc-diff-actions{display:flex;align-items:center;gap:3px;flex-shrink:0}
.pc-diff-btn{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:var(--radius-sm);font-size:var(--text-2xs);font-weight:var(--weight-medium);color:var(--ink-secondary);background:none;border:none;cursor:pointer;transition:background var(--duration-fast) var(--ease-out-quiet),color var(--duration-fast) var(--ease-out-quiet)}
.pc-diff-btn:hover:not(:disabled){background:var(--bg-active);color:var(--ink-primary)}
.pc-diff-btn:disabled{opacity:.45;cursor:not-allowed}
.pc-diff-btn.primary{background:var(--bg-canvas);border:var(--hairline);color:var(--ink-primary)}
.pc-diff-btn.primary:hover:not(:disabled){border-color:var(--border-strong);background:var(--bg-hover)}
.pc-diff-close{width:22px;height:22px;border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;color:var(--ink-muted);background:none;border:none;cursor:pointer}
.pc-diff-close:hover{background:var(--bg-active);color:var(--ink-primary)}
.pc-card{position:relative;max-width:704px;margin:0 auto;background:var(--bg-canvas);border:1px solid var(--border-strong);border-radius:12px;box-shadow:0 1px 2px rgba(23,23,23,.04),0 8px 24px -6px rgba(23,23,23,.05);transition:border-color var(--duration-fast) var(--ease-out-quiet),box-shadow var(--duration-fast) var(--ease-out-quiet)}
.pc-card:focus-within{border-color:var(--ink-secondary);box-shadow:0 0 0 2px rgba(23,23,23,.06),0 8px 24px -6px rgba(23,23,23,.06)}
.pc-input{display:block;width:100%;border:none;outline:none;resize:none;background:transparent;padding:13px 16px 6px;font-family:var(--font-sans);font-size:13.5px;line-height:1.5;min-height:44px;max-height:180px;overflow-y:auto;color:var(--ink-primary)}
.pc-input:focus,.pc-input:focus-visible{outline:none;box-shadow:none}
.pc-input::placeholder{color:var(--ink-faint)}
.pc-input:disabled{color:var(--ink-faint)}
.pc-bar{display:flex;align-items:center;gap:6px;padding:8px 10px 10px}
.pc-btn{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--ink-muted);background:none;border:1px solid transparent;cursor:pointer;transition:background var(--duration-fast) var(--ease-out-quiet),color var(--duration-fast) var(--ease-out-quiet)}
.pc-btn:hover:not(:disabled){background:var(--bg-hover);color:var(--ink-primary)}
.pc-btn.on{background:var(--bg-active);color:var(--ink-primary);border-color:var(--border-hairline)}
.pc-btn:disabled{opacity:.45;cursor:not-allowed}
.pc-anchor{position:relative;display:flex}
.pc-spacer{flex:1}
.pc-autonomy{display:flex;align-items:center;gap:7px;height:28px;padding:0 9px;border-radius:8px;border:var(--hairline);background:var(--bg-surface);cursor:pointer;font-size:var(--text-xs);font-weight:var(--weight-medium);color:var(--ink-secondary);transition:background var(--duration-fast) var(--ease-out-quiet),border-color var(--duration-fast) var(--ease-out-quiet)}
.pc-autonomy:hover:not(:disabled){background:var(--bg-hover);border-color:var(--border-strong)}
.pc-autonomy:disabled{opacity:.5;cursor:not-allowed}
.pc-autonomy-label{white-space:nowrap}
.pc-model{display:flex;align-items:center;gap:6px;height:28px;padding:0 9px;border-radius:8px;font-family:var(--font-mono);font-size:var(--text-2xs);color:var(--ink-secondary);background:none;border:none;white-space:nowrap}
.pc-send{width:30px;height:30px;border-radius:9px;background:var(--action-primary-bg);color:var(--action-primary-fg);display:flex;align-items:center;justify-content:center;border:none;cursor:pointer;flex:0 0 auto;transition:background var(--duration-fast) var(--ease-out-quiet)}
.pc-send:hover:not(:disabled){background:var(--action-primary-hover)}
.pc-send:disabled{background:var(--border-strong);cursor:not-allowed}
.pc-pop{position:absolute;bottom:calc(100% + 8px);left:0;background:var(--bg-canvas);border:1px solid var(--border-strong);border-radius:var(--radius-lg);box-shadow:var(--shadow-popover);padding:5px;min-width:236px;z-index:var(--z-popover);animation:pc-pop-in .13s var(--ease-out-quiet)}
.pc-pop.right{left:auto;right:0}
@keyframes pc-pop-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.pc-pop-sec{font-family:var(--font-mono);font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint);padding:7px 9px 4px}
.pc-pop-item{display:flex;align-items:center;gap:9px;width:100%;padding:7px 9px;border-radius:7px;font-size:12.5px;color:var(--ink-secondary);text-align:left;background:none;border:none;cursor:pointer;transition:background var(--duration-fast) var(--ease-out-quiet)}
.pc-pop-item:hover:not(:disabled){background:var(--bg-hover)}
.pc-pop-item.on{background:var(--bg-active);color:var(--ink-primary)}
.pc-pop-item:disabled{opacity:.45;cursor:not-allowed}
.pc-pop-item .pc-pi-cmd{font-family:var(--font-mono);font-weight:var(--weight-semibold);color:var(--ink-primary);white-space:nowrap}
.pc-pop-item .pc-pi-sub{margin-left:auto;font-family:var(--font-mono);font-size:10px;color:var(--ink-faint);white-space:nowrap}
.pc-pop-desc{font-size:11px;color:var(--ink-muted);line-height:1.5;padding-top:1px}
.pc-error{max-width:704px;margin:6px auto 0}
.pc-strip{max-width:704px;margin:7px auto 0;display:flex;align-items:center;flex-wrap:nowrap;gap:4px;padding:0 4px;min-height:24px;overflow:hidden}
.pc-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 7px;border-radius:var(--radius-sm);font-size:11.5px;color:var(--ink-muted);background:none;border:none;cursor:pointer;white-space:nowrap;min-width:0;flex-shrink:0;transition:background var(--duration-fast) var(--ease-out-quiet),color var(--duration-fast) var(--ease-out-quiet)}
.pc-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px}
.pc-chip:hover:not(:disabled){background:var(--bg-hover);color:var(--ink-secondary)}
.pc-chip.static{cursor:default}
.pc-chip.static:hover{background:none;color:var(--ink-muted)}
.pc-chip>svg{color:var(--ink-faint);flex:0 0 auto}
.pc-mode-dot{width:6px;height:6px;border-radius:50%;background:var(--status-success-ink);flex:0 0 auto}
.pc-mode-dot.steer{background:#D97706}
.pc-strip-sep{width:1px;height:12px;background:var(--border-hairline);margin:0 2px;flex:0 0 auto}
.pc-strip-right{margin-left:auto;display:flex;align-items:center;gap:6px;flex-shrink:0}
.pc-kbd{font-family:var(--font-mono);font-size:10px;color:var(--ink-muted);background:var(--bg-surface-subtle);border:1px solid var(--border-hairline);border-bottom-width:2px;border-radius:var(--radius-xs);padding:0 4px;line-height:1.5}
@media (prefers-reduced-motion:reduce){.pc-pop{animation:none}}
`;

export function PrecisionComposer({
  mode,
  placeholder,
  busy,
  disabled,
  activeProject,
  projects,
  onSelectProject,
  activeModelLabel,
  gitDiff,
  showDiffTray,
  onViewDiff,
  onQuickReview,
  onOpenBrowser,
  effort,
  onChangeEffort,
  autonomy,
  onChangeAutonomy,
  onSubmit,
  onSlashAction,
}: PrecisionComposerProps): JSX.Element {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [openPop, setOpenPop] = useState<PopKind>(null);
  const [trayDismissed, setTrayDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const isBusy = Boolean(busy) || sending;
  const isDisabled = Boolean(disabled);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

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

  const slashFilter = text.startsWith("/") ? text.slice(1).toLowerCase() : null;
  const slashItems =
    slashFilter === null
      ? SLASH_COMMANDS
      : SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(slashFilter));
  const slashOpen = openPop === "slash" || slashFilter !== null;

  const pickSlash = (cmd: string) => {
    setOpenPop(null);
    if (onSlashAction) {
      onSlashAction(cmd);
      setText("");
    } else {
      setText(`${cmd} `);
    }
    textareaRef.current?.focus();
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || isBusy || isDisabled) return;
    setSending(true);
    setError(null);
    setOpenPop(null);
    try {
      await onSubmit(trimmed);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const togglePop = (pop: Exclude<PopKind, null>) => {
    setOpenPop((cur) => (cur === pop ? null : pop));
  };

  const showTray =
    Boolean(showDiffTray) && !trayDismissed && gitDiff !== null && gitDiff.filesChanged > 0;

  return (
    <div className="pc-root" ref={rootRef}>
      <style>{PC_CSS}</style>

      {showTray && (
        <div className="pc-diff-tray">
          <div className="pc-diff-left">
            <DiffBranchIcon size={14} />
            <span className="pc-diff-count">{gitDiff.filesChanged} Dateien geändert</span>
            <span className="pc-diff-add">+{gitDiff.insertions}</span>
            <span className="pc-diff-del">−{gitDiff.deletions}</span>
          </div>
          <div className="pc-diff-actions">
            {onQuickReview && (
              <button type="button" className="pc-diff-btn" onClick={onQuickReview}>
                Quick review
              </button>
            )}
            {onViewDiff && (
              <button type="button" className="pc-diff-btn primary" onClick={onViewDiff}>
                Änderungen ansehen
              </button>
            )}
            <button
              type="button"
              className="pc-diff-close"
              onClick={() => setTrayDismissed(true)}
              aria-label="Diff-Tray schließen"
            >
              <X size={12} strokeWidth={1.6} />
            </button>
          </div>
        </div>
      )}

      <div className="pc-card">
        <textarea
          ref={textareaRef}
          className="pc-input"
          rows={1}
          placeholder={placeholder}
          value={text}
          disabled={isDisabled}
          onChange={(e) => {
            setText(e.target.value);
            if (openPop === "slash" && !e.target.value.startsWith("/")) setOpenPop(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />

        <div className="pc-bar">
          <span className="pc-anchor">
            <button
              type="button"
              className={`pc-btn ${openPop === "attach" ? "on" : ""}`}
              title="Quick Actions"
              aria-label="Quick Actions"
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
                  disabled={!onQuickReview}
                  onClick={() => {
                    setOpenPop(null);
                    onQuickReview?.();
                  }}
                >
                  <QuickReviewIcon size={14} />
                  <span>Quick review</span>
                  <span className="pc-pi-sub">diff</span>
                </button>
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
                  <span>Änderungen ansehen</span>
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
                  <span>Browser öffnen</span>
                  <span className="pc-pi-sub">preview</span>
                </button>
              </div>
            )}
          </span>

          <span className="pc-anchor">
            <button
              type="button"
              className={`pc-btn ${slashOpen ? "on" : ""}`}
              title="Slash-Befehle"
              aria-label="Slash-Befehle"
              disabled={isDisabled}
              onClick={() => togglePop("slash")}
            >
              <SlashKeyIcon size={15} />
            </button>
            {slashOpen && (
              <div className="pc-pop" role="menu">
                <div className="pc-pop-sec">Commands</div>
                {slashItems.length === 0 && (
                  <div className="pc-pop-desc" style={{ padding: "4px 9px 8px" }}>
                    Keine passenden Befehle
                  </div>
                )}
                {slashItems.map((c) => (
                  <button
                    type="button"
                    key={c.cmd}
                    className="pc-pop-item"
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
              title="Autonomie-Level"
              data-level={autonomy}
              disabled={isDisabled}
              onClick={() => togglePop("autonomy")}
            >
              <AutonomyBarsIcon level={autonomy} size={14} />
              <span className="pc-autonomy-label">{AUTONOMY_LABEL[autonomy]}</span>
            </button>
            {openPop === "autonomy" && (
              <div className="pc-pop" role="menu">
                <div className="pc-pop-sec">Autonomie</div>
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

          <span className="pc-model" title="Aktives Modell">
            {activeModelLabel}
          </span>
          <ReasoningEffortControl
            value={effort}
            onChange={onChangeEffort}
            disabled={isDisabled}
          />
          <button
            type="button"
            className="pc-send"
            title={mode === "steer" ? "Steer senden" : "Senden"}
            aria-label={mode === "steer" ? "Steer senden" : "Senden"}
            disabled={isDisabled || isBusy || !text.trim()}
            onClick={() => void submit()}
          >
            {isBusy ? (
              <BotThinkingOrb activity="composing" size={20} shell={false} />
            ) : (
              <SendArrowIcon size={14} />
            )}
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
              aria-label="Fehlermeldung schließen"
            >
              <X size={12} strokeWidth={1.6} />
            </button>
          </div>
        </div>
      )}

      <div className="pc-strip">
        <span className="pc-chip static">
          <span className={`pc-mode-dot ${mode === "steer" ? "steer" : ""}`} />
          {mode === "steer" ? "Steer → PM" : "Lokal"}
        </span>
        <span className="pc-strip-sep" />
        {projects.length > 0 && (
          <span className="pc-anchor">
            <button
              type="button"
              className="pc-chip"
              onClick={() => togglePop("project")}
              disabled={!onSelectProject}
            >
              <FolderGit2 size={12} strokeWidth={1.6} />
              {activeProject?.name ?? "Projekt wählen"}
              <ChevronDown size={10} strokeWidth={1.6} />
            </button>
            {openPop === "project" && (
              <div className="pc-pop" role="menu" style={{ minWidth: 200 }}>
                <div className="pc-pop-sec">Projekt</div>
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
