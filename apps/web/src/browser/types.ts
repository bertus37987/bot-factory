import type {
  AnnotationAnchor,
  AnnotationRecord,
  AnnotationStatus,
  ArtifactEntry,
  GitDiffResponse,
  ProjectRecord,
  RepoFileEntry,
} from "@bot-factory/shared";

export type BrowserTabKind = "doc" | "image" | "model_3d" | "code" | "diff" | "web";

export interface BrowserTab {
  id: string;
  kind: BrowserTabKind;
  target: string;
  label: string;
  projectId: string;
}

export interface InAppBrowserProps {
  project: ProjectRecord | null;
  artifacts: ArtifactEntry[];
  annotations: AnnotationRecord[];
  repoFiles: RepoFileEntry[];
  gitDiff: GitDiffResponse | null;
  activeAgentId?: string | null;
  tabs: BrowserTab[];
  activeTabId: string | null;
  expanded: boolean;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onOpenTab: (tab: Omit<BrowserTab, "id">) => void;
  onToggleExpand: () => void;
  onCloseSidebar: () => void;
  onRefreshContext: () => void;
  onCreateAnnotation: (params: {
    anchor: AnnotationAnchor;
    comment: string;
    snapshotDataUrl?: string;
    requestFixNow: boolean;
  }) => Promise<void>;
  onResolveAnnotation: (annotationId: string, status: AnnotationStatus) => Promise<void>;
}

export type ImageZoomMode = "fit" | "75%" | "100%";

export type Model3DPreset = "Iso" | "Front" | "Top";

export interface CameraPose {
  pos: [number, number, number];
  target: [number, number, number];
}

export type WebUrlValidationResult =
  | { allowed: true; normalizedUrl: string }
  | { allowed: false; reason: "empty" | "invalid" | "not_loopback" | "self_embed"; message: string };

const LOOPBACK_BARE_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/.*)?$/i;

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

export function normalizeOmniboxUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (LOOPBACK_BARE_RE.test(v)) return `http://${v}`;
  return null;
}

export function validateLoopbackWebUrl(raw: string): WebUrlValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      allowed: false,
      reason: "empty",
      message: "Enter a local loopback URL such as http://127.0.0.1:3000.",
    };
  }

  const candidate = normalizeOmniboxUrl(trimmed) ?? trimmed;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return {
      allowed: false,
      reason: "invalid",
      message: `Invalid URL "${trimmed}". Expected http://127.0.0.1:<port> or http://localhost:<port>.`,
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      allowed: false,
      reason: "not_loopback",
      message: `Only HTTP/HTTPS loopback URLs are allowed (blocked protocol "${parsed.protocol}").`,
    };
  }

  if (!isLoopbackHost(parsed.hostname)) {
    return {
      allowed: false,
      reason: "not_loopback",
      message: `Only local loopback addresses (http://127.0.0.1:... or http://localhost:...) are allowed. Blocked "${parsed.hostname}".`,
    };
  }

  if (typeof window !== "undefined" && window.location?.origin) {
    try {
      const current = new URL(window.location.href);
      const sameOrigin = parsed.origin === current.origin;
      const sameLoopbackPort =
        isLoopbackHost(current.hostname) &&
        isLoopbackHost(parsed.hostname) &&
        parsed.protocol === current.protocol &&
        effectivePort(parsed) === effectivePort(current);

      if (sameOrigin || sameLoopbackPort) {
        return {
          allowed: false,
          reason: "self_embed",
          message: `Self-embedding blocked: "${parsed.origin}" is the active Bot-Factory Studio origin.`,
        };
      }
    } catch {
      // Ignore invalid window.location in non-DOM test contexts.
    }
  }

  return { allowed: true, normalizedUrl: parsed.href };
}

export function quickHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function breadcrumbSegments(tab: BrowserTab): string[] {
  if (tab.kind === "web") return [tab.target];
  if (tab.kind === "diff") return [tab.target || "diff://HEAD"];
  if (tab.kind === "code") return ["repo", ...tab.target.split("/").filter(Boolean)];
  return tab.target.split("/").filter(Boolean);
}

export function formatAnnotationStatus(status: AnnotationStatus): string {
  switch (status) {
    case "open":
      return "Open";
    case "in_progress":
      return "In Progress";
    case "resolved_pending_review":
      return "Pending Review";
    case "approved":
      return "Approved";
  }
}
