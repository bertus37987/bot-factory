import { Check, Copy, FileWarning, Pin } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type { AnnotationAnchor, AnnotationRecord } from "@bot-factory/shared";
import { quickHash } from "./types";

export interface DocViewerProps {
  projectId: string;
  filePath: string;
  annotate: boolean;
  annotations: AnnotationRecord[];
  focusBlockId?: string | null;
  focusNonce?: number;
  artifactVersion?: number;
  onPickAnchor: (anchor: AnnotationAnchor) => void;
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

    // Fenced code block (``` or ~~~)
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

    // Heading
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

    // Horizontal rule
    if (/^(?:---+|===+|\*\*\*+)\s*$/.test(line)) {
      pushBlock(line, { kind: "hr" });
      i += 1;
      continue;
    }

    // Markdown table
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

    // Blockquote
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

    // Unordered, ordered, or task list
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

    // Paragraph
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
            background: "#F5F5F5",
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
              color: "#D95D22",
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
    } else if (
      (tok.startsWith("*") && tok.endsWith("*")) ||
      (tok.startsWith("_") && tok.endsWith("_"))
    ) {
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
        background: "#FAFAFA",
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
          background: "#F5F5F5",
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
          background: "#FFFFFF",
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
            background: "#FFFFFF",
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
              <tr style={{ background: "#FAFAFA", borderBottom: "1px solid var(--border-hairline)" }}>
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
            borderLeft: "2.5px solid #D95D22",
            background: "#FAFAFA",
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
                    border: item.checked ? "1px solid #D95D22" : "1px solid var(--border-strong)",
                    background: item.checked ? "#D95D22" : "#FFFFFF",
                    color: "#FFFFFF",
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
  annotate,
  annotations,
  focusBlockId,
  focusNonce = 0,
  artifactVersion = 0,
  onPickAnchor,
}: DocViewerProps): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const artifactUrl = `/api/projects/${encodeURIComponent(projectId)}/artifact?path=${encodeURIComponent(filePath)}`;

  useEffect(() => {
    let alive = true;
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
  }, [artifactUrl, artifactVersion]);

  const blocks = useMemo(() => (text === null ? [] : parseMarkdownBlocks(text)), [text]);

  useEffect(() => {
    if (!focusBlockId || !stageRef.current) return;
    const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(focusBlockId)
      : focusBlockId.replace(/"/g, '\\"');
    const el = stageRef.current.querySelector(`[data-block-id="${escaped}"]`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusBlockId, focusNonce, blocks.length]);

  const pickBlock = (b: MdBlock) => {
    onPickAnchor({
      kind: "doc",
      filePath,
      blockId: b.blockId,
      contentHash: b.contentHash,
      quote: b.raw.slice(0, 140),
    });
  };

  return (
    <div
      ref={stageRef}
      className="iab-doc-stage doc-stage"
      style={{
        height: "100%",
        overflowY: "auto",
        padding: "20px 28px 48px",
        background: "#FFFFFF",
      }}
    >
      {annotate && (
        <div
          className="iab-stage-hint"
          style={{
            position: "sticky",
            top: 0,
            zIndex: 4,
            width: "fit-content",
            margin: "0 auto 16px",
            padding: "4px 12px",
            borderRadius: "var(--radius-pill)",
            background: "#FFF7F2",
            border: "1px solid #F7D5C2",
            color: "#B84312",
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-medium)",
          }}
        >
          Annotate mode active — click any document block to drop a pin
        </div>
      )}

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

      {text !== null && blocks.length === 0 && !error && (
        <div style={{ color: "var(--ink-muted)", fontSize: "var(--text-sm)" }}>Document is empty.</div>
      )}

      <div
        style={{
          maxWidth: "var(--measure-prose)",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {blocks.map((b) => {
          const matchingPins = annotations.filter(
            (a) => a.anchor.kind === "doc" && (a.anchor.blockId === b.blockId || a.anchor.contentHash === b.contentHash),
          );
          const pinned = matchingPins.length > 0;
          const isFocused = focusBlockId === b.blockId;

          return (
            <div
              key={b.blockId}
              data-block-id={b.blockId}
              role={annotate ? "button" : undefined}
              tabIndex={annotate ? 0 : undefined}
              className={`doc-block iab-doc-block ${annotate ? "annotatable" : ""} ${pinned ? "has-pin" : ""}`}
              onClick={() => {
                if (annotate) pickBlock(b);
              }}
              onKeyDown={(e) => {
                if (!annotate) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pickBlock(b);
                }
              }}
              style={{
                position: "relative",
                borderRadius: "var(--radius-sm)",
                padding: annotate || pinned ? "6px 10px" : "2px 0",
                margin: annotate || pinned ? "0 -10px" : 0,
                cursor: annotate ? "crosshair" : "default",
                borderLeft: pinned
                  ? "2.5px solid #D95D22"
                  : isFocused
                    ? "2.5px solid #171717"
                    : "2.5px solid transparent",
                background: isFocused
                  ? "#FFF5EF"
                  : pinned
                    ? "#FFF7F2"
                    : "transparent",
                boxShadow: isFocused ? "0 0 0 1px #F7D5C2" : "none",
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
                    background: "#D95D22",
                    color: "#FFFFFF",
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
              <MarkdownBlockBody parsed={b.parsed} annotate={annotate} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
