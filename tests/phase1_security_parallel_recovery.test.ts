import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startBotFactoryDaemon, type BotFactoryApp } from "../apps/daemon/src/index";
import { CURRENT_SCHEMA_VERSION, StateDatabase } from "../apps/daemon/src/db/database";
import { provisionProjectWorkspace } from "../apps/daemon/src/git/worktrees";
import { isPathStrictlyWithinRoot, resolveSafeWorktreePath } from "../apps/daemon/src/runtimes/nativeHttpRuntime";

const tempDirs: string[] = [];
const runningApps: BotFactoryApp[] = [];
const runningServers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];
let prevOfflineMock: string | undefined;

function makeTempRoot(prefix = "bf-p1-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readDaemonToken(rootDir: string): string {
  return readFileSync(join(rootDir, "system", ".daemon-token"), "utf8").trim();
}

function openWs(url: string, headers?: Record<string, string>): WebSocket {
  // @types/bun 1.2.15 DOM lib signature omits Bun's runtime { headers } WebSocket init option.
  return headers ? new WebSocket(url, { headers } as unknown as string[]) : new WebSocket(url);
}

function listSessionAdmissions(db: StateDatabase, sessionId: string): Array<{ id: string; status: string }> {
  return db.db
    .query("SELECT id, status FROM session_admissions WHERE session_id = ? ORDER BY created_at ASC")
    .all(sessionId) as Array<{ id: string; status: string }>;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2000, intervalMs = 15): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`wait_condition_timeout:${timeoutMs}ms`);
}

function writeTestHubConfig(
  rootDir: string,
  opts?: { mistralBaseUrl?: string; devinCommand?: string; devinArgs?: string[] },
): void {
  const systemDir = join(rootDir, "system");
  mkdirSync(systemDir, { recursive: true });
  const cfg = {
    version: "1.0",
    hub: {
      rootDir,
      host: "127.0.0.1",
      port: 0,
      dbPath: join(systemDir, "state.db"),
      secretsEnvPath: join(systemDir, "secrets.env"),
      defaultProjectsDir: join(rootDir, "projects"),
    },
    providers: {
      "mistral-hosted": {
        runtime: "native_http",
        protocol: "openai_compatible",
        baseUrl: opts?.mistralBaseUrl ?? "https://api.mistral.ai/v1",
        apiKeyEnv: "MISTRAL_API_KEY",
        models: {
          "mistral-large-4": {
            id: "mistral-large-4",
            capabilities: ["reasoning", "planning", "review", "coding"],
            tier: "flagship",
          },
          "glm-5.3": { id: "glm-5.3", capabilities: ["coding", "docs", "general"], tier: "balanced" },
          "glm-5.3-flash": {
            id: "glm-5.3-flash",
            capabilities: ["fast", "sidekick", "dreaming", "search", "triage"],
            tier: "fast",
          },
        },
      },
      "google-antigravity": {
        runtime: "native_http",
        protocol: "google_gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKeyEnv: "GEMINI_API_KEY",
        models: {
          "gemini-4-hydrogen": {
            id: "gemini-4-hydrogen",
            capabilities: ["multimodal", "vision", "review", "long_context", "coding"],
            tier: "flagship",
          },
          "gemini-4-neon": {
            id: "gemini-4-neon",
            capabilities: ["multimodal", "vision", "reasoning", "architecture", "review"],
            tier: "flagship",
          },
        },
      },
      "devin-acp": {
        runtime: "acp_stdio",
        command: opts?.devinCommand ?? "devin",
        args: opts?.devinArgs ?? ["acp"],
        models: {
          "swe-2-max": {
            id: "swe-2-max",
            capabilities: ["coding_deep", "refactor", "debug", "autonomous_slice"],
            tier: "flagship",
          },
        },
      },
    },
    routing: {
      policy: "task_adaptive",
      allowPerProjectOverride: true,
      allowPerTaskOverride: true,
      defaultsByIntent: {
        meta_orchestrator: { provider: "mistral-hosted", model: "mistral-large-4" },
        project_manager: { provider: "mistral-hosted", model: "mistral-large-4" },
        coding_deep: { provider: "devin-acp", model: "swe-2-max" },
        coding_parallel: { provider: "mistral-hosted", model: "glm-5.3" },
        multimodal_review: { provider: "google-antigravity", model: "gemini-4-neon" },
        vision_fix: { provider: "google-antigravity", model: "gemini-4-hydrogen" },
        sidekick: { provider: "mistral-hosted", model: "glm-5.3-flash" },
        memory_dreaming: { provider: "mistral-hosted", model: "glm-5.3-flash" },
        verifier_default: { provider: "google-antigravity", model: "gemini-4-hydrogen" },
      },
      crossFamilyVerification: true,
    },
    memory: {
      provider: "local_sqlite_superhermes",
      l1Files: {
        globalUser: { file: "USER.md", maxChars: 2000 },
        globalMemory: { file: "GLOBAL_MEMORY.md", maxChars: 3000 },
        projectMemory: { file: "MEMORY.md", maxChars: 3000 },
      },
      pluginPromptCaps: { maxCharsPerBlock: 4000, maxCharsTotal: 8000 },
      dreaming: { mode: "dynamic", debounceSeconds: 20, maxBatchDocs: 8, modelIntent: "memory_dreaming" },
      graphMaxHops: 3,
      defaultDecaySweepIntervalMinutes: 30,
    },
    guardrails: {
      maxConcurrentBotsPerProject: 4,
      maxDebateRounds: 3,
      maxAnnotationFixRetries: 2,
      permissionRequestTimeoutSeconds: 120,
      acpWorktreeBoundaryEnforced: true,
      redactSecretsInLogsAndMemory: true,
      selfModRequiresStagingAndVerifier: true,
    },
  };
  writeFileSync(join(systemDir, "config.json"), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

function writeMockAcpScript(scriptPath: string, opts: { mode: "hold" | "fail_init"; cancelMarkerPath?: string }): void {
  if (opts.mode === "fail_init") {
    writeFileSync(
      scriptPath,
      `process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += String(chunk);
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "simulated_handshake_failure" } }) + "\\n");
    }
  }
});`,
      "utf8",
    );
    return;
  }

  writeFileSync(
    scriptPath,
    `import { writeFileSync } from "node:fs";
const markerPath = process.argv[2];
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += String(chunk);
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
    } else if (msg.method === "session/new") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "ext_slow_acp" } }) + "\\n");
    } else if (msg.method === "session/prompt") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "working-slowly..." } } }
      }) + "\\n");
      // Intentionally hold until session/cancel or termination
    } else if (msg.method === "session/cancel") {
      if (markerPath) {
        writeFileSync(markerPath, "cancelled", "utf8");
      }
    }
  }
});
setInterval(() => {}, 1000);`,
    "utf8",
  );
}

beforeEach(() => {
  prevOfflineMock = process.env.BOT_FACTORY_OFFLINE_MOCK;
});

afterEach(() => {
  while (runningApps.length > 0) {
    runningApps.pop()!.stop();
  }
  while (runningServers.length > 0) {
    runningServers.pop()!.stop(true);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows handle release delay
    }
  }
  if (prevOfflineMock === undefined) delete process.env.BOT_FACTORY_OFFLINE_MOCK;
  else process.env.BOT_FACTORY_OFFLINE_MOCK = prevOfflineMock;
  prevOfflineMock = undefined;
});

describe("Phase 1 — Security, Parallelism, Immediate Control Abort & Recovery", () => {
  it("fails closed on unauthenticated endpoints/WS, hides unauth health counts, bootstraps HttpOnly SameSite=Strict cookie, blocks cross-drive reads, and sets sandbox CSP", async () => {
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";
    const rootDir = makeTempRoot();
    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    const created = app.engine.executeCommand({
      commandId: "p1_sec_proj",
      type: "project.create",
      name: "Auth & Static Guard",
      seedDemoArtifacts: true,
    }) as { project: { id: string } };
    const projectId = created.project.id;
    const token = readDaemonToken(rootDir);
    const wsUrl = app.url.replace("http://", "ws://") + "/ws";

    // 1. Unauthenticated requests fail closed
    expect((await fetch(`${app.url}/api/snapshot`)).status).toBe(401);
    expect(
      (
        await fetch(`${app.url}/api/command`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commandId: "unauth_cmd", type: "project.create", name: "Nope", seedDemoArtifacts: false }),
        })
      ).status,
    ).toBe(401);
    expect((await fetch(`${app.url}/api/projects/${projectId}/files`)).status).toBe(401);
    expect((await fetch(`${app.url}/api/projects/${projectId}/artifact?path=artifacts/ui-mockup.svg`)).status).toBe(401);
    expect((await fetch(`${app.url}/ws`)).status).toBe(401);

    const unauthWsRejected = await new Promise<boolean>((resolve) => {
      const ws = openWs(wsUrl);
      let opened = false;
      ws.onopen = () => {
        opened = true;
        ws.close();
        resolve(false);
      };
      ws.onerror = () => resolve(!opened);
      ws.onclose = () => resolve(!opened);
    });
    expect(unauthWsRejected).toBe(true);

    // 2. Unauthenticated /api/health hides internal status counts
    const unauthHealthRes = await fetch(`${app.url}/api/health`);
    expect(unauthHealthRes.status).toBe(200);
    const unauthHealth = (await unauthHealthRes.json()) as Record<string, unknown>;
    expect(unauthHealth.ok).toBe(true);
    expect(unauthHealth.authRequired).toBe(true);
    expect(unauthHealth.status).toBeUndefined();
    expect(unauthHealth.epoch).toBeUndefined();
    expect(unauthHealth.ftsStale).toBeUndefined();

    const authHealthRes = await fetch(`${app.url}/api/health`, { headers: { "x-bf-token": token } });
    expect(authHealthRes.status).toBe(200);
    const authHealth = (await authHealthRes.json()) as Record<string, unknown>;
    expect(authHealth.authRequired).toBe(false);
    expect(typeof authHealth.epoch).toBe("number");
    expect(authHealth.status).toBeDefined();

    // 3. Auth bootstrap via GET /?token=... and POST /api/auth/session + GET /api/auth/status
    expect((await fetch(`${app.url}/?token=wrong-token`, { redirect: "manual" })).status).toBe(401);
    const bootstrapRes = await fetch(`${app.url}/?token=${encodeURIComponent(token)}`, { redirect: "manual" });
    expect(bootstrapRes.status).toBe(302);
    expect(bootstrapRes.headers.get("location")).toBe("/");
    const setCookie = bootstrapRes.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("bf_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    const cookiePair = setCookie.split(";")[0]!;

    const statusUnauth = (await (await fetch(`${app.url}/api/auth/status`)).json()) as { authenticated: boolean };
    expect(statusUnauth.authenticated).toBe(false);

    const statusCookie = (await (
      await fetch(`${app.url}/api/auth/status`, { headers: { cookie: cookiePair } })
    ).json()) as { authenticated: boolean };
    expect(statusCookie.authenticated).toBe(true);

    expect(
      (
        await fetch(`${app.url}/api/auth/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "wrong" }),
        })
      ).status,
    ).toBe(401);

    const sessionRes = await fetch(`${app.url}/api/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(sessionRes.status).toBe(200);
    const sessionBody = (await sessionRes.json()) as { ok: boolean; authenticated: boolean };
    expect(sessionBody).toEqual({ ok: true, authenticated: true });
    const sessionCookie = (sessionRes.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(sessionCookie.startsWith("bf_session=")).toBe(true);

    // Cookie authorizes /api/snapshot & /ws
    const snapRes = await fetch(`${app.url}/api/snapshot`, { headers: { cookie: sessionCookie } });
    expect(snapRes.status).toBe(200);

    const cookieWs = openWs(wsUrl, { cookie: sessionCookie });
    await new Promise<void>((resolve, reject) => {
      cookieWs.onopen = () => resolve();
      cookieWs.onerror = () => reject(new Error("cookie_ws_failed"));
    });
    const pongMsg = await new Promise<{ kind: string; ts: number }>((resolve) => {
      const ts = 123456;
      cookieWs.onmessage = (ev) => {
        const parsed = JSON.parse(String(ev.data)) as { kind: string; ts: number };
        if (parsed.kind === "pong" && parsed.ts === ts) resolve(parsed);
      };
      cookieWs.send(JSON.stringify({ kind: "ping", ts }));
    });
    expect(pongMsg.kind).toBe("pong");
    cookieWs.close();

    // 4. Windows cross-drive static traversal must be rejected (403), never reading outside apps/web/dist
    for (const crossDrivePath of ["/D:/secret.txt", "/C:/Windows/win.ini", "/%43%3a/Windows/win.ini"]) {
      const res = await fetch(`${app.url}${crossDrivePath}`);
      expect(res.status).toBe(403);
    }

    // 5. Artifact endpoint carries sandbox CSP + nosniff
    const svgRes = await fetch(`${app.url}/api/projects/${projectId}/artifact?path=artifacts/ui-mockup.svg`, {
      headers: { "x-bf-token": token },
    });
    expect(svgRes.status).toBe(200);
    expect(svgRes.headers.get("content-security-policy")).toContain("sandbox");
    expect(svgRes.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(svgRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await svgRes.text()).toContain("<svg");
  });

  it("rejects dangling symlinks/junctions escaping worktree, unsafe externalRepoPath, and sensitive repo denylist files", async () => {
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";
    const sandbox = makeTempRoot("bf-sym-");
    const worktree = join(sandbox, "worktree");
    const outside = join(sandbox, "outside");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(outside, { recursive: true });

    // Dangling file symlinks (absolute & relative) + Windows dangling junction pointing outside worktree
    symlinkSync(join(outside, "nonexistent-secret.txt"), join(worktree, "dangling-abs.txt"));
    symlinkSync("../outside/nonexistent-rel.txt", join(worktree, "dangling-rel.txt"));
    if (process.platform === "win32") {
      symlinkSync(join(outside, "missing-dir"), join(worktree, "dangling-junc"), "junction");
    }
    // In-root dangling symlink must remain allowed
    symlinkSync(join(worktree, "future-file.txt"), join(worktree, "safe-dangling.txt"));

    expect(isPathStrictlyWithinRoot(worktree, "dangling-abs.txt").ok).toBe(false);
    expect(isPathStrictlyWithinRoot(worktree, "dangling-rel.txt").ok).toBe(false);
    if (process.platform === "win32") {
      expect(isPathStrictlyWithinRoot(worktree, "dangling-junc").ok).toBe(false);
      expect(isPathStrictlyWithinRoot(worktree, "dangling-junc/sub.txt").ok).toBe(false);
    }
    expect(() => resolveSafeWorktreePath(worktree, "dangling-abs.txt")).toThrow("worktree_boundary_violation");
    expect(isPathStrictlyWithinRoot(worktree, "safe-dangling.txt").ok).toBe(true);

    // externalRepoPath rejections (non-git & systemDir)
    const rootDir = makeTempRoot("bf-ext-");
    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);
    const nonGitDir = makeTempRoot("bf-nongit-");

    expect(() =>
      provisionProjectWorkspace({
        projectsDir: join(rootDir, "projects"),
        slug: "bad-nongit",
        name: "NonGit",
        externalRepoPath: nonGitDir,
      }),
    ).toThrow("invalid_external_repo_path: missing_git_dir");

    expect(() =>
      provisionProjectWorkspace({
        projectsDir: join(rootDir, "projects"),
        slug: "bad-sysdir",
        name: "SysDir",
        externalRepoPath: join(rootDir, "system"),
      }),
    ).toThrow("invalid_external_repo_path: forbidden_system_or_secret_dir");

    const userSystemDir = join(homedir(), "bot-factory", "system");
    if (existsSync(userSystemDir)) {
      expect(() =>
        provisionProjectWorkspace({
          projectsDir: join(rootDir, "projects"),
          slug: "bad-usersys",
          name: "UserSysDir",
          externalRepoPath: userSystemDir,
        }),
      ).toThrow("invalid_external_repo_path: forbidden_system_or_secret_dir");
    }

    // Sensitive repo denylist across files & file reads
    const created = app.engine.executeCommand({
      commandId: "p1_denylist_proj",
      type: "project.create",
      name: "Denylist Guard",
      seedDemoArtifacts: false,
    }) as { project: { id: string; repoPath: string } };
    const repoPath = created.project.repoPath;
    const sensitiveFiles = [".daemon-token", ".env", "secrets.env", "state.db", "cert.pem"];
    for (const file of sensitiveFiles) {
      writeFileSync(join(repoPath, file), "SENSITIVE_DATA_DO_NOT_EXPOSE\n", "utf8");
    }
    writeFileSync(join(repoPath, "public-notes.txt"), "safe content\n", "utf8");

    const token = readDaemonToken(rootDir);
    const filesRes = await fetch(`${app.url}/api/projects/${created.project.id}/files`, {
      headers: { "x-bf-token": token },
    });
    expect(filesRes.status).toBe(200);
    const listed = ((await filesRes.json()) as { files: Array<{ relativePath: string }> }).files.map(
      (f) => f.relativePath,
    );
    expect(listed).toContain("public-notes.txt");
    for (const file of sensitiveFiles) {
      expect(listed).not.toContain(file);
      const readRes = await fetch(
        `${app.url}/api/projects/${created.project.id}/file?path=${encodeURIComponent(file)}`,
        { headers: { "x-bf-token": token } },
      );
      expect(readRes.status).toBe(403);
    }
  });

  it("enforces per-agent scoped MCP tokens (403 on project/agent spoofing) and scrubs secrets + persists task.handoffPath in bf_handoff_write", async () => {
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";
    const rootDir = makeTempRoot("bf-mcp-scope-");
    mkdirSync(join(rootDir, "system"), { recursive: true });
    writeFileSync(join(rootDir, "system", "secrets.env"), "MISTRAL_API_KEY=sk-configured-secret-value-998877\n", "utf8");

    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    const projA = (
      app.engine.executeCommand({
        commandId: "p1_mcp_proj_a",
        type: "project.create",
        name: "MCP Scope A",
        seedDemoArtifacts: false,
      }) as { project: { id: string; rootPath: string } }
    ).project;

    const projB = (
      app.engine.executeCommand({
        commandId: "p1_mcp_proj_b",
        type: "project.create",
        name: "MCP Scope B",
        seedDemoArtifacts: false,
      }) as { project: { id: string } }
    ).project;

    const peer1 = (
      app.engine.executeCommand({
        commandId: "p1_mcp_peer_1",
        type: "bot.spawn",
        projectId: projA.id,
        name: "Peer-Scoped-1",
        scope: "peer",
      }) as { agent: { id: string; activeSessionId: string } }
    ).agent;

    const peer2 = (
      app.engine.executeCommand({
        commandId: "p1_mcp_peer_2",
        type: "bot.spawn",
        projectId: projA.id,
        name: "Peer-Scoped-2",
        scope: "peer",
      }) as { agent: { id: string } }
    ).agent;

    const task1 = (
      app.engine.executeCommand({
        commandId: "p1_mcp_task_1",
        type: "task.create",
        projectId: projA.id,
        title: "Scoped Handoff Task",
        specMd: "Write clean scrubbed handoff.",
        priority: 1,
      }) as { task: { id: string } }
    ).task;

    const scopedToken = app.engine.mintMcpToken(projA.id, peer1.id, peer1.activeSessionId);
    expect(scopedToken.startsWith("bfmcp_")).toBe(true);
    expect(app.engine.resolveMcpToken(scopedToken)).toEqual({
      projectId: projA.id,
      agentId: peer1.id,
      sessionId: peer1.activeSessionId,
    });

    // Attempting to spoof projectId or agentId returns 403 mcp_scope_forbidden
    const spoofProjectRes = await fetch(`${app.url}/api/mcp/bf_task_list`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bf-token": scopedToken },
      body: JSON.stringify({ projectId: projB.id, agentId: peer1.id, args: {} }),
    });
    expect(spoofProjectRes.status).toBe(403);
    expect(((await spoofProjectRes.json()) as { error: string }).error).toBe("mcp_scope_forbidden");

    const spoofAgentRes = await fetch(`${app.url}/api/mcp/bf_task_list`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bf-token": scopedToken },
      body: JSON.stringify({ projectId: projA.id, agentId: peer2.id, args: {} }),
    });
    expect(spoofAgentRes.status).toBe(403);
    expect(((await spoofAgentRes.json()) as { error: string }).error).toBe("mcp_scope_forbidden");

    // Invalid task status fails closed
    const badStatusRes = await fetch(`${app.url}/api/mcp/bf_task_update`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bf-token": scopedToken },
      body: JSON.stringify({
        projectId: projA.id,
        agentId: peer1.id,
        args: { taskId: task1.id, status: "totally_invalid_status" },
      }),
    });
    expect(badStatusRes.status).toBe(200);
    expect(((await badStatusRes.json()) as { error: string }).error).toBe("invalid_task_status");

    // bf_handoff_write scrubs configured secrets, bearer tokens, and inline api_key values AND updates task.handoffPath
    const handoffRes = await fetch(`${app.url}/api/mcp/bf_handoff_write`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bf-token": scopedToken },
      body: JSON.stringify({
        args: {
          taskId: task1.id,
          title: "Handoff for sk-configured-secret-value-998877",
          summary: "Authorization: Bearer super_secret_bearer_token_987654321",
          changedFiles: ["src/index.ts"],
          testsRun: ["bun test"],
          notes: "api_key=raw_inline_key_1234567890",
        },
      }),
    });
    expect(handoffRes.status).toBe(200);
    const handoffBody = (await handoffRes.json()) as { handoffPath: string };
    expect(handoffBody.handoffPath).toBeTruthy();

    const writtenHandoff = readFileSync(join(projA.rootPath, handoffBody.handoffPath), "utf8");
    expect(writtenHandoff).not.toContain("sk-configured-secret-value-998877");
    expect(writtenHandoff).not.toContain("super_secret_bearer_token_987654321");
    expect(writtenHandoff).not.toContain("raw_inline_key_1234567890");
    expect(writtenHandoff).toContain("[REDACTED_SECRET]");
    expect(writtenHandoff).toContain("[REDACTED_TOKEN]");
    expect(writtenHandoff).toContain("[REDACTED]");
    expect(app.db.getTask(task1.id)!.handoffPath).toBe(handoffBody.handoffPath);

    // Revoking agent MCP tokens immediately invalidates the token
    app.engine.revokeMcpTokensForAgent(peer1.id);
    expect(app.engine.resolveMcpToken(scopedToken)).toBeNull();
    const revokedRes = await fetch(`${app.url}/api/mcp/bf_task_list`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bf-token": scopedToken },
      body: JSON.stringify({ args: {} }),
    });
    expect(revokedRes.status).toBe(401);
  });

  it("executes two peer task.run turns concurrently in parallel (< 420ms wall clock with overlapping 250ms turns)", async () => {
    delete process.env.BOT_FACTORY_OFFLINE_MOCK;
    const windows: Array<{ startMs: number; endMs: number }> = [];
    const mockServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const startMs = performance.now();
        await new Promise((r) => setTimeout(r, 250));
        const endMs = performance.now();
        windows.push({ startMs, endMs });
        return Response.json({
          choices: [{ message: { content: `Completed parallel turn #${windows.length}` } }],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        });
      },
    });
    runningServers.push(mockServer);

    const rootDir = makeTempRoot("bf-parallel-");
    writeTestHubConfig(rootDir, { mistralBaseUrl: `http://127.0.0.1:${mockServer.port}` });
    writeFileSync(join(rootDir, "system", "secrets.env"), "MISTRAL_API_KEY=sk-parallel-test-123456\n", "utf8");

    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    const proj = (
      app.engine.executeCommand({
        commandId: "p1_par_proj",
        type: "project.create",
        name: "Parallel Guild",
        seedDemoArtifacts: false,
      }) as { project: { id: string } }
    ).project;

    const peer1 = (
      app.engine.executeCommand({
        commandId: "p1_par_peer_1",
        type: "bot.spawn",
        projectId: proj.id,
        name: "Parallel-Peer-1",
        scope: "peer",
        provider: "mistral-hosted",
        model: "glm-5.3",
      }) as { agent: { id: string } }
    ).agent;

    const peer2 = (
      app.engine.executeCommand({
        commandId: "p1_par_peer_2",
        type: "bot.spawn",
        projectId: proj.id,
        name: "Parallel-Peer-2",
        scope: "peer",
        provider: "mistral-hosted",
        model: "glm-5.3",
      }) as { agent: { id: string } }
    ).agent;

    const task1 = (
      app.engine.executeCommand({
        commandId: "p1_par_task_1",
        type: "task.create",
        projectId: proj.id,
        title: "Parallel Task 1",
        specMd: "Run branch 1",
        priority: 1,
      }) as { task: { id: string } }
    ).task;

    const task2 = (
      app.engine.executeCommand({
        commandId: "p1_par_task_2",
        type: "task.create",
        projectId: proj.id,
        title: "Parallel Task 2",
        specMd: "Run branch 2",
        priority: 2,
      }) as { task: { id: string } }
    ).task;

    app.engine.executeCommand({
      commandId: "p1_par_disp_1",
      type: "task.dispatch",
      projectId: proj.id,
      taskId: task1.id,
      agentId: peer1.id,
    });
    app.engine.executeCommand({
      commandId: "p1_par_disp_2",
      type: "task.dispatch",
      projectId: proj.id,
      taskId: task2.id,
      agentId: peer2.id,
    });
    await app.core.drainOutboxOnce();

    expect(windows).toHaveLength(2);
    const turnWallClockMs =
      Math.max(windows[0]!.endMs, windows[1]!.endMs) - Math.min(windows[0]!.startMs, windows[1]!.startMs);
    const startSkewMs = Math.abs(windows[0]!.startMs - windows[1]!.startMs);
    expect(turnWallClockMs).toBeLessThan(420);
    expect(startSkewMs).toBeLessThan(100);
    // Strict overlap check: second turn started before first turn ended
    expect(Math.max(windows[0]!.startMs, windows[1]!.startMs)).toBeLessThan(
      Math.min(windows[0]!.endMs, windows[1]!.endMs),
    );
    expect(app.db.getTask(task1.id)!.status).toBe("in_review");
    expect(app.db.getTask(task2.id)!.status).toBe("in_review");
  });

  it("aborts an active slow ACP/mock turn immediately via bot.pause / bot.stop (control lane) without waiting behind another running task.run", async () => {
    delete process.env.BOT_FACTORY_OFFLINE_MOCK;
    let httpInFlight = false;
    let httpAborted = false;
    let resolveHttpStarted!: () => void;
    const httpStarted = new Promise<void>((res) => {
      resolveHttpStarted = res;
    });

    const mockServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        httpInFlight = true;
        resolveHttpStarted();
        return new Promise<Response>((resolve) => {
          const timer = setTimeout(() => {
            httpInFlight = false;
            resolve(
              Response.json({
                choices: [{ message: { content: "slow done" } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              }),
            );
          }, 3000);
          req.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              httpInFlight = false;
              httpAborted = true;
              resolve(new Response("aborted", { status: 499 }));
            },
            { once: true },
          );
        });
      },
    });
    runningServers.push(mockServer);

    const rootDir = makeTempRoot("bf-abort-ctrl-");
    const acpScriptPath = join(rootDir, "slow-acp.ts");
    const cancelMarkerPath = join(rootDir, "acp-cancelled.flag");
    writeMockAcpScript(acpScriptPath, { mode: "hold" });
    writeTestHubConfig(rootDir, {
      mistralBaseUrl: `http://127.0.0.1:${mockServer.port}`,
      devinCommand: "bun",
      devinArgs: ["run", acpScriptPath, cancelMarkerPath],
    });
    writeFileSync(join(rootDir, "system", "secrets.env"), "MISTRAL_API_KEY=sk-abort-test-123456\n", "utf8");

    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    const proj = (
      app.engine.executeCommand({
        commandId: "p1_abt_proj",
        type: "project.create",
        name: "Control Lane Abort",
        seedDemoArtifacts: false,
      }) as { project: { id: string } }
    ).project;

    const httpPeer = (
      app.engine.executeCommand({
        commandId: "p1_abt_http_peer",
        type: "bot.spawn",
        projectId: proj.id,
        name: "Slow-Http-Peer",
        scope: "peer",
        provider: "mistral-hosted",
        model: "glm-5.3",
      }) as { agent: { id: string; activeSessionId: string } }
    ).agent;

    const acpPeer = (
      app.engine.executeCommand({
        commandId: "p1_abt_acp_peer",
        type: "bot.spawn",
        projectId: proj.id,
        name: "Slow-Acp-Peer",
        scope: "peer",
        provider: "devin-acp",
        model: "swe-2-max",
      }) as { agent: { id: string; activeSessionId: string } }
    ).agent;

    const tHttp = (
      app.engine.executeCommand({
        commandId: "p1_abt_t_http",
        type: "task.create",
        projectId: proj.id,
        title: "Long HTTP Task",
        specMd: "Hold work lane open.",
        priority: 1,
      }) as { task: { id: string } }
    ).task;

    const tAcp = (
      app.engine.executeCommand({
        commandId: "p1_abt_t_acp",
        type: "task.create",
        projectId: proj.id,
        title: "Long ACP Task",
        specMd: "Wait for immediate control abort.",
        priority: 2,
      }) as { task: { id: string } }
    ).task;

    app.engine.executeCommand({
      commandId: "p1_abt_disp_http",
      type: "task.dispatch",
      projectId: proj.id,
      taskId: tHttp.id,
      agentId: httpPeer.id,
    });
    app.engine.executeCommand({
      commandId: "p1_abt_disp_acp",
      type: "task.dispatch",
      projectId: proj.id,
      taskId: tAcp.id,
      agentId: acpPeer.id,
    });

    const drainPromise = app.core.drainOutboxOnce();

    // Wait until BOTH slow HTTP turn and slow ACP turn are actively running
    await httpStarted;
    await waitForCondition(() => app.db.getAgent(acpPeer.id)?.status === "working", 3000);
    await waitForCondition(
      () => listSessionAdmissions(app.db, acpPeer.activeSessionId).some((a) => a.status === "started"),
      2000,
    );

    // Pause ACP bot while HTTP task.run is STILL holding work lane!
    const pauseT0 = performance.now();
    app.engine.executeCommand({ commandId: "p1_abt_pause_acp", type: "bot.pause", agentId: acpPeer.id });

    await waitForCondition(
      () =>
        existsSync(cancelMarkerPath) &&
        listSessionAdmissions(app.db, acpPeer.activeSessionId).every((a) => a.status === "terminal"),
      1500,
    );
    const pauseElapsedMs = performance.now() - pauseT0;

    expect(pauseElapsedMs).toBeLessThan(600);
    expect(httpInFlight).toBe(true); // Proves ACP pause did NOT wait behind the 3000ms HTTP task.run!
    expect(app.db.getAgent(acpPeer.id)!.status).toBe("paused");
    expect(app.db.getTask(tAcp.id)!.status).toBe("claimed"); // Mid-turn pause never promotes to in_review

    // Now hard-stop the active HTTP task via bot.stop (control lane) and verify immediate AbortSignal
    const stopT0 = performance.now();
    app.engine.executeCommand({ commandId: "p1_abt_stop_http", type: "bot.stop", agentId: httpPeer.id });
    await waitForCondition(() => httpAborted, 1000);
    const stopElapsedMs = performance.now() - stopT0;

    expect(stopElapsedMs).toBeLessThan(500);
    await drainPromise;
    expect(app.db.getAgent(httpPeer.id)!.status).toBe("stopped");
    expect(app.db.getAgent(httpPeer.id)!.pid).toBeNull();
  });

  it("blocks task and skips .bf-task-*.md when runtime yields { type: 'error' }, and settles session_admissions on failed startSession()", async () => {
    delete process.env.BOT_FACTORY_OFFLINE_MOCK;

    // Part A: Runtime { type: "error" } during executePeerTask -> task 'blocked', no .bf-task-*.md
    const errServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("upstream_model_overload", { status: 500 }),
    });
    runningServers.push(errServer);

    const rootDir = makeTempRoot("bf-err-sm-");
    const failAcpScript = join(rootDir, "fail-init-acp.ts");
    writeMockAcpScript(failAcpScript, { mode: "fail_init" });
    writeTestHubConfig(rootDir, {
      mistralBaseUrl: `http://127.0.0.1:${errServer.port}`,
      devinCommand: "bun",
      devinArgs: ["run", failAcpScript],
    });
    writeFileSync(join(rootDir, "system", "secrets.env"), "MISTRAL_API_KEY=sk-err-test-123456\n", "utf8");

    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    const proj = (
      app.engine.executeCommand({
        commandId: "p1_err_proj",
        type: "project.create",
        name: "Error State Machine",
        seedDemoArtifacts: false,
      }) as { project: { id: string } }
    ).project;

    const httpPeer = (
      app.engine.executeCommand({
        commandId: "p1_err_http_peer",
        type: "bot.spawn",
        projectId: proj.id,
        name: "Http-Err-Peer",
        scope: "peer",
        provider: "mistral-hosted",
        model: "glm-5.3",
      }) as { agent: { id: string; worktreePath: string; activeSessionId: string } }
    ).agent;

    const taskHttpErr = (
      app.engine.executeCommand({
        commandId: "p1_err_task_1",
        type: "task.create",
        projectId: proj.id,
        title: "Failing HTTP Task",
        specMd: "Should block cleanly on 500.",
        priority: 1,
      }) as { task: { id: string } }
    ).task;

    app.engine.executeCommand({
      commandId: "p1_err_disp_1",
      type: "task.dispatch",
      projectId: proj.id,
      taskId: taskHttpErr.id,
      agentId: httpPeer.id,
    });
    await app.core.drainOutboxOnce();

    const failedTask = app.db.getTask(taskHttpErr.id)!;
    expect(failedTask.status).toBe("blocked");
    expect(failedTask.handoffPath).toBeNull();
    expect(existsSync(join(httpPeer.worktreePath, `.bf-task-${taskHttpErr.id}.md`))).toBe(false);
    expect(app.db.getAgent(httpPeer.id)!.status).toBe("error");
    expect(app.db.listAgentTimeline(httpPeer.id).some((item) => item.title === "Task turn failed")).toBe(true);
    expect(app.db.listInboxNotices().some((n) => n.level === "action" && n.agentId === httpPeer.id)).toBe(true);
    expect(listSessionAdmissions(app.db, httpPeer.activeSessionId).every((a) => a.status === "terminal")).toBe(true);

    // Part B: Failed startSession() settles session_admissions cleanly ('terminal'), never leaking 'started'
    const acpPeer = (
      app.engine.executeCommand({
        commandId: "p1_err_acp_peer",
        type: "bot.spawn",
        projectId: proj.id,
        name: "Acp-Init-Fail-Peer",
        scope: "peer",
        provider: "devin-acp",
        model: "swe-2-max",
      }) as { agent: { id: string; worktreePath: string; activeSessionId: string } }
    ).agent;

    const taskAcpFail = (
      app.engine.executeCommand({
        commandId: "p1_err_task_2",
        type: "task.create",
        projectId: proj.id,
        title: "Failing Handshake Task",
        specMd: "startSession fails during initialize.",
        priority: 2,
      }) as { task: { id: string } }
    ).task;

    app.engine.executeCommand({
      commandId: "p1_err_disp_2",
      type: "task.dispatch",
      projectId: proj.id,
      taskId: taskAcpFail.id,
      agentId: acpPeer.id,
    });
    await app.core.drainOutboxOnce();

    const acpAdmissions = listSessionAdmissions(app.db, acpPeer.activeSessionId);
    expect(acpAdmissions).toHaveLength(1);
    expect(acpAdmissions[0]!.status).toBe("terminal");
    expect(app.db.listUnknownAdmissions()).toHaveLength(0);
    // Session must NOT be blocked by a leaked started admission
    expect(() => app.db.enqueueAdmission(acpPeer.activeSessionId, "next-attempt")).not.toThrow();

    expect(app.db.getTask(taskAcpFail.id)!.status).toBe("blocked");
    expect(existsSync(join(acpPeer.worktreePath, `.bf-task-${taskAcpFail.id}.md`))).toBe(false);
    expect(app.db.getAgent(acpPeer.id)!.status).toBe("error");
    expect(app.db.getAgent(acpPeer.id)!.pid).toBeNull();
  });

  it("persists agents.turn_counter across daemon restart without overwriting turn-1 checkpoint ref", async () => {
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";
    const rootDir = makeTempRoot("bf-turn-persist-");
    const dbPath = join(rootDir, "system", "state.db");

    const app1 = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app1);

    const proj = (
      app1.engine.executeCommand({
        commandId: "p1_turn_proj",
        type: "project.create",
        name: "Turn Counter Persistence",
        seedDemoArtifacts: false,
      }) as { project: { id: string } }
    ).project;

    const peer = (
      app1.engine.executeCommand({
        commandId: "p1_turn_peer",
        type: "bot.spawn",
        projectId: proj.id,
        name: "Counter-Peer",
        scope: "peer",
      }) as { agent: { id: string; worktreePath: string } }
    ).agent;

    const task1 = (
      app1.engine.executeCommand({
        commandId: "p1_turn_t1",
        type: "task.create",
        projectId: proj.id,
        title: "Turn 1 Task",
        specMd: "Capture checkpoint turn 1.",
        priority: 1,
      }) as { task: { id: string } }
    ).task;

    app1.engine.executeCommand({
      commandId: "p1_turn_d1",
      type: "task.dispatch",
      projectId: proj.id,
      taskId: task1.id,
      agentId: peer.id,
    });
    await app1.core.drainOutboxOnce();

    expect(app1.db.getAgent(peer.id)!.turnCounter).toBe(1);
    const cpRows1 = app1.db.db
      .query("SELECT turn_num, ref_name, commit_sha FROM checkpoints WHERE agent_id = ? ORDER BY turn_num ASC")
      .all(peer.id) as Array<{ turn_num: number; ref_name: string; commit_sha: string }>;
    expect(cpRows1).toHaveLength(1);
    expect(cpRows1[0]!.turn_num).toBe(1);
    expect(cpRows1[0]!.ref_name.endsWith("/1")).toBe(true);
    const turn1Ref = cpRows1[0]!.ref_name;
    const turn1Sha = cpRows1[0]!.commit_sha;

    runningApps.pop()!.stop();

    // Restart daemon on same rootDir & dbPath
    const app2 = startBotFactoryDaemon({ rootDir, dbPath, port: 0 });
    runningApps.push(app2);
    expect(app2.db.getAgent(peer.id)!.turnCounter).toBe(1);

    const task2 = (
      app2.engine.executeCommand({
        commandId: "p1_turn_t2",
        type: "task.create",
        projectId: proj.id,
        title: "Turn 2 Task",
        specMd: "Capture checkpoint turn 2.",
        priority: 2,
      }) as { task: { id: string } }
    ).task;

    app2.engine.executeCommand({
      commandId: "p1_turn_d2",
      type: "task.dispatch",
      projectId: proj.id,
      taskId: task2.id,
      agentId: peer.id,
    });
    await app2.core.drainOutboxOnce();

    expect(app2.db.getAgent(peer.id)!.turnCounter).toBe(2);
    const cpRows2 = app2.db.db
      .query("SELECT turn_num, ref_name, commit_sha FROM checkpoints WHERE agent_id = ? ORDER BY turn_num ASC")
      .all(peer.id) as Array<{ turn_num: number; ref_name: string; commit_sha: string }>;
    expect(cpRows2).toHaveLength(2);
    expect(cpRows2[0]!.turn_num).toBe(1);
    expect(cpRows2[0]!.ref_name).toBe(turn1Ref);
    expect(cpRows2[0]!.commit_sha).toBe(turn1Sha);
    expect(cpRows2[1]!.turn_num).toBe(2);
    expect(cpRows2[1]!.ref_name.endsWith("/2")).toBe(true);
    expect(cpRows2[1]!.commit_sha).not.toBe(turn1Sha);

    // Verify in Git that turn-1 ref still resolves to original commit SHA
    const gitRef1 = Bun.spawnSync(["git", "rev-parse", "--verify", turn1Ref], {
      cwd: peer.worktreePath,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(gitRef1.exitCode).toBe(0);
    expect(gitRef1.stdout.toString().trim()).toBe(turn1Sha);
  });

  it("cleanly migrates an isolated copy of C:\\Users\\willy\\bot-factory\\system\\state.db* to current schema (v3) and recovers 'verifying' self-mod proposals", () => {
    const realSystemDir = "C:\\Users\\willy\\bot-factory\\system";
    const realDbPath = join(realSystemDir, "state.db");
    expect(existsSync(realDbPath)).toBe(true);

    const beforeStat = statSync(realDbPath);
    const realWalPath = join(realSystemDir, "state.db-wal");
    const beforeWalStat = existsSync(realWalPath) ? statSync(realWalPath) : null;

    const tempDir = makeTempRoot("bf-upgrade-copy-");
    const copyDbPath = join(tempDir, "state.db");
    for (const fileName of ["state.db", "state.db-wal", "state.db-shm"]) {
      const src = join(realSystemDir, fileName);
      if (existsSync(src)) {
        copyFileSync(src, join(tempDir, fileName));
      }
    }

    // Read-only sanity check before migration: confirm copied baseline is schema_version >= 1
    const preCheck = new Database(copyDbPath, { readonly: true });
    const preMeta = preCheck.query("SELECT schema_version FROM runtime_meta WHERE id = 1").get() as {
      schema_version: number;
    };
    const preProjects = preCheck.query("SELECT id FROM projects").all() as Array<{ id: string }>;
    const preAgents = preCheck.query("SELECT id FROM agents").all() as Array<{ id: string }>;
    const preTasks = preCheck.query("SELECT id FROM tasks").all() as Array<{ id: string }>;
    preCheck.close();

    expect(preMeta.schema_version).toBeGreaterThanOrEqual(1);
    expect(preProjects.length).toBeGreaterThanOrEqual(1);
    expect(preAgents.length).toBeGreaterThanOrEqual(1);

    // Boot StateDatabase + recoverAfterRestart() on the isolated copy
    const migrated = new StateDatabase(copyDbPath);
    let closed = false;
    try {
      const firstRec = migrated.recoverAfterRestart();
      expect(firstRec.retiredEffects).toBeGreaterThanOrEqual(0);

      expect(CURRENT_SCHEMA_VERSION).toBe(3);
      const postMeta = migrated.db.query("SELECT schema_version FROM runtime_meta WHERE id = 1").get() as {
        schema_version: number;
      };
      expect(postMeta.schema_version).toBe(CURRENT_SCHEMA_VERSION);
      expect(postMeta.schema_version).toBe(3);

      const tables = new Set(
        (migrated.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
          (r) => r.name,
        ),
      );
      for (const reqTable of ["debates", "debate_messages", "verifications", "self_mod_proposals", "memory_embeddings"]) {
        expect(tables.has(reqTable)).toBe(true);
      }

      const msgCols = new Set(
        (migrated.db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name),
      );
      expect(msgCols.has("sender_agent_id")).toBe(true);
      expect(msgCols.has("sender_role")).toBe(true);

      // Verify existing projects, agents, and tasks are preserved intact
      expect(migrated.listProjects().map((p) => p.id)).toEqual(expect.arrayContaining(preProjects.map((p) => p.id)));
      expect(migrated.listAgents().map((a) => a.id)).toEqual(expect.arrayContaining(preAgents.map((a) => a.id)));
      const preservedTasks = migrated.db.query("SELECT id FROM tasks").all() as Array<{ id: string }>;
      expect(preservedTasks.map((t) => t.id)).toEqual(expect.arrayContaining(preTasks.map((t) => t.id)));

      // Verify 'verifying' self_mod_proposals are reset to 'staged' by recoverAfterRestart()
      const now = Date.now();
      migrated.runAtomicWrite(() => {
        migrated.upsertSelfModProposal({
          id: "smod_stuck_verifying",
          kind: "plugin",
          targetId: "upgrade-test-plugin",
          title: "Stuck Verifying Proposal",
          rationale: "Simulate crash mid-verification",
          authorAgentId: null,
          stagingPath: join(tempDir, "staging", "upgrade-test-plugin.md"),
          livePath: join(tempDir, "plugins", "upgrade-test-plugin", "plugin.md"),
          backupPath: null,
          contentSha256: "deadbeef",
          status: "verifying",
          verificationId: null,
          verificationSummary: null,
          createdAt: now,
          updatedAt: now,
        });
      });

      migrated.close();
      closed = true;

      const rebooted = new StateDatabase(copyDbPath);
      try {
        const secondRec = rebooted.recoverAfterRestart();
        expect(secondRec.resetSelfMods).toBe(1);
        expect(rebooted.getSelfModProposal("smod_stuck_verifying")!.status).toBe("staged");
      } finally {
        rebooted.close();
      }
    } finally {
      if (!closed) migrated.close();
    }

    // Confirm original C:\Users\willy\bot-factory\system\state.db* was NEVER mutated
    const afterStat = statSync(realDbPath);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterStat.size).toBe(beforeStat.size);
    if (beforeWalStat) {
      const afterWalStat = statSync(realWalPath);
      expect(afterWalStat.mtimeMs).toBe(beforeWalStat.mtimeMs);
      expect(afterWalStat.size).toBe(beforeWalStat.size);
    }
  });

  it("deterministically migrates a self-contained v1 SQLite fixture through v2 to v3 while preserving rows and upgrading timestamps", () => {
    const tempDir = makeTempRoot("bf-v1-fixture-");
    const v1DbPath = join(tempDir, "state.db");
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    const rawDb = new Database(v1DbPath, { create: true });
    rawDb.exec(`
      CREATE TABLE runtime_meta (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        epoch INTEGER NOT NULL DEFAULT 0,
        schema_version INTEGER NOT NULL DEFAULT 1,
        instance_id TEXT NOT NULL,
        daemon_pid INTEGER NOT NULL,
        fts_stale INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        routing_overrides_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        parent_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        scope TEXT NOT NULL,
        name TEXT NOT NULL,
        runtime_type TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        worktree_path TEXT,
        worktree_branch TEXT,
        pid INTEGER,
        active_session_id TEXT,
        last_summary TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        system_prompt TEXT NOT NULL,
        system_prompt_hash TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        token_in INTEGER NOT NULL DEFAULT 0,
        token_out INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'message',
        role TEXT NOT NULL,
        title TEXT,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        tool_status TEXT,
        exit_code INTEGER,
        file_path TEXT,
        diff_preview TEXT,
        checkpoint_ref TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        compacted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        spec_md TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ready',
        priority INTEGER NOT NULL DEFAULT 3,
        assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        source_annotation_id TEXT,
        worktree_branch TEXT,
        handoff_path TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE memory_facts (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        namespace TEXT NOT NULL,
        doc_id TEXT,
        entity TEXT NOT NULL DEFAULT 'general',
        fact_text TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('fact','preference','decision','episode')),
        version INTEGER NOT NULL DEFAULT 1,
        is_latest INTEGER NOT NULL DEFAULT 1,
        is_forgotten INTEGER NOT NULL DEFAULT 0,
        is_inference INTEGER NOT NULL DEFAULT 0,
        is_static INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 0.85,
        valid_from INTEGER NOT NULL,
        forget_after INTEGER,
        forget_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE memory_edges (
        src_id TEXT NOT NULL,
        dst_id TEXT NOT NULL,
        rel TEXT NOT NULL CHECK(rel IN ('updates','extends','derives')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(src_id, dst_id, rel)
      );
    `);

    rawDb
      .query(
        "INSERT INTO runtime_meta (id, epoch, schema_version, instance_id, daemon_pid, fts_stale, started_at) VALUES (1, 1, 1, 'inst_v1', 9999, 0, ?)",
      )
      .run(nowMs);
    rawDb
      .query(
        "INSERT INTO projects (id, slug, name, root_path, repo_path, status, created_at) VALUES ('prj_v1', 'v1-proj', 'V1 Fixture', ?, ?, 'active', ?)",
      )
      .run(join(tempDir, "proj"), join(tempDir, "proj", "repo"), nowMs);
    rawDb
      .query(
        "INSERT INTO agents (id, project_id, scope, name, runtime_type, provider, model, status, active_session_id, updated_at) VALUES ('agt_v1', 'prj_v1', 'peer', 'Forge-V1', 'native_http', 'mistral-hosted', 'glm-5.3', 'working', 'ses_v1', ?)",
      )
      .run(nowMs);
    rawDb
      .query(
        "INSERT INTO sessions (id, agent_id, system_prompt, system_prompt_hash, created_at, updated_at) VALUES ('ses_v1', 'agt_v1', 'sys', 'hash_v1', ?, ?)",
      )
      .run(nowMs, nowMs);
    rawDb
      .query(
        "INSERT INTO messages (id, session_id, agent_id, seq, kind, role, title, content, created_at) VALUES ('msg_v1', 'ses_v1', 'agt_v1', 1, 'message', 'assistant', 'V1 Msg', 'Legacy v1 assistant message', ?)",
      )
      .run(nowMs);
    rawDb
      .query(
        "INSERT INTO tasks (id, project_id, title, spec_md, status, priority, assigned_agent_id, created_at, updated_at) VALUES ('tsk_v1', 'prj_v1', 'Legacy V1 Task', 'Verify v1 -> v2 -> v3 upgrade', 'ready', 2, 'agt_v1', ?, ?)",
      )
      .run(nowMs, nowMs);
    rawDb
      .query(
        "INSERT INTO memory_facts (id, namespace, entity, fact_text, kind, valid_from, forget_after, created_at, updated_at) VALUES ('fact_v1_a', 'global', 'studio', 'Prefer strict checks', 'preference', ?, ?, ?, ?), ('fact_v1_b', 'global', 'studio', 'Use isolated worktrees', 'decision', ?, NULL, ?, ?)",
      )
      .run(nowSec, nowSec + 3600, nowSec, nowSec, nowSec, nowSec, nowSec);
    rawDb
      .query("INSERT INTO memory_edges (src_id, dst_id, rel, created_at) VALUES ('fact_v1_b', 'fact_v1_a', 'extends', ?)")
      .run(nowSec);
    rawDb.close();

    const migrated = new StateDatabase(v1DbPath);
    try {
      const rec = migrated.recoverAfterRestart();
      expect(rec.resetAgents).toBe(1);

      const postMeta = migrated.db.query("SELECT schema_version FROM runtime_meta WHERE id = 1").get() as {
        schema_version: number;
      };
      expect(postMeta.schema_version).toBe(3);

      const tables = new Set(
        (migrated.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
          (r) => r.name,
        ),
      );
      for (const reqTable of ["debates", "debate_messages", "verifications", "self_mod_proposals", "memory_embeddings"]) {
        expect(tables.has(reqTable)).toBe(true);
      }

      const colsOf = (table: string) =>
        new Set((migrated.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
      expect(colsOf("projects").has("verify_checks_json")).toBe(true);
      expect(colsOf("agents").has("turn_counter")).toBe(true);
      expect(colsOf("agents").has("depth")).toBe(true);
      expect(colsOf("agents").has("subagent_mode")).toBe(true);
      expect(colsOf("tasks").has("depends_on_json")).toBe(true);
      expect(colsOf("tasks").has("auto_retry_count")).toBe(true);
      expect(colsOf("messages").has("sender_agent_id")).toBe(true);
      expect(colsOf("messages").has("sender_role")).toBe(true);

      // Verify preserved rows + second-scale -> ms timestamp upgrade
      expect(migrated.listProjects().map((p) => p.id)).toContain("prj_v1");
      const agent = migrated.getAgent("agt_v1");
      expect(agent?.status).toBe("idle");
      expect(agent?.turnCounter).toBe(0);
      expect(migrated.getTask("tsk_v1")?.dependsOn).toEqual([]);
      const msg = migrated.getMessage("msg_v1");
      expect(msg?.content).toBe("Legacy v1 assistant message");
      expect(msg?.senderAgentId).toBeNull();

      const upgradedFact = migrated.db
        .query("SELECT valid_from, forget_after, created_at FROM memory_facts WHERE id = 'fact_v1_a'")
        .get() as { valid_from: number; forget_after: number; created_at: number };
      expect(upgradedFact.valid_from).toBe(nowSec * 1000);
      expect(upgradedFact.forget_after).toBe((nowSec + 3600) * 1000);
      expect(upgradedFact.created_at).toBe(nowSec * 1000);

      const liveCount = (migrated.db.query("SELECT COUNT(*) AS cnt FROM live_memory_facts").get() as { cnt: number }).cnt;
      expect(liveCount).toBe(2);
    } finally {
      migrated.close();
    }
  });
});
