import { Check, Copy } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";

export interface MarkdownRendererProps {
  content: string;
  className?: string;
}

type MdBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "code"; lang: string; code: string }
  | { kind: "blockquote"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: { text: string; checked?: boolean }[] }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "hr" }
  | { kind: "paragraph"; lines: string[] };

function isSafeLink(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const tokenRe = /(`[^`\n]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      out.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-${idx++}`;

    if (token.startsWith("`") && token.endsWith("`") && token.length >= 2) {
      out.push(
        <code key={key} className="md-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch && isSafeLink(linkMatch[2]!)) {
        out.push(
          <a
            key={key}
            className="md-link"
            href={linkMatch[2]!.trim()}
            target="_blank"
            rel="noopener noreferrer"
          >
            {linkMatch[1]}
          </a>,
        );
      } else {
        out.push(token);
      }
    } else if (
      (token.startsWith("**") && token.endsWith("**")) ||
      (token.startsWith("__") && token.endsWith("__"))
    ) {
      out.push(<strong key={key}>{renderInline(token.slice(2, -2), `${key}-b`)}</strong>);
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      out.push(<del key={key}>{renderInline(token.slice(2, -2), `${key}-d`)}</del>);
    } else if (
      (token.startsWith("*") && token.endsWith("*")) ||
      (token.startsWith("_") && token.endsWith("_"))
    ) {
      out.push(<em key={key}>{renderInline(token.slice(1, -1), `${key}-i`)}</em>);
    } else {
      out.push(token);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    out.push(text.slice(lastIndex));
  }

  return out;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") && !trimmed.includes("-")) return false;
  const cells = splitTableRow(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    const fenceMatch = /^```([^\s`]*)\s*$/.exec(trimmed);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? "";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!.trim())) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ kind: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    if (/^([-*_])\1{2,}\s*$/.test(trimmed)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      blocks.push({
        kind: "heading",
        level: headingMatch[1]!.length as 1 | 2 | 3 | 4,
        text: headingMatch[2]!.trim(),
      });
      i += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "blockquote", lines: quoteLines });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1]!)) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(splitTableRow(lines[i]!));
        i += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    const ulMatch = /^\s*[-*+]\s+(.*)$/.exec(line);
    const olMatch = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ulMatch || olMatch) {
      const ordered = Boolean(olMatch);
      const items: { text: string; checked?: boolean }[] = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        const m = ordered ? /^\s*\d+\.\s+(.*)$/.exec(cur) : /^\s*[-*+]\s+(.*)$/.exec(cur);
        if (!m) break;
        const body = m[1]!;
        const taskMatch = /^\[( |x|X)\]\s+(.*)$/.exec(body);
        if (!ordered && taskMatch) {
          items.push({ checked: taskMatch[1]!.toLowerCase() === "x", text: taskMatch[2]! });
        } else {
          items.push({ text: body });
        }
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i]!;
      const curTrim = cur.trim();
      if (
        !curTrim ||
        /^```/.test(curTrim) ||
        /^(#{1,4})\s+/.test(curTrim) ||
        curTrim.startsWith(">") ||
        /^([-*_])\1{2,}\s*$/.test(curTrim) ||
        /^\s*[-*+]\s+/.test(cur) ||
        /^\s*\d+\.\s+/.test(cur) ||
        (cur.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1]!))
      ) {
        break;
      }
      paraLines.push(cur);
      i += 1;
    }
    if (paraLines.length > 0) {
      blocks.push({ kind: "paragraph", lines: paraLines });
    }
  }

  return blocks;
}

function CodeBlock({ lang, code }: { lang: string; code: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="md-code-block">
      <div className="md-code-head">
        <span>{lang || "code"}</span>
        <button type="button" className="md-code-copy" onClick={handleCopy} aria-label="Copy code">
          {copied ? <Check size={11} strokeWidth={1.8} /> : <Copy size={11} strokeWidth={1.6} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="md-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps): JSX.Element {
  const blocks = useMemo(() => parseMarkdown(content ?? ""), [content]);

  return (
    <div className={`md-root ${className ?? ""}`.trim()}>
      {blocks.map((block, idx) => {
        const key = `md-${idx}`;
        switch (block.kind) {
          case "heading": {
            const Tag = block.level === 1 ? "h1" : block.level === 2 ? "h2" : block.level === 3 ? "h3" : "h4";
            return (
              <Tag key={key} className={`md-h${block.level}`}>
                {renderInline(block.text, key)}
              </Tag>
            );
          }
          case "code":
            return <CodeBlock key={key} lang={block.lang} code={block.code} />;
          case "hr":
            return <hr key={key} className="md-hr" />;
          case "blockquote":
            return (
              <blockquote key={key} className="md-blockquote">
                {block.lines.map((line, li) => (
                  <p key={`${key}-q-${li}`} className="md-p">
                    {renderInline(line, `${key}-q-${li}`)}
                  </p>
                ))}
              </blockquote>
            );
          case "table":
            return (
              <div key={key} className="md-table-wrap">
                <table className="md-table">
                  <thead>
                    <tr>
                      {block.headers.map((h, hi) => (
                        <th key={`${key}-th-${hi}`}>{renderInline(h, `${key}-th-${hi}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, ri) => (
                      <tr key={`${key}-tr-${ri}`}>
                        {block.headers.map((_, ci) => (
                          <td key={`${key}-td-${ri}-${ci}`}>
                            {renderInline(row[ci] ?? "", `${key}-td-${ri}-${ci}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "list": {
            const hasTasks = !block.ordered && block.items.some((item) => item.checked !== undefined);
            const ListTag = block.ordered ? "ol" : "ul";
            return (
              <ListTag key={key} className={`md-list ${hasTasks ? "md-task-list" : ""}`.trim()}>
                {block.items.map((item, li) => (
                  <li key={`${key}-li-${li}`} className={item.checked !== undefined ? "md-task-item" : undefined}>
                    {item.checked !== undefined && (
                      <span
                        className={`md-task-box ${item.checked ? "checked" : ""}`.trim()}
                        aria-hidden="true"
                      >
                        {item.checked ? "✓" : ""}
                      </span>
                    )}
                    <span>{renderInline(item.text, `${key}-li-${li}`)}</span>
                  </li>
                ))}
              </ListTag>
            );
          }
          case "paragraph":
            return (
              <p key={key} className="md-p">
                {block.lines.map((line, li) => (
                  <Fragment key={`${key}-p-${li}`}>
                    {li > 0 && <br />}
                    {renderInline(line, `${key}-p-${li}`)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
