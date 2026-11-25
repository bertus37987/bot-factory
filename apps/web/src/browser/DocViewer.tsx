import { Check, Copy, FileWarning, MessageSquare, Pencil, Pin, Save, X } from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type { AnnotationAnchor, AnnotationRecord } from "@bot-factory/shared";
import { AttachmentActions, AttachmentDestinations } from "./AttachmentActions";
import { quickHash, type ComposerAttachment } from "./types";

export interface DocViewerProps {
  projectId: string;
  filePath: string;
  annotate?: boolean;
  annotations?: AnnotationRecord[];
  focusBlockId?: string | null;
  focusNonce?: number;
  artifactVersion?: number;
  onPickAnchor?: (anchor: AnnotationAnchor) => void;
  onImportToChat?: (attachment: ComposerAttachment, destinationKey?: string) => boolean;
  onArtifactSaved?: (filePath: string) => void;
}

type TableAlign = "left" | "center" | "right";

type ParsedMdBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; lang: string; code: string }
  | { kind: "table"; headers: string[]; alignments: TableAlign[]; rows: string[][] }
  | { kind: "blockquote"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: Array<{ text: string; checked?: boolean }> }
  | { kind: "hr" }
  | { kind: "paragraph"; text: string };

interface MdBlock {
  blockId: string;
  contentHash: string;
  raw: string;
  parsed: ParsedMdBlock;
}

interface PendingDocComment {
  quote: string;
  blockId?: string;
  contentHash?: string;
  top: number;
  left: number;
}

const TABLE_SEP_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function parseTableAlignments(sepLine: string): TableAlign[] {
  return splitTableCells(sepLine).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

function isBlockStarter(line: string, nextLine?: string): boolean {
  if (/^\s*$/.test(line)) return true;
  if (/^\s*(?:```|~~~)/.test(line)) return true;
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^(?:---+|===+|\*\*\*+)\s*$/.test(line)) return true;
  if (/^\s*>/.test(line)) return true;
  if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) return true;
  if (line.includes("|") && nextLine !== undefined && TABLE_SEP_RE.test(nextLine)) return true;
  return false;
}

function parseMarkdownBlocks(markdown: string): MdBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  const pushBlock = (raw: string, parsed: ParsedMdBlock) => {
    const clean = raw.trim();
    if (!clean) return;
    const idx = blocks.length;
    const slug = clean
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28);
    blocks.push({
      blockId: `blk-${idx}-${slug || "section"}`,
      contentHash: quickHash(clean),
      raw: clean,
      parsed,
    });
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    const fenceMatch = /^\s*(```+|~~~+)\s*([a-zA-Z0-9_+-]*).*$/.exec(line);
    if (fenceMatch) {
      const fenceToken = fenceMatch[1]!.slice(0, 3);
      const lang = fenceMatch[2] ?? "";
      const start = i;
      i += 1;
      const codeLines: string[] = [];
      while (i < lines.length && !new RegExp(`^\\s*${fenceToken}`).test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const raw = lines.slice(start, i).join("\n");
      pushBlock(raw, { kind: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      pushBlock(line, {
        kind: "heading",
        level: headingMatch[1]!.length,
        text: headingMatch[2]!.trim(),
      });
      i += 1;
      continue;
    }

    if (/^(?:---+|===+|\*\*\*+)\s*$/.test(line)) {
      pushBlock(line, { kind: "hr" });
      i += 1;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]!)) {
      const start = i;
      const headers = splitTableCells(line);
      const alignments = parseTableAlignments(lines[i + 1]!);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && !/^\s*$/.test(lines[i]!)) {
        rows.push(splitTableCells(lines[i]!));
        i += 1;
      }
      pushBlock(lines.slice(start, i).join("\n"), {
        kind: "table",
        headers,
        alignments,
        rows,
      });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const start = i;
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i += 1;
      }
      pushBlock(lines.slice(start, i).join("\n"), {
        kind: "blockquote",
        lines: quoteLines,
      });
      continue;
    }

    const listStartMatch = /^\s*(?:([-*+])|(\d+)\.)\s+/.exec(line);
    if (listStartMatch) {
      const ordered = listStartMatch[2] !== undefined;
      const itemRe = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      const start = i;
      const items: Array<{ text: string; checked?: boolean }> = [];
      while (i < lines.length && itemRe.test(lines[i]!)) {
        const m = itemRe.exec(lines[i]!)!;
        let itemText = m[1]!;
        let checked: boolean | undefined;
        const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(itemText);
        if (taskMatch) {
          checked = taskMatch[1]!.toLowerCase() === "x";
          itemText = taskMatch[2]!;
        }
        i += 1;
        while (
          i < lines.length &&
          !/^\s*$/.test(lines[i]!) &&
          !itemRe.test(lines[i]!) &&
          !isBlockStarter(lines[i]!, lines[i + 1])
        ) {
          itemText += ` ${lines[i]!.trim()}`;
          i += 1;
        }
        items.push({ text: itemText, checked });
      }
      pushBlock(lines.slice(start, i).join("\n"), {
        kind: "list",
        ordered,
        items,
      });
      continue;
    }

    const start = i;
    const paraLines: string[] = [];
    while (i < lines.length && !isBlockStarter(lines[i]!, lines[i + 1])) {
      paraLines.push(lines[i]!.trim());
      i += 1;
    }
    if (paraLines.length === 0) {
      paraLines.push(line.trim());
      i += 1;
    }
    pushBlock(lines.slice(start, i).join("\n"), {
      kind: "paragraph",
      text: paraLines.join(" "),
    });
  }

  return blocks;
}

function sanitizeHref(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (v.startsWith("#") || v.startsWith("/") || v.startsWith("./") || v.startsWith("../")) {
    return v;
  }
  try {
    const parsed = new URL(v);
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      return parsed.href;
    }
  } catch {
    return null;
  }
  return null;
}

function renderInlineMarkdown(text: string, disableLinks: boolean): ReactNode[] {
  const tokenRe = /(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*]+\*|_[^_]+_)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > last) {
      out.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    }
    const tok = m[0];
    if (tok.startsWith("`") && tok.endsWith("`") && tok.length > 2) {
      out.push(
        <code
          key={key++}
          className="iab-md-code"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.87em",
            background: "var(--bg-surface-subtle)",
            border: "1px solid var(--border-hairline)",
            borderRadius: "var(--radius-xs)",
            padding: "1px 5px",
            color: "var(--ink-primary)",
          }}
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      const label = linkMatch?.[1] ?? tok;
      const safeHref = linkMatch ? sanitizeHref(linkMatch[2]!) : null;
      if (safeHref) {
        out.push(
          <a
            key={key++}
            href={safeHref}
            target={safeHref.startsWith("#") ? undefined : "_blank"}
            rel={safeHref.startsWith("#") ? undefined : "noopener noreferrer"}
            className="iab-md-link"
            onClick={(e) => {
              if (disableLinks) {
                e.preventDefault();
              } else {
                e.stopPropagation();
              }
            }}
            style={{
              color: "var(--accent-orange-ink, var(--accent-orange))",
              textDecoration: "underline",
              textUnderlineOffset: 2,
            }}
          >
            {label}
          </a>,
        );
      } else {
        out.push(<span key={key++}>{label}</span>);
      }
    } else if (tok.startsWith("**") && tok.endsWith("**") && tok.length > 4) {
      out.push(
        <strong key={key++} style={{ fontWeight: "var(--weight-semibold)", color: "var(--ink-primary)" }}>
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("~~") && tok.endsWith("~~") && tok.length > 4) {
      out.push(<del key={key++}>{tok.slice(2, -2)}</del>);
    } else if ((tok.startsWith("*") && tok.endsWith("*")) || (tok.startsWith("_") && tok.endsWith("_"))) {
      out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    } else {
      out.push(<span key={key++}>{tok}</span>);
    }
    last = m.index + tok.length;
  }

  if (last < text.length) {
    out.push(<span key={key++}>{text.slice(last)}</span>);
  }
  return out;
}

function FencedCodeBlock({ lang, code, annotate }: { lang: string; code: string; annotate: boolean }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="iab-md-codeblock"
      style={{
        border: "1px solid var(--border-hairline)",
        borderRadius: "var(--radius-md)",
        background: "var(--bg-surface)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "5px 10px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-surface-subtle)",
          fontSize: "var(--text-2xs)",
          color: "var(--ink-muted)",
        }}
      >
        <span className="mono-tag">{lang || "code"}</span>
        {!annotate && (
          <button
            type="button"
            className="btn xs ghost"
            onClick={(e) => void handleCopy(e)}
            onDoubleClick={(e) => e.stopPropagation()}
            title="Copy code block"
          >
            {copied ? <Check size={11} strokeWidth={1.8} /> : <Copy size={11} strokeWidth={1.6} />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        )}
      </div>
      <pre
        style={{
          margin: 0,
          padding: "10px 12px",
          overflowX: "auto",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          lineHeight: 1.55,
          color: "var(--ink-primary)",
          background: "var(--bg-canvas)",
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

function MarkdownBlockBody({ parsed, annotate }: { parsed: ParsedMdBlock; annotate: boolean }) {
  switch (parsed.kind) {
    case "heading": {
      const level = Math.min(4, parsed.level);
      const sizeMap: Record<number, string> = {
        1: "var(--text-xl)",
        2: "var(--text-lg)",
        3: "var(--text-base)",
        4: "var(--text-sm)",
      };
      return (
        <div
          className={`iab-md-h${level}`}
          style={{
            fontSize: sizeMap[level] ?? "var(--text-base)",
            fontWeight: "var(--weight-semibold)",
            letterSpacing: "var(--tracking-tight)",
            color: "var(--ink-primary)",
            lineHeight: "var(--leading-snug)",
            marginTop: level === 1 ? 4 : 2,
          }}
        >
          {renderInlineMarkdown(parsed.text, annotate)}
        </div>
      );
    }

    case "hr":
      return <hr style={{ border: "none", borderTop: "1px solid var(--border-hairline)", margin: "4px 0" }} />;

    case "code":
      return <FencedCodeBlock lang={parsed.lang} code={parsed.code} annotate={annotate} />;

    case "table":
      return (
        <div
          className="iab-md-table-wrap"
          style={{
            overflowX: "auto",
            border: "1px solid var(--border-hairline)",
            borderRadius: "var(--radius-md)",
            background: "var(--bg-canvas)",
          }}
        >
          <table
            className="iab-md-table"
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "var(--text-xs)",
              lineHeight: 1.45,
            }}
          >
            <thead>
              <tr style={{ background: "var(--bg-surface)", borderBottom: "1px solid var(--border-hairline)" }}>
                {parsed.headers.map((header, idx) => (
                  <th
                    key={idx}
                    style={{
                      textAlign: parsed.alignments[idx] ?? "left",
                      padding: "7px 10px",
                      fontWeight: "var(--weight-semibold)",
                      color: "var(--ink-primary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {renderInlineMarkdown(header, annotate)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((row, rIdx) => (
                <tr
                  key={rIdx}
                  style={{
                    borderBottom: rIdx < parsed.rows.length - 1 ? "1px solid var(--border-subtle)" : "none",
                  }}
                >
                  {parsed.headers.map((_, cIdx) => (
                    <td
                      key={cIdx}
                      style={{
                        textAlign: parsed.alignments[cIdx] ?? "left",
                        padding: "6px 10px",
                        color: "var(--ink-secondary)",
                      }}
                    >
                      {renderInlineMarkdown(row[cIdx] ?? "", annotate)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "blockquote":
      return (
        <blockquote
          className="iab-md-quote"
          style={{
            margin: 0,
            padding: "4px 12px",
            borderLeft: "2.5px solid var(--accent-orange)",
            background: "var(--bg-surface)",
            borderRadius: "0 var(--radius-xs) var(--radius-xs) 0",
            color: "var(--ink-secondary)",
            fontSize: "var(--text-base)",
            lineHeight: "var(--leading-prose)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {parsed.lines.map((line, idx) => (
            <div key={idx}>{renderInlineMarkdown(line, annotate)}</div>
          ))}
        </blockquote>
      );

    case "list": {
      const ListTag = parsed.ordered ? "ol" : "ul";
      const hasTask = parsed.items.some((item) => item.checked !== undefined);
      return (
        <ListTag
          className="iab-md-list"
          style={{
            margin: 0,
            paddingLeft: hasTask ? 4 : 22,
            listStyleType: hasTask ? "none" : parsed.ordered ? "decimal" : "disc",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            color: "var(--ink-primary)",
            fontSize: "var(--text-base)",
            lineHeight: "var(--leading-prose)",
          }}
        >
          {parsed.items.map((item, idx) => (
            <li key={idx} style={{ display: hasTask ? "flex" : undefined, alignItems: "flex-start", gap: 8 }}>
              {item.checked !== undefined && (
                <span
                  aria-hidden="true"
                  style={{
                    width: 14,
                    height: 14,
                    marginTop: 4,
                    borderRadius: 3,
                    border: item.checked ? "1px solid var(--accent-orange)" : "1px solid var(--border-strong)",
                    background: item.checked ? "var(--accent-orange)" : "var(--bg-canvas)",
                    color: "var(--action-primary-fg, #ffffff)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {item.checked && <Check size={10} strokeWidth={2.4} />}
                </span>
              )}
              <span>{renderInlineMarkdown(item.text, annotate)}</span>
            </li>
          ))}
        </ListTag>
      );
    }

    case "paragraph":
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
          {renderInlineMarkdown(parsed.text, annotate)}
        </p>
      );
  }
}

export function DocViewer({
  projectId,
  filePath,
  annotate = false,
  annotations = [],
  focusBlockId,
  focusNonce = 0,
  artifactVersion = 0,
  onPickAnchor,
  onImportToChat,
  onArtifactSaved,
}: DocViewerProps): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);
  const [pendingComment, setPendingComment] = useState<PendingDocComment | null>(null);
  const [commentText, setCommentText] = useState("");

  const stageRef = useRef<HTMLDivElement | null>(null);
  const contentWrapRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const commentInputRef = useRef<HTMLTextAreaElement | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const artifactUrl = `/api/projects/${encodeURIComponent(projectId)}/artifact?path=${encodeURIComponent(filePath)}`;

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setError(null);
    fetch(artifactUrl)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((t) => {
        if (!alive) return;
        setText(t);
        setDraft((prev) => (isEditing ? prev : t));
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [artifactUrl, artifactVersion]);

  useEffect(() => {
    setIsEditing(false);
    setPendingComment(null);
    setCommentText("");
    setSaveError(null);
    setSavedNotice(false);
  }, [filePath]);

  useEffect(() => {
    if (isEditing) {
      editorRef.current?.focus();
    }
  }, [isEditing]);

  useEffect(() => {
    if (pendingComment) {
      setTimeout(() => commentInputRef.current?.focus(), 0);
    }
  }, [pendingComment]);

  const blocks = useMemo(() => (text === null ? [] : parseMarkdownBlocks(text)), [text]);
  const isDirty = isEditing && text !== null && draft !== text;

  useEffect(() => {
    if (!focusBlockId || !stageRef.current) return;
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(focusBlockId)
        : focusBlockId.replace(/"/g, '\\"');
    const el = stageRef.current.querySelector(`[data-block-id="${escaped}"]`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusBlockId, focusNonce, blocks.length]);

  const enterEditMode = () => {
    if (text === null) return;
    setPendingComment(null);
    setCommentText("");
    setSaveError(null);
    setDraft(text);
    setIsEditing(true);
  };

  const cancelEditMode = () => {
    setIsEditing(false);
    setDraft(text ?? "");
    setSaveError(null);
  };

  const saveEdit = async () => {
    if (saving || text === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(artifactUrl, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft, encoding: "utf8" }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data?.error) msg = data.error;
        } catch {
          // Use status fallback.
        }
        throw new Error(msg);
      }
      setText(draft);
      setIsEditing(false);
      setSavedNotice(true);
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => {
        setSavedNotice(false);
        savedTimerRef.current = null;
      }, 2200);
      onArtifactSaved?.(filePath);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const openBlockComment = (b: MdBlock, blockEl: HTMLElement | null) => {
    const wrap = contentWrapRef.current;
    let top = 24;
    let left = 12;
    if (wrap && blockEl) {
      const wrapRect = wrap.getBoundingClientRect();
      const bRect = blockEl.getBoundingClientRect();
      top = Math.max(8, bRect.bottom - wrapRect.top + 6);
      left = Math.max(8, Math.min(bRect.left - wrapRect.left, Math.max(8, wrapRect.width - 332)));
    }
    setCommentText("");
    setPendingComment({
      quote: b.raw.slice(0, 240),
      blockId: b.blockId,
      contentHash: b.contentHash,
      top,
      left,
    });
  };

  const handleBodyMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isEditing || e.detail >= 2) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, a, .iab-doc-comment-popover")) return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const quote = sel.toString().trim();
    if (quote.length < 2) return;

    const wrap = contentWrapRef.current;
    if (!wrap) return;
    const range = sel.getRangeAt(0);
    if (!wrap.contains(range.commonAncestorContainer)) return;

    const wrapRect = wrap.getBoundingClientRect();
    const rRect = range.getBoundingClientRect();
    const top = Math.max(8, rRect.bottom - wrapRect.top + 8);
    const left = Math.max(8, Math.min(rRect.left - wrapRect.left, Math.max(8, wrapRect.width - 332)));

    setCommentText("");
    setPendingComment({
      quote: quote.slice(0, 400),
      top,
      left,
    });
  };

  const destinations = useContext(AttachmentDestinations);
  const submitDocComment = (destinationKey?: string) => {
    if (!pendingComment) return;
    const trimmed = commentText.trim();
    if (!trimmed) return;

    if (onImportToChat) {
      if (!onImportToChat({
        id: `att_doc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        kind: "doc_comment",
        filePath,
        label: filePath.split("/").pop() ?? filePath,
        quote: pendingComment.quote,
        comment: trimmed,
      }, destinationKey)) return;
    } else if (onPickAnchor) {
      onPickAnchor({
        kind: "doc",
        filePath,
        blockId: pendingComment.blockId ?? `sel-${quickHash(pendingComment.quote)}`,
        contentHash: pendingComment.contentHash ?? quickHash(pendingComment.quote),
        quote: pendingComment.quote.slice(0, 140),
      });
    }

    window.getSelection()?.removeAllRanges();
    setPendingComment(null);
    setCommentText("");
  };

  return (
    <div
      ref={stageRef}
      className="iab-doc-stage doc-stage"
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-canvas)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Compact Doc Header Bar */}
      <div
        className="iab-doc-header"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "7px 16px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-surface)",
          flexShrink: 0,
          fontSize: "var(--text-2xs)",
          color: "var(--ink-muted)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span className="mono-tag" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {filePath.split("/").pop() ?? filePath}
          </span>
          {isDirty && (
            <span
              data-testid="doc-unsaved-indicator"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                color: "var(--accent-orange)",
                fontWeight: "var(--weight-medium)",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--accent-orange)",
                }}
              />
              Unsaved
            </span>
          )}
          {savedNotice && !isDirty && (
            <span className="pill success" style={{ fontSize: "var(--text-2xs)" }}>
              <Check size={10} strokeWidth={2.2} />
              Saved
            </span>
          )}
          {!isEditing && text !== null && (
            <span style={{ color: "var(--ink-faint)", whiteSpace: "nowrap" }}>
              Double-click to edit · Select text to comment
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {!isEditing ? (
            <button
              type="button"
              className="btn xs"
              data-testid="doc-edit-btn"
              disabled={text === null || Boolean(error)}
              onClick={enterEditMode}
              title="Edit markdown inline"
            >
              <Pencil size={11} strokeWidth={1.6} />
              <span>Edit</span>
            </button>
          ) : (
            <>
              <button type="button" className="btn xs" onClick={cancelEditMode} disabled={saving}>
                <X size={11} strokeWidth={1.6} />
                <span>Cancel</span>
              </button>
              <button
                type="button"
                className="btn xs primary"
                data-testid="doc-save-btn"
                onClick={() => void saveEdit()}
                disabled={saving}
                title="Save changes (Ctrl+S)"
              >
                <Save size={11} strokeWidth={1.6} />
                <span>{saving ? "Saving..." : "Save"}</span>
              </button>
            </>
          )}
        </div>
      </div>

      {saveError && (
        <div
          className="inline-error"
          role="alert"
          style={{ margin: "10px 16px 0", flexShrink: 0 }}
        >
          <span>Failed to save: {saveError}</span>
          <button type="button" className="btn xs ghost" onClick={() => setSaveError(null)} aria-label="Dismiss save error">
            <X size={11} strokeWidth={1.6} />
          </button>
        </div>
      )}

      {/* Main Scrollable Doc Body / Inline Editor */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: isEditing ? "14px 20px 24px" : "20px 28px 56px",
          background: "var(--bg-canvas)",
        }}
      >
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
            <FileWarning size={14} strokeWidth={1.6} />
            <span>Failed to load document ({error}).</span>
          </div>
        )}

        {text === null && !error && (
          <div style={{ color: "var(--ink-muted)", fontSize: "var(--text-sm)" }}>Loading document...</div>
        )}

        {isEditing && text !== null && (
          <div style={{ maxWidth: "var(--measure-prose)", margin: "0 auto", height: "100%", display: "flex", flexDirection: "column" }}>
            <textarea
              ref={editorRef}
              data-testid="doc-editor-textarea"
              aria-label="Edit markdown document"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void saveEdit();
                } else if (e.key === "Escape" && !isDirty) {
                  e.preventDefault();
                  cancelEditMode();
                }
              }}
              style={{
                width: "100%",
                flex: 1,
                minHeight: 360,
                resize: "vertical",
                padding: "14px 16px",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-strong)",
                background: "var(--bg-surface)",
                color: "var(--ink-primary)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                lineHeight: 1.65,
                outline: "none",
              }}
            />
          </div>
        )}

        {!isEditing && text !== null && !error && (
          <div
            ref={contentWrapRef}
            className="iab-doc-body"
            onMouseUp={handleBodyMouseUp}
            onDoubleClick={(e) => {
              const target = e.target as HTMLElement | null;
              if (target?.closest("button, a, .iab-doc-comment-popover")) return;
              enterEditMode();
            }}
            style={{
              maxWidth: "var(--measure-prose)",
              margin: "0 auto",
              display: "flex",
              flexDirection: "column",
              gap: 14,
              position: "relative",
              minHeight: 120,
            }}
          >
            {blocks.length === 0 && (
              <div style={{ color: "var(--ink-muted)", fontSize: "var(--text-sm)" }}>
                Document is empty. Click Edit or double-click here to write markdown.
              </div>
            )}

            {blocks.map((b) => {
              const matchingPins = annotations.filter(
                (a) =>
                  a.anchor.kind === "doc" && (a.anchor.blockId === b.blockId || a.anchor.contentHash === b.contentHash),
              );
              const pinned = matchingPins.length > 0;
              const isFocused = focusBlockId === b.blockId;
              const isHovered = hoveredBlockId === b.blockId;

              return (
                <div
                  key={b.blockId}
                  data-block-id={b.blockId}
                  className={`doc-block iab-doc-block ${pinned ? "has-pin" : ""}`}
                  onMouseEnter={() => setHoveredBlockId(b.blockId)}
                  onMouseLeave={() => setHoveredBlockId((cur) => (cur === b.blockId ? null : cur))}
                  style={{
                    position: "relative",
                    borderRadius: "var(--radius-sm)",
                    padding: "4px 10px",
                    margin: "0 -10px",
                    borderLeft: pinned
                      ? "2.5px solid var(--accent-orange)"
                      : isFocused
                        ? "2.5px solid var(--ink-primary)"
                        : "2.5px solid transparent",
                    background: isFocused
                      ? "var(--accent-orange-soft)"
                      : pinned
                        ? "var(--accent-orange-soft)"
                        : isHovered
                          ? "var(--bg-surface)"
                          : "transparent",
                    transition: "background var(--duration-fast) var(--ease-out-quiet)",
                  }}
                >
                  {pinned && (
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        marginBottom: 4,
                        padding: "1px 7px",
                        borderRadius: "var(--radius-pill)",
                        background: "var(--accent-orange)",
                        color: "var(--action-primary-fg, #ffffff)",
                        fontSize: "var(--text-2xs)",
                        fontWeight: "var(--weight-semibold)",
                      }}
                    >
                      <Pin size={10} strokeWidth={2} />
                      <span>
                        {matchingPins.length} {matchingPins.length === 1 ? "Pin" : "Pins"}
                      </span>
                    </div>
                  )}

                  <button
                    type="button"
                    aria-label="Comment on block"
                    title="Comment -> Chat"
                    onClick={(e) => {
                      e.stopPropagation();
                      openBlockComment(b, e.currentTarget.parentElement);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    style={{
                      position: "absolute",
                      top: 4,
                      right: 6,
                      zIndex: 3,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 7px",
                      borderRadius: "var(--radius-pill)",
                      border: "1px solid var(--border-hairline)",
                      background: "var(--bg-elevated, var(--bg-canvas))",
                      color: "var(--ink-secondary)",
                      fontSize: "var(--text-2xs)",
                      cursor: "pointer",
                      opacity: isHovered ? 1 : 0,
                      pointerEvents: isHovered ? "auto" : "none",
                      transition: "opacity 120ms ease",
                      boxShadow: "var(--shadow-popover)",
                    }}
                  >
                    <MessageSquare size={10} strokeWidth={1.7} />
                    <span>Comment</span>
                  </button>

                  <MarkdownBlockBody parsed={b.parsed} annotate={annotate} />
                </div>
              );
            })}

            {/* Lightweight Anchored Floating Comment-to-Chat Popover */}
            {pendingComment && (
              <div
                className="iab-doc-comment-popover"
                role="dialog"
                aria-label="Comment to chat"
                onDoubleClick={(e) => e.stopPropagation()}
                style={{
                  position: "absolute",
                  top: pendingComment.top,
                  left: pendingComment.left,
                  width: 320,
                  maxWidth: "calc(100% - 16px)",
                  background: "var(--bg-elevated, var(--bg-canvas))",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "var(--radius-lg)",
                  boxShadow: "var(--shadow-modal)",
                  padding: 10,
                  zIndex: 20,
                  display: "flex",
                  flexDirection: "column",
                  gap: 7,
                }}
              >
                <div
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--ink-muted)",
                    borderLeft: "2px solid var(--accent-orange)",
                    paddingLeft: 8,
                    maxHeight: 54,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {pendingComment.quote}
                </div>
                <textarea
                  ref={commentInputRef}
                  rows={2}
                  placeholder="Add a comment to import into chat..."
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  onKeyDown={(e) => {
                    if (!destinations && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      submitDocComment();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setPendingComment(null);
                    }
                  }}
                  style={{
                    width: "100%",
                    resize: "vertical",
                    padding: "6px 8px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border-hairline)",
                    background: "var(--bg-surface)",
                    color: "var(--ink-primary)",
                    fontSize: "var(--text-xs)",
                    lineHeight: 1.45,
                    outline: "none",
                  }}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                  <button
                    type="button"
                    className="btn xs ghost"
                    onClick={() => {
                      setPendingComment(null);
                      setCommentText("");
                    }}
                  >
                    Cancel
                  </button>
                  <AttachmentActions destinations={destinations} disabled={!commentText.trim()} onAdd={submitDocComment} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
