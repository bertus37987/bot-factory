import { ChevronDown, GitCompareArrows, RefreshCw } from "lucide-react";
import { useRef, useState, type JSX } from "react";
import type { GitDiffResponse } from "@bot-factory/shared";

export interface DiffViewerProps {
  gitDiff: GitDiffResponse | null;
  onRefreshDiff: () => void;
}

const STATUS_CODE: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  untracked: "U",
  renamed: "R",
};

export function DiffViewer({ gitDiff, onRefreshDiff }: DiffViewerProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const jumpToFile = (path: string) => {
    setCollapsed((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    const el = fileRefs.current.get(path);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const toggleAll = () => {
    if (!gitDiff || gitDiff.files.length === 0) return;
    if (collapsed.size >= gitDiff.files.length) {
      setCollapsed(new Set());
    } else {
      setCollapsed(new Set(gitDiff.files.map((f) => f.path)));
    }
  };

  const allCollapsed = Boolean(gitDiff && gitDiff.files.length > 0 && collapsed.size >= gitDiff.files.length);

  return (
    <div
      className="iab-diff-stage"
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "var(--bg-canvas)",
      }}
    >
      {/* Sticky summary header */}
      <div
        className="iab-diff-meta"
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 14px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-surface-1)",
          fontSize: "var(--text-xs)",
          color: "var(--ink-secondary)",
        }}
      >
        <GitCompareArrows size={13} strokeWidth={1.6} />
        {gitDiff ? (
          <>
            <span className="mono-tag" style={{ fontWeight: "var(--weight-semibold)" }}>
              {gitDiff.branch}
            </span>
            <span>
              {gitDiff.filesChanged} {gitDiff.filesChanged === 1 ? "file" : "files"} changed
            </span>
            <span style={{ color: "var(--status-success-ink)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
              +{gitDiff.insertions}
            </span>
            <span style={{ color: "var(--status-danger-ink)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
              -{gitDiff.deletions}
            </span>
          </>
        ) : (
          <span style={{ color: "var(--ink-muted)" }}>No diff loaded</span>
        )}
        <span style={{ flex: 1 }} />
        {gitDiff && gitDiff.files.length > 1 && (
          <button type="button" className="btn xs ghost" onClick={toggleAll}>
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        )}
        <button type="button" className="btn xs" onClick={onRefreshDiff}>
          <RefreshCw size={11} strokeWidth={1.6} />
          <span>Refresh</span>
        </button>
      </div>

      {/* File jump bar */}
      {gitDiff && gitDiff.files.length > 0 && (
        <div
          className="iab-diff-jumpbar"
          aria-label="Changed files jump bar"
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 14px",
            borderBottom: "1px solid var(--border-hairline)",
            background: "var(--bg-canvas)",
            overflowX: "auto",
            scrollbarWidth: "thin",
          }}
        >
          {gitDiff.files.map((f) => {
            const shortName = f.path.split("/").pop() ?? f.path;
            return (
              <button
                key={f.path}
                type="button"
                className="btn xs"
                title={f.path}
                onClick={() => jumpToFile(f.path)}
                style={{
                  background: "var(--bg-surface-1)",
                  fontFamily: "var(--font-mono)",
                  gap: 5,
                }}
              >
                <span
                  style={{
                    color:
                      f.status === "added" || f.status === "untracked"
                        ? "var(--status-success-ink)"
                        : f.status === "deleted"
                          ? "var(--status-danger-ink)"
                          : "var(--accent-orange-ink)",
                    fontWeight: "var(--weight-semibold)",
                  }}
                >
                  {STATUS_CODE[f.status] ?? f.status}
                </span>
                <span>{shortName}</span>
                <span style={{ color: "var(--status-success-ink)" }}>+{f.added}</span>
                <span style={{ color: "var(--status-danger-ink)" }}>-{f.removed}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Scrollable patches list */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {!gitDiff && (
          <div style={{ padding: 24, color: "var(--ink-muted)", fontSize: "var(--text-sm)", textAlign: "center" }}>
            Click Refresh to load the workspace Git diff against HEAD.
          </div>
        )}

        {gitDiff && gitDiff.files.length === 0 && (
          <div style={{ padding: 24, color: "var(--ink-muted)", fontSize: "var(--text-sm)", textAlign: "center" }}>
            Working tree is clean — no changes against HEAD.
          </div>
        )}

        {gitDiff?.files.map((f) => {
          const isCollapsed = collapsed.has(f.path);
          return (
            <div
              key={f.path}
              ref={(el) => {
                if (el) fileRefs.current.set(f.path, el);
                else fileRefs.current.delete(f.path);
              }}
              className="iab-diff-file"
              style={{ borderBottom: "1px solid var(--border-hairline)" }}
            >
              <button
                type="button"
                className="iab-diff-file-head"
                aria-expanded={!isCollapsed}
                onClick={() => toggle(f.path)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  padding: "7px 14px",
                  border: "none",
                  background: "var(--bg-surface-1)",
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
                    flexShrink: 0,
                  }}
                />
                <span
                  className="mono-tag"
                  style={{
                    fontSize: "var(--text-2xs)",
                    color:
                      f.status === "added" || f.status === "untracked"
                        ? "var(--status-success-ink)"
                        : f.status === "deleted"
                          ? "var(--status-danger-ink)"
                          : "var(--ink-secondary)",
                  }}
                >
                  {STATUS_CODE[f.status] ?? f.status}
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
                <span style={{ flex: 1 }} />
                <span style={{ color: "var(--status-success-ink)", fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)" }}>
                  +{f.added}
                </span>
                <span style={{ color: "var(--status-danger-ink)", fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)" }}>
                  -{f.removed}
                </span>
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
                    background: "var(--bg-canvas)",
                  }}
                >
                  {f.patch.split("\n").map((line, i) => {
                    const isAdd = line.startsWith("+") && !line.startsWith("+++");
                    const isDel = line.startsWith("-") && !line.startsWith("---");
                    const isHunk = line.startsWith("@@");
                    const isMeta =
                      line.startsWith("+++") ||
                      line.startsWith("---") ||
                      line.startsWith("diff ") ||
                      line.startsWith("index ");
                    return (
                      <div
                        key={i}
                        className={`iab-diff-line ${isAdd ? "add" : isDel ? "del" : isHunk ? "hunk" : ""}`}
                        style={{
                          padding: "0 14px",
                          whiteSpace: "pre",
                          background: isAdd
                            ? "var(--status-success-bg)"
                            : isDel
                              ? "var(--status-danger-bg)"
                              : isHunk
                                ? "var(--status-active-bg)"
                                : "transparent",
                          color: isAdd
                            ? "var(--status-success-ink)"
                            : isDel
                              ? "var(--status-danger-ink)"
                              : isHunk
                                ? "var(--status-active-ink)"
                                : isMeta
                                  ? "var(--ink-faint)"
                                  : "var(--ink-secondary)",
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
                  No text patch preview available (binary or oversized file).
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
