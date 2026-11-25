import type {
  MemoryFactRecord,
  MemoryKind,
  MemoryL1Target,
  ProjectRecord,
} from "@bot-factory/shared";
import {
  Brain,
  CheckCircle2,
  Database,
  FileText,
  RefreshCw,
  Save,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import type { RpcCommandInput } from "../client/useBotFactory";
import { BotThinkingOrb } from "../components/BotThinkingOrb";

export interface MemoryL1StudioProps {
  open: boolean;
  onClose: () => void;
  projects: ProjectRecord[];
  activeProject: ProjectRecord | null;
  l1Memory: Record<string, { target: string; content: string; usedChars: number; maxChars: number; gaugeHeader: string; truncated?: boolean }>;
  l2Facts: MemoryFactRecord[];
  onRefreshMemory: (projectId?: string, query?: string) => Promise<void>;
  onSendCommand: <T = unknown>(cmd: RpcCommandInput) => Promise<T>;
}

const DEFAULT_MAX_CHARS: Record<MemoryL1Target, number> = {
  user: 2000,
  global: 3000,
  project: 3000,
};

const TAB_LABELS: Record<MemoryL1Target, { title: string; filename: string; subtitle: string }> = {
  user: {
    title: "USER.md",
    filename: "USER.md",
    subtitle: "Global operator preferences, workflow style, and defaults injected across projects.",
  },
  global: {
    title: "GLOBAL_MEMORY.md",
    filename: "GLOBAL_MEMORY.md",
    subtitle: "Cross-project architecture notes, lessons learned, and standing system invariants.",
  },
  project: {
    title: "MEMORY.md",
    filename: "MEMORY.md",
    subtitle: "Project-scoped frozen Tier-1 memory snapshot for team lead and specialist bots.",
  },
};

export function MemoryL1Studio({
  open,
  onClose,
  projects,
  activeProject,
  l1Memory,
  l2Facts,
  onRefreshMemory,
  onSendCommand,
}: MemoryL1StudioProps): JSX.Element | null {
  const [activeTab, setActiveTab] = useState<MemoryL1Target>("user");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [draftContent, setDraftContent] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | MemoryKind>("all");
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [savedBanner, setSavedBanner] = useState<string | null>(null);

  useEffect(() => {
    const nextId = activeProject?.id ?? projects[0]?.id ?? "";
    setSelectedProjectId((prev) => (prev && projects.some((p) => p.id === prev) ? prev : nextId));
  }, [activeProject?.id, projects]);

  useEffect(() => {
    if (!open) return;
    void onRefreshMemory(selectedProjectId || undefined, searchQuery.trim() || undefined).catch((err) => {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    });
  }, [open, selectedProjectId, onRefreshMemory]);

  useEffect(() => {
    setSavedBanner(null);
    setErrorMsg(null);
  }, [open, activeTab, selectedProjectId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onClose]);

  const activeEntry = useMemo(() => {
    if (activeTab === "project") {
      return (
        l1Memory[`project:${selectedProjectId}`] ??
        l1Memory.project ??
        Object.values(l1Memory).find((e) => e.target === "project") ??
        null
      );
    }
    return l1Memory[activeTab] ?? Object.values(l1Memory).find((e) => e.target === activeTab) ?? null;
  }, [l1Memory, activeTab, selectedProjectId]);

  const entryContent = activeEntry?.content ?? "";

  useEffect(() => {
    if (!open) return;
    setDraftContent(entryContent);
  }, [open, activeTab, selectedProjectId, entryContent]);

  const filteredFacts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return l2Facts.filter((f) => {
      if (kindFilter !== "all" && f.kind !== kindFilter) return false;
      if (!q) return true;
      return (
        f.entity.toLowerCase().includes(q) ||
        f.factText.toLowerCase().includes(q) ||
        f.namespace.toLowerCase().includes(q)
      );
    });
  }, [l2Facts, kindFilter, searchQuery]);

  if (!open) return null;

  const maxChars = activeEntry?.maxChars ?? DEFAULT_MAX_CHARS[activeTab];
  const usedChars = draftContent.length;
  const pct = maxChars > 0 ? Math.min(100, Math.round((usedChars / maxChars) * 100)) : 0;
  const isOverCap = usedChars > maxChars;
  const isNearCap = !isOverCap && pct >= 85;
  const isDirty = draftContent !== (activeEntry?.content ?? "");
  const isTruncatedSnapshot = activeEntry?.truncated === true;

  const handleSaveL1 = async () => {
    if (busy) return;
    if (activeTab === "project" && !selectedProjectId) {
      setErrorMsg("Select a project before saving MEMORY.md.");
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    setSavedBanner(null);
    try {
      await onSendCommand({
        type: "memory.l1.update",
        target: activeTab,
        ...(activeTab === "project" ? { projectId: selectedProjectId } : {}),
        content: draftContent,
      });
      await onRefreshMemory(selectedProjectId || undefined, searchQuery.trim() || undefined);
      setSavedBanner(`${TAB_LABELS[activeTab].filename} saved (${usedChars}/${maxChars} chars).`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSearch = async () => {
    setBusy(true);
    setErrorMsg(null);
    try {
      await onRefreshMemory(selectedProjectId || undefined, searchQuery.trim() || undefined);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!busy) onClose();
      }}
      role="presentation"
    >
      <div
        className="modal-card wide memory-studio-modal"
        style={{ width: 920, maxWidth: "96vw", height: "88vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-studio-title"
      >
        <div
          className="modal-header memory-studio-header"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: "var(--hairline)",
            background: "var(--bg-surface)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <Brain size={16} strokeWidth={1.6} color="var(--ink-secondary)" />
            <div>
              <h2
                id="memory-studio-title"
                style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: 600, color: "var(--ink-primary)" }}
              >
                Memory Studio — L1 Prompt Files &amp; L2 Live Facts
              </h2>
              <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-muted)" }}>
                Inspect and curate Tier-1 pinned markdown blocks and Tier-2 Supermemory facts
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              type="button"
              className="btn xs"
              disabled={busy}
              onClick={() => void handleSearch()}
            >
              <RefreshCw size={12} strokeWidth={1.6} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              className="btn xs ghost"
              onClick={onClose}
              disabled={busy}
              aria-label="Close Memory Studio"
            >
              <X size={14} strokeWidth={1.6} />
            </button>
          </div>
        </div>

        <div
          className="modal-body memory-studio-body"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {errorMsg && (
            <div className="inline-error" role="alert">
              <span>{errorMsg}</span>
              <button type="button" className="btn xs ghost" onClick={() => setErrorMsg(null)}>
                Dismiss
              </button>
            </div>
          )}

          {savedBanner && (
            <div className="pill success" style={{ padding: "7px 11px", borderRadius: "var(--radius-sm)" }}>
              <CheckCircle2 size={13} strokeWidth={1.6} />
              <span>{savedBanner}</span>
            </div>
          )}

          <div className="phase3-split">
            {/* Left: L1 Tabbed Markdown Editor + Live Char Gauge */}
            <div className="kanban-col memory-studio-l1-col">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <div className="subview-tabs">
                  {(["user", "global", "project"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={`subview-tab ${activeTab === t ? "active" : ""}`}
                      onClick={() => setActiveTab(t)}
                    >
                      <FileText size={11} strokeWidth={1.6} />
                      <span>{TAB_LABELS[t].title}</span>
                    </button>
                  ))}
                </div>

                {activeTab === "project" && (
                  <select
                    className="field-input"
                    style={{ width: 190 }}
                    value={selectedProjectId}
                    onChange={(e) => setSelectedProjectId(e.target.value)}
                  >
                    {projects.length === 0 ? (
                      <option value="">No projects</option>
                    ) : (
                      projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))
                    )}
                  </select>
                )}
              </div>

              <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)" }}>
                {TAB_LABELS[activeTab].subtitle}
              </div>

              {/* Live Character-Count Progress Gauge */}
              <div
                className="memory-studio-gauge"
                style={{
                  padding: "8px 10px",
                  borderRadius: "var(--radius-sm)",
                  border: "var(--hairline)",
                  background: "var(--bg-canvas)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-2xs)",
                      color: isOverCap
                        ? "var(--status-danger-ink)"
                        : isNearCap
                          ? "var(--status-warning-ink)"
                          : "var(--ink-secondary)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    [{pct}% — {usedChars.toLocaleString()} / {maxChars.toLocaleString()} chars]
                  </span>
                  {isOverCap && (
                    <span className="pill danger">Exceeds limit by {(usedChars - maxChars).toLocaleString()} chars</span>
                  )}
                </div>
                <div
                  style={{
                    height: 6,
                    borderRadius: 999,
                    background: "var(--bg-surface-subtle)",
                    overflow: "hidden",
                    border: "var(--hairline-subtle)",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, pct)}%`,
                      height: "100%",
                      borderRadius: 999,
                      background: isOverCap
                        ? "var(--status-danger-ink)"
                        : isNearCap
                          ? "var(--status-warning-ink)"
                          : "var(--accent-orange)",
                      transition: "width 150ms ease",
                    }}
                  />
                </div>
              </div>

              <textarea
                className="field-textarea mono"
                rows={14}
                disabled={busy || isTruncatedSnapshot || (activeTab === "project" && !selectedProjectId)}
                placeholder={`Write concise curated memory for ${TAB_LABELS[activeTab].filename}…`}
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
              />

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy || !isDirty || isTruncatedSnapshot}
                  onClick={() => setDraftContent(activeEntry?.content ?? "")}
                >
                  Revert Changes
                </button>
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={busy || isOverCap || isTruncatedSnapshot || (activeTab === "project" && !selectedProjectId)}
                  onClick={() => void handleSaveL1()}
                >
                  {busy ? (
                    <>
                      <BotThinkingOrb activity="working" size={20} shell={false} />
                      <span>Saving…</span>
                    </>
                  ) : (
                    <>
                      <Save size={12} strokeWidth={1.6} />
                      <span>Save L1</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Right: Read-only L2 Live Facts Explorer */}
            <div className="kanban-col memory-studio-l2-col">
              <div className="section-eyebrow">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Database size={14} strokeWidth={1.6} />
                  L2 Live Facts ({filteredFacts.length})
                </span>
                <span className="mono-tag">read-only</span>
              </div>

              <div style={{ display: "flex", gap: 6 }}>
                <div style={{ position: "relative", flex: 1 }}>
                  <input
                    className="field-input"
                    placeholder="Filter entity, fact, or namespace…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleSearch();
                    }}
                  />
                </div>
                <button type="button" className="btn sm" disabled={busy} onClick={() => void handleSearch()}>
                  <Search size={12} strokeWidth={1.6} />
                  <span>Query</span>
                </button>
              </div>

              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {(["all", "fact", "preference", "decision", "episode"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`btn xs ${kindFilter === k ? "primary" : ""}`}
                    onClick={() => setKindFilter(k)}
                  >
                    {k === "all" ? "All" : k}
                  </button>
                ))}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 420, overflowY: "auto" }}>
                {filteredFacts.length === 0 ? (
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)", padding: "8px 4px", lineHeight: 1.5 }}>
                    No live L2 memory facts matched this filter.
                  </div>
                ) : (
                  filteredFacts.map((fact) => (
                    <div key={fact.id} className="task-card memory-studio-fact-card" style={{ gap: 5 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                        <span style={{ fontWeight: 600, fontSize: "var(--text-xs)", color: "var(--ink-primary)" }}>
                          {fact.entity}
                        </span>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <span className="pill">{fact.kind}</span>
                          <span className="mono-tag">v{fact.version}</span>
                          <span className={`pill ${fact.isStatic ? "active" : ""}`}>
                            {fact.isStatic ? "static" : "dynamic"}
                          </span>
                        </div>
                      </div>
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-secondary)", lineHeight: 1.45 }}>
                        {fact.factText}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 6,
                          fontSize: "10.5px",
                          color: "var(--ink-muted)",
                        }}
                      >
                        <span className="mono-tag">{fact.namespace}</span>
                        <span style={{ fontVariantNumeric: "tabular-nums" }}>
                          {Math.round(fact.confidence * 100)}% conf
                          {fact.isInference ? " · inferred" : ""}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
