import { Check, Copy, FileCode2, ShieldAlert } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import { formatBytes } from "./types";

export interface CodeViewerProps {
  projectId: string;
  agentId?: string | null;
  filePath: string;
}

interface RepoFileContent {
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
}

interface CodeToken {
  text: string;
  cls: "comment" | "string" | "keyword" | "number" | null;
}

const CODE_TOKEN_RE =
  /(\/\/.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:const|let|var|function|return|if|elif|else|for|while|import|export|from|as|type|interface|class|extends|implements|new|await|async|try|catch|finally|throw|switch|case|default|break|continue|do|in|of|typeof|instanceof|void|delete|yield|static|get|set|this|super|readonly|public|private|protected|def|lambda|None|True|False|and|or|not|is|global|nonlocal|pass|raise|with|local|end|then|repeat|until|self|nil|fn|pub|use|mod|struct|enum|impl|trait|match|mut|ref|where|crate|SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|CREATE|TABLE|print|echo)\b)|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\/\*.*?\*\/)/g;

const CODE_TOKEN_STYLE: Record<NonNullable<CodeToken["cls"]>, CSSProperties> = {
  comment: { color: "var(--ink-faint)", fontStyle: "italic" },
  string: { color: "var(--status-success-ink)" },
  keyword: { color: "var(--status-active-ink)", fontWeight: "var(--weight-medium)" },
  number: { color: "var(--status-warning-ink)" },
};

function tokenizeCodeLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const hashComment = /^\s*#/.exec(line);
  const scanUpto = hashComment ? hashComment.index + (line.match(/^\s*/)![0].length) : line.length;
  let last = 0;
  CODE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_TOKEN_RE.exec(line)) !== null) {
    if (m.index >= scanUpto) break;
    if (m.index > last) tokens.push({ text: line.slice(last, m.index), cls: null });
    const cls: CodeToken["cls"] =
      m[1] !== undefined || m[5] !== undefined
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

const CodeLineRow = memo(function CodeLineRow({
  lineNumber,
  tokens,
}: {
  lineNumber: number;
  tokens: CodeToken[];
}) {
  return (
    <div className="iab-code-line" style={{ display: "flex", minHeight: "1.6em" }}>
      <span
        className="iab-code-linenum"
        aria-hidden="true"
        style={{
          width: 46,
          flexShrink: 0,
          textAlign: "right",
          paddingRight: 12,
          color: "var(--ink-faint)",
          userSelect: "none",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {lineNumber}
      </span>
      <code style={{ whiteSpace: "pre", flex: 1, paddingRight: 16 }}>
        {tokens.length === 0
          ? " "
          : tokens.map((tok, j) =>
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
  );
});

function formatCodeError(code: number, message: string): string {
  switch (code) {
    case 403:
      return "Access denied (403) — this file lies outside the allowed workspace scope or is protected.";
    case 413:
      return "File too large (413) — preview exceeds the maximum readable file size.";
    case 415:
      return "Binary file (415) — non-text files cannot be displayed in the code viewer.";
    case 404:
      return "File not found (404) — this path does not exist in the selected workspace.";
    default:
      return `Unable to load file (${message || `HTTP ${code}`}).`;
  }
}

export function CodeViewer({ projectId, agentId, filePath }: CodeViewerProps): JSX.Element {
  const [file, setFile] = useState<RepoFileContent | null>(null);
  const [error, setError] = useState<{ code: number; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fileUrl =
    `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(filePath)}` +
    (agentId ? `&agentId=${encodeURIComponent(agentId)}` : "");

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setFile(null);
    setError(null);
    setCopied(false);
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
        if (alive) setError({ code: err.code ?? 0, message: err.message ?? "Unknown error" });
      });
    return () => {
      alive = false;
    };
  }, [fileUrl]);

  const tokenizedLines = useMemo(() => {
    if (!file) return [];
    return file.content.split("\n").map((line) => (line.length === 0 ? [] : tokenizeCodeLine(line)));
  }, [file]);

  const copyContent = async () => {
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="iab-code-stage"
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "#FFFFFF",
      }}
    >
      <div
        className="iab-code-meta"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "#FAFAFA",
          fontSize: "var(--text-2xs)",
          color: "var(--ink-muted)",
          flexShrink: 0,
        }}
      >
        <FileCode2 size={12} strokeWidth={1.6} />
        <span className="mono-tag" style={{ overflowWrap: "anywhere" }}>
          {filePath}
        </span>
        {file && (
          <>
            <span className="mono-tag">{formatBytes(file.sizeBytes)}</span>
            <span className="mono-tag">{tokenizedLines.length} lines</span>
          </>
        )}
        {file?.truncated && (
          <span className="pill warning" style={{ fontSize: "var(--text-2xs)" }}>
            truncated
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn xs iab-copy-btn"
          onClick={() => void copyContent()}
          disabled={!file}
          title="Copy file contents"
        >
          {copied ? <Check size={11} strokeWidth={1.8} /> : <Copy size={11} strokeWidth={1.6} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>

      {error && (
        <div
          className="iab-error-banner"
          role="alert"
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
          <span>{formatCodeError(error.code, error.message)}</span>
        </div>
      )}

      {!file && !error && (
        <div style={{ padding: 16, color: "var(--ink-muted)", fontSize: "var(--text-sm)" }}>
          Loading source file...
        </div>
      )}

      {file && (
        <div style={{ flex: 1, overflow: "auto", minHeight: 0, background: "#FFFFFF" }}>
          <pre
            className="iab-code-pre"
            style={{
              margin: 0,
              padding: "10px 0",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              lineHeight: 1.6,
              color: "var(--ink-primary)",
            }}
          >
            {tokenizedLines.map((tokens, i) => (
              <CodeLineRow key={i} lineNumber={i + 1} tokens={tokens} />
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
