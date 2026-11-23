import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import {
  RpcCommandSchema,
  type ProjectRecord,
  type SubscriptionTopic,
  type WsClientMessage,
  type WsServerMessage,
} from "@bot-factory/shared";
import { SecretScrubber, type LoadedRuntimeConfig } from "../config";
import type { CommandCore } from "../core/commandCore";
import type { StateDatabase } from "../db/database";
import { computeWorkspaceGitDiff, listSafeRepoFiles, readSafeRepoFile } from "../git/worktrees";
import type { OrchestrationEngine } from "../orchestration/engine";
import { isPathStrictlyWithinRoot } from "../runtimes/nativeHttpRuntime";

interface WsClientData {
  id: string;
  topics: Set<SubscriptionTopic>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
};

const ALLOWED_ARTIFACT_TOP_DIRS = new Set(["plans", "artifacts", "handoffs"]);
const SESSION_COOKIE_NAME = "bf_session";
const SESSION_COOKIE_CONTEXT = "bot-factory-session-v1";

function timingSafeStringEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function safeDecodeParam(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function parseCookieHeader(cookieHeader: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const rawVal = part.slice(eq + 1).trim();
    if (!name) continue;
    out.set(name, safeDecodeParam(rawVal) ?? rawVal);
  }
  return out;
}

function extractAuthToken(req: Request): string {
  const headerToken = req.headers.get("x-bf-token")?.trim();
  if (headerToken) return headerToken;
  const authHeader = req.headers.get("authorization") ?? "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return bearerMatch?.[1] ? bearerMatch[1].trim() : "";
}

export function signSessionCookie(sessionToken: string): string {
  const mac = createHmac("sha256", sessionToken).update(SESSION_COOKIE_CONTEXT).digest("hex");
  return `v1.${mac}`;
}

export function verifySessionCookie(cookieValue: string, sessionToken: string): boolean {
  if (!cookieValue || !sessionToken) return false;
  return timingSafeStringEqual(cookieValue, signSessionCookie(sessionToken));
}

export function resolveSafeProjectFile(projectRoot: string, relPath: string): string {
  if (!relPath || isAbsolute(relPath) || relPath.startsWith("\\\\") || relPath.startsWith("//") || relPath.includes("\0")) {
    throw new Error("path_traversal_blocked");
  }
  // isPathStrictlyWithinRoot enforces both lexical containment and realpathSync symlink/reparse-point containment
  const check = isPathStrictlyWithinRoot(projectRoot, relPath);
  if (!check.ok) {
    throw new Error("path_traversal_blocked");
  }
  const normalizedRel = relative(resolve(projectRoot), check.absTarget).replace(/\\/g, "/");
  const topDir = normalizedRel.split("/")[0] ?? "";
  if (!ALLOWED_ARTIFACT_TOP_DIRS.has(topDir)) {
    throw new Error("artifact_scope_restricted");
  }
  return check.absTarget;
}

function isAllowedLocalOrigin(req: Request, boundPort: number): boolean {
  const hostHeader = (req.headers.get("host") ?? "").toLowerCase();
  if (hostHeader && !/^((127\.0\.0\.1|localhost|\[::1\])(:\d+)?)$/.test(hostHeader)) {
    return false;
  }
  const origin = req.headers.get("origin");
  if (!origin) return true; // Non-browser local clients (CLI/tests)
  const allowed = new Set([
    `http://127.0.0.1:${boundPort}`,
    `http://localhost:${boundPort}`,
    `http://[::1]:${boundPort}`,
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://[::1]:5173",
  ]);
  return allowed.has(origin.toLowerCase());
}

export class DaemonServer {
  private server: Server | null = null;
  private readonly topicSubscribers = new Map<SubscriptionTopic, Set<ServerWebSocket<WsClientData>>>();
  private unsubscribeCore: (() => void) | null = null;
  private readonly webDistDir: string;
  private readonly scrubber: SecretScrubber;

  constructor(
    private readonly runtimeCfg: LoadedRuntimeConfig,
    private readonly db: StateDatabase,
    private readonly core: CommandCore,
    private readonly engine: OrchestrationEngine,
  ) {
    this.webDistDir = resolve(import.meta.dir, "../../../web/dist");
    this.scrubber = new SecretScrubber(runtimeCfg.secrets);
  }

  private isAuthenticated(req: Request): boolean {
    const token = extractAuthToken(req);
    if (token && timingSafeStringEqual(token, this.runtimeCfg.sessionToken)) {
      return true;
    }
    const cookies = parseCookieHeader(req.headers.get("cookie"));
    const sessionCookie = cookies.get(SESSION_COOKIE_NAME);
    return Boolean(sessionCookie && verifySessionCookie(sessionCookie, this.runtimeCfg.sessionToken));
  }

  private sessionCookieHeader(): string {
    return `${SESSION_COOKIE_NAME}=${signSessionCookie(this.runtimeCfg.sessionToken)}; HttpOnly; SameSite=Strict; Path=/`;
  }

  public start(): { port: number; url: string } {
    this.unsubscribeCore = this.core.onPostCommit((topic, eventType, payload, seq) => {
      this.broadcast(topic, { kind: "event", topic, eventType, data: payload, seq });
    });

    const host = this.runtimeCfg.config.hub.host;
    const port = this.runtimeCfg.config.hub.port;

    this.server = Bun.serve<WsClientData, Record<string, never>>({
      hostname: host,
      port,
      fetch: async (req, server) => {
        const url = new URL(req.url);
        const boundPort = server.port ?? port;

        if (!isAllowedLocalOrigin(req, boundPort)) {
          return new Response("Forbidden origin/host", { status: 403 });
        }

        if (url.pathname === "/" && req.method === "GET" && url.searchParams.has("token")) {
          const tokenParam = url.searchParams.get("token") ?? "";
          if (!timingSafeStringEqual(tokenParam, this.runtimeCfg.sessionToken)) {
            return new Response("Unauthorized", { status: 401 });
          }
          return new Response(null, {
            status: 302,
            headers: {
              "set-cookie": this.sessionCookieHeader(),
              location: "/",
            },
          });
        }

        if (url.pathname === "/api/auth/status" && req.method === "GET") {
          return Response.json({ authenticated: this.isAuthenticated(req) });
        }

        if (url.pathname === "/api/auth/session" && req.method === "POST") {
          let body: { token?: unknown };
          try {
            const raw = await req.json();
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
              return Response.json({ ok: false, error: "invalid_auth_body" }, { status: 400 });
            }
            body = raw as { token?: unknown };
          } catch {
            return Response.json({ ok: false, error: "invalid_auth_json" }, { status: 400 });
          }
          if (typeof body.token !== "string" || !timingSafeStringEqual(body.token, this.runtimeCfg.sessionToken)) {
            return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
          }
          return Response.json(
            { ok: true, authenticated: true },
            {
              status: 200,
              headers: {
                "set-cookie": this.sessionCookieHeader(),
              },
            },
          );
        }

        if (url.pathname === "/api/health" && req.method === "GET") {
          if (!this.isAuthenticated(req)) {
            return Response.json({
              ok: true,
              host,
              port: boundPort,
              authRequired: true,
            });
          }
          return Response.json({
            ok: true,
            epoch: this.db.epoch,
            ftsStale: this.db.isFtsStale(),
            host,
            port: boundPort,
            authRequired: false,
            status: this.engine.getQuietStatusProjection(),
          });
        }

        if (url.pathname === "/ws") {
          if (!this.isAuthenticated(req)) {
            return new Response("Unauthorized", { status: 401 });
          }
          const upgraded = server.upgrade(req, {
            data: { id: crypto.randomUUID(), topics: new Set<SubscriptionTopic>() },
          });
          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        if (url.pathname.startsWith("/api/mcp/") && req.method === "POST") {
          const token = extractAuthToken(req);
          const bound = token ? this.engine.resolveMcpToken(token) : null;
          const isMasterToken = Boolean(token) && timingSafeStringEqual(token, this.runtimeCfg.sessionToken);
          if (!bound && !isMasterToken) {
            return Response.json({ error: "unauthorized_mcp_token" }, { status: 401 });
          }
          const toolName = safeDecodeParam(url.pathname.slice("/api/mcp/".length));
          if (toolName === null || !toolName || toolName.includes("/")) {
            return Response.json({ error: "invalid_mcp_tool" }, { status: 400 });
          }
          let body: { projectId?: unknown; agentId?: unknown; args?: unknown };
          try {
            const raw = await req.json();
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
              return Response.json({ error: "invalid_mcp_body" }, { status: 400 });
            }
            body = raw as { projectId?: unknown; agentId?: unknown; args?: unknown };
          } catch {
            return Response.json({ error: "invalid_mcp_json" }, { status: 400 });
          }

          let projectId: string;
          let agentId: string;
          let scoped: boolean;
          if (bound) {
            if (
              (body.projectId !== undefined && typeof body.projectId !== "string") ||
              (body.agentId !== undefined && typeof body.agentId !== "string")
            ) {
              return Response.json({ error: "invalid_mcp_identity" }, { status: 400 });
            }
            if (typeof body.projectId === "string" && body.projectId !== "" && body.projectId !== bound.projectId) {
              return Response.json({ error: "mcp_scope_forbidden" }, { status: 403 });
            }
            if (typeof body.agentId === "string" && body.agentId !== "" && body.agentId !== bound.agentId) {
              return Response.json({ error: "mcp_scope_forbidden" }, { status: 403 });
            }
            projectId = bound.projectId;
            agentId = bound.agentId;
            scoped = true;
          } else {
            if (typeof body.projectId !== "string" || typeof body.agentId !== "string") {
              return Response.json({ error: "invalid_mcp_identity" }, { status: 400 });
            }
            projectId = body.projectId;
            agentId = body.agentId;
            scoped = false;
          }

          const args =
            body.args && typeof body.args === "object" && !Array.isArray(body.args)
              ? (body.args as Record<string, unknown>)
              : undefined;
          try {
            const result = await this.engine.handleMcpToolCall(toolName, {
              projectId,
              agentId,
              args,
              scoped,
            });
            return Response.json(result);
          } catch (err) {
            return Response.json(
              { error: this.scrubber.scrub(err instanceof Error ? err.message : String(err)) },
              { status: 400 },
            );
          }
        }

        if (url.pathname.startsWith("/api/")) {
          if (!this.isAuthenticated(req)) {
            return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
          }
        }

        if (url.pathname === "/api/snapshot" && req.method === "GET") {
          return Response.json(this.engine.getGlobalSnapshot());
        }

        if (url.pathname === "/api/command" && req.method === "POST") {
          try {
            const raw = await req.json();
            const cmd = RpcCommandSchema.parse(raw);
            const result = this.engine.executeCommand(cmd);
            return Response.json({ ok: true, result });
          } catch (err) {
            return Response.json(
              { ok: false, error: this.scrubber.scrub(err instanceof Error ? err.message : String(err)) },
              { status: 400 },
            );
          }
        }

        const artifactMatch = /^\/api\/projects\/([^/]+)\/artifact$/.exec(url.pathname);
        if (artifactMatch && req.method === "GET") {
          const projectId = safeDecodeParam(artifactMatch[1]!);
          if (projectId === null) return new Response("Bad Request", { status: 400 });
          const relPath = url.searchParams.get("path") ?? "";
          const project = this.db.getProject(projectId);
          if (!project || !relPath) return new Response("Not found", { status: 404 });
          try {
            const abs = resolveSafeProjectFile(project.rootPath, relPath);
            if (!existsSync(abs) || !statSync(abs).isFile()) return new Response("Not found", { status: 404 });
            const ext = extname(abs).toLowerCase();
            return new Response(Bun.file(abs), {
              headers: {
                "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
                "cache-control": "no-cache",
                "content-security-policy":
                  "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'",
                "x-content-type-options": "nosniff",
              },
            });
          } catch {
            return new Response("Forbidden", { status: 403 });
          }
        }

        // Read-only in-app browser API (repo files + workspace diff)
        const filesMatch = /^\/api\/projects\/([^/]+)\/files$/.exec(url.pathname);
        if (filesMatch && req.method === "GET") {
          const projectId = safeDecodeParam(filesMatch[1]!);
          if (projectId === null) return new Response("Bad Request", { status: 400 });
          const project = this.db.getProject(projectId);
          if (!project) return new Response("Not found", { status: 404 });
          const codeRoot = this.resolveProjectCodeRoot(project, url.searchParams.get("agentId"));
          return Response.json({ files: listSafeRepoFiles(codeRoot) });
        }

        const fileMatch = /^\/api\/projects\/([^/]+)\/file$/.exec(url.pathname);
        if (fileMatch && req.method === "GET") {
          const projectId = safeDecodeParam(fileMatch[1]!);
          if (projectId === null) return new Response("Bad Request", { status: 400 });
          const project = this.db.getProject(projectId);
          const relPath = url.searchParams.get("path") ?? "";
          if (!project || !relPath) return new Response("Not found", { status: 404 });
          const codeRoot = this.resolveProjectCodeRoot(project, url.searchParams.get("agentId"));
          try {
            const result = readSafeRepoFile(codeRoot, relPath, (text) => this.scrubber.scrub(text));
            return Response.json({
              path: result.relativePath,
              content: result.content,
              sizeBytes: result.sizeBytes,
              truncated: result.truncated,
            });
          } catch (err) {
            const code = err instanceof Error ? err.message : String(err);
            if (code === "path_traversal_blocked" || code === "sensitive_path_blocked") {
              return new Response("Forbidden", { status: 403 });
            }
            if (code === "file_not_found") return new Response("Not found", { status: 404 });
            if (code === "file_too_large") return new Response("Payload too large", { status: 413 });
            if (code === "binary_file_not_previewable") {
              return new Response("Unsupported media type", { status: 415 });
            }
            return new Response(this.scrubber.scrub(code), { status: 400 });
          }
        }

        const diffMatch = /^\/api\/projects\/([^/]+)\/diff$/.exec(url.pathname);
        if (diffMatch && req.method === "GET") {
          const projectId = safeDecodeParam(diffMatch[1]!);
          if (projectId === null) return new Response("Bad Request", { status: 400 });
          const project = this.db.getProject(projectId);
          if (!project) return new Response("Not found", { status: 404 });
          const codeRoot = this.resolveProjectCodeRoot(project, url.searchParams.get("agentId"));
          return Response.json(await computeWorkspaceGitDiff(codeRoot, (text) => this.scrubber.scrub(text)));
        }

        if (url.pathname.startsWith("/api/")) {
          return Response.json({ ok: false, error: "not_found" }, { status: 404 });
        }

        return this.serveStaticUi(url.pathname);
      },
      websocket: {
        open: () => {},
        message: (ws, raw) => {
          this.handleWsMessage(ws, String(raw));
        },
        close: (ws) => {
          for (const topic of ws.data.topics) {
            const set = this.topicSubscribers.get(topic);
            set?.delete(ws);
            if (set && set.size === 0) this.topicSubscribers.delete(topic);
          }
          ws.data.topics.clear();
        },
      },
    });

    const boundPort = this.server.port ?? port;
    return { port: boundPort, url: `http://${host}:${boundPort}` };
  }

  private resolveProjectCodeRoot(project: ProjectRecord, agentId: string | null): string {
    if (agentId) {
      const agent = this.db.getAgent(agentId);
      if (agent && agent.projectId === project.id && agent.worktreePath && existsSync(agent.worktreePath)) {
        return agent.worktreePath;
      }
    }
    return project.repoPath;
  }

  private serveStaticUi(pathname: string): Response {
    if (!existsSync(this.webDistDir)) {
      return new Response(
        "Bot-Factory Daemon is running. Build web UI (`bun run build:web`) or run Vite dev server (`bun run dev:web`).",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    const decoded = safeDecodeParam(pathname);
    if (decoded === null) {
      return new Response("Bad Request", { status: 400 });
    }

    const candidateRel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "") || "index.html";
    const check = isPathStrictlyWithinRoot(this.webDistDir, candidateRel);
    if (!check.ok) {
      return new Response("Forbidden", { status: 403 });
    }

    let abs = check.absTarget;
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      abs = resolve(this.webDistDir, "index.html");
    }
    const ext = extname(abs).toLowerCase();
    return new Response(Bun.file(abs), {
      headers: { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" },
    });
  }

  private handleWsMessage(ws: ServerWebSocket<WsClientData>, raw: string): void {
    let msg: WsClientMessage;
    try {
      msg = JSON.parse(raw) as WsClientMessage;
    } catch {
      return;
    }

    if (msg.kind === "ping") {
      this.send(ws, { kind: "pong", ts: msg.ts });
      return;
    }

    if (msg.kind === "subscribe") {
      let set = this.topicSubscribers.get(msg.topic);
      if (!set) {
        set = new Set();
        this.topicSubscribers.set(msg.topic, set);
      }
      set.add(ws);
      ws.data.topics.add(msg.topic);

      try {
        const snapshot = this.buildTopicSnapshot(msg.topic);
        this.send(ws, { kind: "snapshot", topic: msg.topic, data: snapshot, seq: 0 });
      } catch {
        this.send(ws, { kind: "snapshot", topic: msg.topic, data: null, seq: 0 });
      }
      return;
    }

    if (msg.kind === "unsubscribe") {
      ws.data.topics.delete(msg.topic);
      const set = this.topicSubscribers.get(msg.topic);
      set?.delete(ws);
      if (set && set.size === 0) this.topicSubscribers.delete(msg.topic);
      return;
    }

    if (msg.kind === "command") {
      const parsed = RpcCommandSchema.safeParse(msg.payload);
      if (!parsed.success) {
        this.send(ws, {
          kind: "ack",
          commandId: (msg.payload as { commandId?: string })?.commandId ?? "invalid",
          ok: false,
          error: this.scrubber.scrub(parsed.error.message),
        });
        return;
      }
      try {
        const result = this.engine.executeCommand(parsed.data);
        this.send(ws, { kind: "ack", commandId: parsed.data.commandId, ok: true, result });
      } catch (err) {
        this.send(ws, {
          kind: "ack",
          commandId: parsed.data.commandId,
          ok: false,
          error: this.scrubber.scrub(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  }

  private buildTopicSnapshot(topic: SubscriptionTopic): unknown {
    if (topic === "global:status") return this.engine.getGlobalSnapshot();
    if (topic === "global:selfmod") return this.engine.getSelfModSnapshot();
    if (topic === "chat:meta") return this.engine.getMetaChatSnapshot();
    const boardMatch = /^project:([^:]+):board$/.exec(topic);
    if (boardMatch) return this.engine.getProjectBoardSnapshot(boardMatch[1]!);
    const previewMatch = /^project:([^:]+):previews$/.exec(topic);
    if (previewMatch) return this.engine.getProjectPreviewsSnapshot(previewMatch[1]!);
    const debatesMatch = /^project:([^:]+):debates$/.exec(topic);
    if (debatesMatch) return this.engine.getProjectDebatesSnapshot(debatesMatch[1]!);
    const botMatch = /^bot:([^:]+):timeline$/.exec(topic);
    if (botMatch) return this.engine.getBotTimelineSnapshot(botMatch[1]!);
    return null;
  }

  private broadcast(topic: SubscriptionTopic, msg: WsServerMessage): void {
    const subscribers = this.topicSubscribers.get(topic);
    if (!subscribers || subscribers.size === 0) return;
    const wire = JSON.stringify(msg);
    for (const ws of subscribers) {
      try {
        ws.send(wire);
      } catch {
        // ignore broken socket
      }
    }
  }

  private send(ws: ServerWebSocket<WsClientData>, msg: WsServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore
    }
  }

  public getSubscriberCount(topic: SubscriptionTopic): number {
    return this.topicSubscribers.get(topic)?.size ?? 0;
  }

  public stop(): void {
    this.unsubscribeCore?.();
    this.server?.stop(true);
    this.server = null;
  }
}
