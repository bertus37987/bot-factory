import { ShieldAlert } from "lucide-react";
import type { JSX } from "react";
import { validateLoopbackWebUrl } from "./types";

export interface WebViewerProps {
  url: string;
}

export function WebViewer({ url }: WebViewerProps): JSX.Element {
  const validation = validateLoopbackWebUrl(url);

  if (!validation.allowed) {
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
          background: "var(--bg-surface-1)",
        }}
      >
        <ShieldAlert size={22} strokeWidth={1.4} color="var(--status-warning-ink)" />
        <div
          role="alert"
          style={{
            maxWidth: 440,
            padding: "12px 16px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--status-warning-border)",
            background: "var(--status-warning-bg)",
            color: "var(--status-warning-ink)",
            fontSize: "var(--text-sm)",
            lineHeight: "var(--leading-normal)",
          }}
        >
          <div>{validation.message}</div>
          <div style={{ marginTop: 6, fontSize: "var(--text-xs)", color: "var(--ink-secondary)" }}>
            Allowed examples: <code>http://127.0.0.1:3000</code> or <code>http://localhost:8080</code>.
          </div>
        </div>
      </div>
    );
  }

  return (
    <iframe
      className="iab-web-frame"
      title={validation.normalizedUrl}
      src={validation.normalizedUrl}
      sandbox="allow-scripts allow-forms"
      style={{
        width: "100%",
        height: "100%",
        border: "none",
        display: "block",
        background: "var(--bg-canvas)",
      }}
    />
  );
}
