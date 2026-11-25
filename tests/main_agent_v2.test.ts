import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HubConfigSchema, type HubConfig } from "@bot-factory/shared";
import { loadHubConfig, saveHubConfig } from "../apps/daemon/src/config";
import { CURRENT_SCHEMA_VERSION, StateDatabase } from "../apps/daemon/src/db/database";
import { type BotFactoryApp, startBotFactoryDaemon } from "../apps/daemon/src/index";

const tempDirs: string[] = [];
const runningApps: BotFactoryApp[] = [];
const mockServers: Array<ReturnType<typeof Bun.serve>> = [];
const savedEnv = new Map<string, string | undefined>();

function rememberEnv(key: string): void {
  if (!savedEnv.has(key)) {
    savedEnv.set(key, process.env[key]);
  }
}

function makeTempRoot(prefix = "bf-v2-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function openAuthedWs(url: string, token: string): WebSocket {
  return new WebSocket(url, { headers: { "x-bf-token": token } } as unknown as string[]);
}

function waitForWsEvent(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("ws_wait_timeout"));
    }, timeoutMs);
    const handler = (ev: MessageEvent) => {
      const parsed = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolvePromise(parsed);
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function syncWs(ws: WebSocket): Promise<void> {
  const ts = Date.now() + Math.floor(Math.random() * 10000);
  const pong = waitForWsEvent(ws, (m) => m.kind === "pong" && m.ts === ts);
  ws.send(JSON.stringify({ kind: "ping", ts }));
  await pong;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`waitUntil_timeout:${label}`);
}

function encodeOpenAiSse(opts: {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}): Uint8Array {
  const chunks: string[] = [];
  if (opts.toolCalls && opts.toolCalls.length > 0) {
    opts.toolCalls.forEach((tc, idx) => {
      chunks.push(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: idx,
                    id: tc.id,
                    type: "function",
                    function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
    });
  }
  if (opts.text) {
    chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: opts.text } }] })}\n\n`);
  }
  chunks.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 32, completion_tokens: 18 } })}\n\n`);
  chunks.push("data: [DONE]\n\n");
  return new TextEncoder().encode(chunks.join(""));
}

function makeBaseTestConfig(rootDir: string, extraProviders?: HubConfig["providers"]): HubConfig {
  const loaded = loadHubConfig({ rootDir, port: 0 });
  const cfg = structuredClone(loaded.config);
  if (extraProviders) {
    Object.assign(cfg.providers, extraProviders);
  }
  return cfg;
}

afterEach(() => {
  for (const [key, val] of savedEnv.entries()) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  savedEnv.clear();

  while (runningApps.length > 0) {
    runningApps.pop()?.stop();
  }
  while (mockServers.length > 0) {
    mockServers.pop()?.stop(true);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows handle release delay
    }
  }
});

describe("Main Agent V2 Backend — Migration, Bot Model/Message, Tools, Delegation & Artifact PUT", () => {
  it("migrates schema v2 -> v4 idempotently while preserving rows, hydrates senderAgentId/senderRole, and updates agent models atomically", () => {
    const dir = makeTempRoot("bf-v2-db-");
    const dbPath = join(dir, "state.db");
    const now = Date.now();

    // Seed a realistic v2 SQLite database WITHOUT sender_agent_id / sender_role columns on messages.
    const rawDb = new Database(dbPath, { create: true });
    rawDb.exec(`
      CREATE TABLE runtime_meta (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        epoch INTEGER NOT NULL DEFAULT 0,
        schema_version INTEGER NOT NULL DEFAULT 2,
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
        verify_checks_json TEXT NOT NULL DEFAULT '[]',
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
        turn_counter INTEGER NOT NULL DEFAULT 0,
        depth INTEGER NOT NULL DEFAULT 0,
        subagent_mode TEXT,
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
    `);

    rawDb
      .query(
        "INSERT INTO runtime_meta (id, epoch, schema_version, instance_id, daemon_pid, fts_stale, started_at) VALUES (1, 3, 2, 'inst_v2', 1234, 0, ?)",
      )
      .run(now);
    rawDb
      .query(
        "INSERT INTO projects (id, slug, name, root_path, repo_path, status, created_at) VALUES ('prj_v2', 'v2-proj', 'V2 Project', ?, ?, 'active', ?)",
      )
      .run(join(dir, "proj"), join(dir, "proj", "repo"), now);
    rawDb
      .query(
        "INSERT INTO agents (id, project_id, scope, name, runtime_type, provider, model, status, active_session_id, updated_at) VALUES ('bot_v2', 'prj_v2', 'peer', 'V2-Bot', 'native_http', 'mistral-hosted', 'glm-5.3', 'idle', 'ses_v2', ?)",
      )
      .run(now);
    rawDb
      .query(
        "INSERT INTO sessions (id, agent_id, system_prompt, system_prompt_hash, created_at, updated_at) VALUES ('ses_v2', 'bot_v2', 'sys', 'hash', ?, ?)",
      )
      .run(now, now);
    rawDb
      .query(
        "INSERT INTO messages (id, session_id, agent_id, seq, kind, role, title, content, created_at) VALUES ('msg_v2_legacy', 'ses_v2', 'bot_v2', 1, 'message', 'user', 'Legacy Title', 'Preserved v2 message content', ?)",
      )
      .run(now);
    rawDb.close();

    expect(CURRENT_SCHEMA_VERSION).toBe(4);

    const migrated = new StateDatabase(dbPath);
    try {
      const metaRow = migrated.db.query("SELECT schema_version FROM runtime_meta WHERE id = 1").get() as {
        schema_version: number;
      };
      expect(metaRow.schema_version).toBe(CURRENT_SCHEMA_VERSION);

      const cols = (migrated.db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cols).toContain("sender_agent_id");
      expect(cols).toContain("sender_role");
      const taskCols = (migrated.db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(taskCols).toContain("goal_id");
      const tables = (migrated.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
      expect(tables).toContain("team_goals");

      // Legacy v2 message row must be preserved intact
      const legacy = migrated.getMessage("msg_v2_legacy");
      expect(legacy).not.toBeNull();
      expect(legacy?.content).toBe("Preserved v2 message content");
      expect(legacy?.title).toBe("Legacy Title");
      expect(legacy?.senderAgentId).toBeNull();
      expect(legacy?.senderRole).toBeUndefined();

      // Persist & hydrate v3 fields
      migrated.runAtomicWrite(() => {
        migrated.appendMessage({
          id: "msg_v3_orch",
          agentId: "bot_v2",
          sessionId: "ses_v2",
          seq: 0,
          kind: "message",
          role: "user",
          senderAgentId: "agent_meta_orchestrator",
          senderRole: "orchestrator",
          title: "Orchestrator Note",
          content: "Please switch to tests first",
          createdAt: now + 50,
        });
      });

      const hydratedGet = migrated.getMessage("msg_v3_orch");
      expect(hydratedGet?.senderAgentId).toBe("agent_meta_orchestrator");
      expect(hydratedGet?.senderRole).toBe("orchestrator");

      const hydratedTimeline = migrated.listAgentTimeline("bot_v2");
      expect(hydratedTimeline.map((m) => m.id)).toEqual(["msg_v2_legacy", "msg_v3_orch"]);
      expect(hydratedTimeline[1]?.senderAgentId).toBe("agent_meta_orchestrator");
      expect(hydratedTimeline[1]?.senderRole).toBe("orchestrator");

      const hydratedList = migrated.listMessages("ses_v2");
      expect(hydratedList).toHaveLength(2);
      expect(hydratedList[1]?.senderRole).toBe("orchestrator");

      // updateAgentModel atomic update + null on missing agent
      const updatedBot = migrated.updateAgentModel("bot_v2", "openai", "gpt-5.2", "native_http");
      expect(updatedBot).not.toBeNull();
      expect(updatedBot?.provider).toBe("openai");
      expect(updatedBot?.model).toBe("gpt-5.2");
      expect(updatedBot?.runtimeType).toBe("native_http");
      expect(migrated.updateAgentModel("bot_missing", "openai", "gpt-5.2", "native_http")).toBeNull();
    } finally {
      migrated.close();
    }

    // Re-opening must be idempotent
    const reopened = new StateDatabase(dbPath);
    try {
      const meta2 = reopened.db.query("SELECT schema_version FROM runtime_meta WHERE id = 1").get() as {
        schema_version: number;
      };
      expect(meta2.schema_version).toBe(CURRENT_SCHEMA_VERSION);
      expect(reopened.getMessage("msg_v2_legacy")?.content).toBe("Preserved v2 message content");
      expect(reopened.getMessage("msg_v3_orch")?.senderRole).toBe("orchestrator");
    } finally {
      reopened.close();
    }
  });

  it("supports bot.update_model and bot.message RPC commands with validation, session handle reset, orchestrator attribution, and autonomous turn execution", async () => {
    rememberEnv("BOT_FACTORY_OFFLINE_MOCK");
    delete process.env.BOT_FACTORY_OFFLINE_MOCK;

    const seenModelCalls: Array<{ path: string; model: string; lastUser: string }> = [];
    const mockHttp: ReturnType<typeof Bun.serve> = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req): Promise<Response> => {
        const url = new URL(req.url);
        const body = (await req.json()) as {
          model?: string;
          messages?: Array<{ role: string; content: unknown }>;
        };
        const lastUser = String(body.messages?.filter((m) => m.role === "user").at(-1)?.content ?? "");
        seenModelCalls.push({ path: url.pathname, model: String(body.model ?? ""), lastUser });
        return new Response(
          encodeOpenAiSse({
            text: `Reply from ${String(body.model)} via ${url.pathname}`,
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    mockServers.push(mockHttp);

    const rootDir = makeTempRoot("bf-v2-rpc-");
    const cfg = makeBaseTestConfig(rootDir, {
      "mock-alpha": {
        runtime: "native_http",
        protocol: "openai_compatible",
        baseUrl: `http://127.0.0.1:${mockHttp.port}/alpha`,
        models: {
          "alpha-fast": { id: "alpha-fast", capabilities: ["coding"], tier: "fast" },
          "alpha-pro": { id: "alpha-pro", capabilities: ["coding", "review"], tier: "flagship" },
        },
      },
      "mock-beta": {
        runtime: "native_http",
        protocol: "openai_compatible",
        baseUrl: `http://127.0.0.1:${mockHttp.port}/beta`,
        models: {
          "beta-max": { id: "beta-max", capabilities: ["reasoning"], tier: "flagship" },
        },
      },
    });
    cfg.routing.defaultsByIntent.project_manager = { provider: "mock-alpha", model: "alpha-pro" };
    cfg.routing.defaultsByIntent.coding_parallel = { provider: "mock-alpha", model: "alpha-fast" };
    saveHubConfig(join(rootDir, "system", "config.json"), cfg);

    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    const token = readFileSync(join(rootDir, "system", ".daemon-token"), "utf8").trim();
    const ws = openAuthedWs(`${app.url.replace("http://", "ws://")}/ws`, token);
    await new Promise<void>((res) => (ws.onopen = () => res()));
    const events: Array<{ topic: string; eventType: string; data: unknown }> = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { kind?: string; topic: string; eventType: string; data: unknown };
      if (msg.kind === "event") events.push(msg);
    });

    const { project, projectManager } = app.engine.executeCommand({
      commandId: "v2_rpc_proj",
      type: "project.create",
      name: "RPC V2 Lab",
      seedDemoArtifacts: false,
    }) as { project: { id: string; slug: string }; projectManager: { id: string } };

    const { agent: peer } = app.engine.executeCommand({
      commandId: "v2_rpc_peer",
      type: "bot.spawn",
      projectId: project.id,
      name: "Worker-1",
      scope: "peer",
    }) as { agent: { id: string; provider: string; model: string; activeSessionId: string } };

    ws.send(JSON.stringify({ kind: "subscribe", topic: "global:status" }));
    ws.send(JSON.stringify({ kind: "subscribe", topic: `project:${project.id}:board` }));
    ws.send(JSON.stringify({ kind: "subscribe", topic: `bot:${peer.id}:timeline` }));
    ws.send(JSON.stringify({ kind: "subscribe", topic: `bot:${projectManager.id}:timeline` }));
    await syncWs(ws);

    // 1. Send initial message as orchestrator -> peer replies using alpha-fast
    const msg1Res = app.engine.executeCommand({
      commandId: "v2_msg_1",
      type: "bot.message",
      projectId: project.id,
      agentId: peer.id,
      message: "Check initial model",
      senderRole: "orchestrator",
    }) as { queued: boolean; messageId: string };
    expect(msg1Res.queued).toBe(true);
    await app.core.drainOutboxOnce();
    await syncWs(ws);

    const peerTimeline1 = app.db.listAgentTimeline(peer.id);
    expect(peerTimeline1[0]?.senderRole).toBe("orchestrator");
    expect(peerTimeline1[0]?.senderAgentId).toBe(app.engine.metaAgentId);
    expect(peerTimeline1[0]?.kind).toBe("message");
    expect(peerTimeline1[1]?.role).toBe("assistant");
    expect(peerTimeline1[1]?.content).toContain("Reply from alpha-fast via /alpha/chat/completions");

    // 2. Switch peer model to mock-beta / beta-max via bot.update_model
    events.length = 0;
    const updRes = app.engine.executeCommand({
      commandId: "v2_upd_model",
      type: "bot.update_model",
      agentId: peer.id,
      provider: "mock-beta",
      model: "beta-max",
    }) as { agent: { provider: string; model: string; runtimeType: string } };
    expect(updRes.agent.provider).toBe("mock-beta");
    expect(updRes.agent.model).toBe("beta-max");
    expect(updRes.agent.runtimeType).toBe("native_http");
    await syncWs(ws);

    expect(
      events.some((e) => e.topic === `project:${project.id}:board` && e.eventType === "board.updated"),
    ).toBe(true);
    expect(events.some((e) => e.topic === "global:status" && e.eventType === "status.updated")).toBe(true);

    // Next turn binds new provider & model cleanly!
    app.engine.executeCommand({
      commandId: "v2_msg_2",
      type: "bot.message",
      projectId: project.slug,
      agentId: peer.id,
      message: "Confirm switched model",
    });
    await app.core.drainOutboxOnce();
    await syncWs(ws);

    const peerTimeline2 = app.db.listAgentTimeline(peer.id);
    const secondUserMsg = peerTimeline2.find((m) => m.content === "Confirm switched model");
    expect(secondUserMsg?.senderRole).toBe("user");
    expect(secondUserMsg?.senderAgentId).toBeNull();
    expect(peerTimeline2.at(-1)?.content).toContain("Reply from beta-max via /beta/chat/completions");

    // 3. Switch to acp_stdio provider -> runtimeType updates to acp_stdio
    const acpUpd = app.engine.executeCommand({
      commandId: "v2_upd_acp",
      type: "bot.update_model",
      agentId: peer.id,
      provider: "devin-acp",
      model: "swe-2-max",
    }) as { agent: { runtimeType: string } };
    expect(acpUpd.agent.runtimeType).toBe("acp_stdio");

    // 4. Validation errors on bot.update_model and bot.message
    expect(() =>
      app.engine.executeCommand({
        commandId: "v2_upd_bad_prov",
        type: "bot.update_model",
        agentId: peer.id,
        provider: "nonexistent",
        model: "m1",
      }),
    ).toThrow("Unknown provider");

    expect(() =>
      app.engine.executeCommand({
        commandId: "v2_upd_bad_model",
        type: "bot.update_model",
        agentId: peer.id,
        provider: "mock-beta",
        model: "missing-model",
      }),
    ).toThrow("Unknown model");

    const { project: otherProject } = app.engine.executeCommand({
      commandId: "v2_rpc_other_proj",
      type: "project.create",
      name: "Other Project",
      seedDemoArtifacts: false,
    }) as { project: { id: string } };
    expect(() =>
      app.engine.executeCommand({
        commandId: "v2_msg_mismatch",
        type: "bot.message",
        projectId: otherProject.id,
        agentId: peer.id,
        message: "Should fail",
      }),
    ).toThrow("agent_project_mismatch");

    app.engine.executeCommand({ commandId: "v2_stop_peer", type: "bot.stop", agentId: peer.id });
    await app.core.drainOutboxOnce();
    expect(() =>
      app.engine.executeCommand({
        commandId: "v2_msg_stopped",
        type: "bot.message",
        projectId: project.id,
        agentId: peer.id,
        message: "Should fail on stopped",
      }),
    ).toThrow("agent_unavailable:stopped");

    // Verify bot.message also works cleanly on PM
    app.engine.executeCommand({
      commandId: "v2_msg_pm",
      type: "bot.message",
      projectId: project.id,
      agentId: projectManager.id,
      message: "Direct PM check",
      senderRole: "orchestrator",
    });
    await app.core.drainOutboxOnce();
    await syncWs(ws);
    const pmTl = app.db.listAgentTimeline(projectManager.id);
    expect(pmTl[0]?.senderRole).toBe("orchestrator");
    expect(pmTl[1]?.content).toContain("Reply from alpha-pro via /alpha/chat/completions");

    ws.close();
  });

  it("executes all Main Agent V2 tools end-to-end via Meta-Orchestrator turns, scrubs secrets, and sets orchestrator attribution on bf_team_delegate", async () => {
    rememberEnv("BOT_FACTORY_OFFLINE_MOCK");
    delete process.env.BOT_FACTORY_OFFLINE_MOCK;

    const leakedSecret = "sk-main-v2-secret-value-abcdef123456";
    let metaStep = 0;
    let capturedMetaSystemPrompt = "";
    let spawnedPeerId = "";
    let createdTaskId = "";
    let depTaskId = "";
    let coderMessageDone = false;

    const mockHttp: ReturnType<typeof Bun.serve> = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req): Promise<Response> => {
        const url = new URL(req.url);
        const body = (await req.json()) as {
          model?: string;
          messages?: Array<{ role: string; content: unknown }>;
        };
        if (url.pathname === "/meta/chat/completions") {
          capturedMetaSystemPrompt = String(body.messages?.find((m) => m.role === "system")?.content ?? "");
          metaStep += 1;

          const toolOutputs = (body.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
          for (const out of toolOutputs) {
            expect(out).not.toContain('"error"');
          }

          if (metaStep === 1) {
            return new Response(
              encodeOpenAiSse({
                toolCalls: [
                  { id: "tc_1", name: "bf_config_get", args: {} },
                  {
                    id: "tc_2",
                    name: "bf_project_create",
                    args: { name: "V2 Tools Studio", slug: "v2-tools", seedDemoArtifacts: false },
                  },
                ],
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }

          if (metaStep === 2) {
            const cfgToolOut = toolOutputs.find((t) => t.includes("providers")) ?? "";
            expect(cfgToolOut).not.toContain(leakedSecret);
            expect(cfgToolOut).toContain("apiKeyConfigured");

            return new Response(
              encodeOpenAiSse({
                toolCalls: [
                  {
                    id: "tc_3",
                    name: "bf_config_update",
                    args: {
                      patch: {
                        providers: {
                          "hot-v2": {
                            runtime: "native_http",
                            protocol: "openai_compatible",
                            baseUrl: `http://127.0.0.1:${mockHttp.port}/bot`,
                            models: {
                              "hot-coder": { id: "hot-coder", capabilities: ["coding"], tier: "balanced" },
                            },
                          },
                        },
                        guardrails: { maxTaskAutoRetries: 3 },
                      },
                      projectRoutingOverride: {
                        projectId: "v2-tools",
                        intent: "coding_parallel",
                        provider: "hot-v2",
                        model: "hot-coder",
                      },
                    },
                  },
                  {
                    id: "tc_4",
                    name: "bf_bot_spawn",
                    args: {
                      projectId: "v2-tools",
                      name: "Coder-V2",
                      scope: "peer",
                      provider: "bot-http",
                      model: "bot-1",
                      autonomyLevel: "high",
                      reasoningEffort: "medium",
                    },
                  },
                  {
                    id: "tc_5",
                    name: "bf_bot_spawn",
                    args: {
                      projectId: "v2-tools",
                      name: "Verifier-V2",
                      scope: "verifier",
                    },
                  },
                ],
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }

          if (metaStep === 3) {
            const spawnOut = toolOutputs.find((t) => t.includes("Coder-V2")) ?? "{}";
            spawnedPeerId = (JSON.parse(spawnOut) as { agent: { id: string } }).agent.id;

            return new Response(
              encodeOpenAiSse({
                toolCalls: [
                  {
                    id: "tc_6",
                    name: "bf_bot_update_model",
                    args: { agentId: spawnedPeerId, provider: "hot-v2", model: "hot-coder" },
                  },
                  {
                    id: "tc_7",
                    name: "bf_bot_message",
                    args: { projectId: "v2-tools", agentId: spawnedPeerId, message: "Hello from Main Manager" },
                  },
                  {
                    id: "tc_8",
                    name: "bf_task_create",
                    args: { projectId: "v2-tools", title: "Root V2 Task", specMd: "Initial spec", priority: 1 },
                  },
                ],
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }

          if (metaStep === 4) {
            const createOut = toolOutputs.find((t) => t.includes("Root V2 Task")) ?? "{}";
            createdTaskId = (JSON.parse(createOut) as { task: { id: string } }).task.id;

            return new Response(
              encodeOpenAiSse({
                toolCalls: [
                  {
                    id: "tc_9",
                    name: "bf_task_create",
                    args: {
                      projectId: "v2-tools",
                      title: "Dependent V2 Task",
                      specMd: "Waits for Root V2 Task",
                      priority: 2,
                      dependsOn: [createdTaskId],
                    },
                  },
                  {
                    id: "tc_10",
                    name: "bf_task_update",
                    args: {
                      taskId: createdTaskId,
                      specMd: "Updated spec by Main Manager",
                      priority: 2,
                      assignedAgentId: "Coder-V2",
                    },
                  },
                  { id: "tc_11", name: "bf_task_list", args: { projectId: "v2-tools" } },
                ],
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }

          if (metaStep === 5) {
            const depOut = toolOutputs.find((t) => t.includes("Dependent V2 Task")) ?? "{}";
            depTaskId = (JSON.parse(depOut) as { task: { id: string } }).task.id;

            const listOut = toolOutputs.find((t) => t.includes("assignedAgentName")) ?? "{}";
            const parsedList = JSON.parse(listOut) as {
              tasks: Array<{ id: string; assignedAgentName: string | null; dependsOn: string[] }>;
            };
            const rootListed = parsedList.tasks.find((t) => t.id === createdTaskId);
            const depListed = parsedList.tasks.find((t) => t.id === depTaskId);
            expect(rootListed?.assignedAgentName).toBe("Coder-V2");
            expect(depListed?.dependsOn).toEqual([createdTaskId]);

            // Wait until Coder-V2 finishes the bot.message turn before dispatching Root V2 Task to Coder-V2
            await waitUntil(() => coderMessageDone, 5000, "coder_message_done");
            await new Promise((r) => setTimeout(r, 40));

            return new Response(
              encodeOpenAiSse({
                toolCalls: [
                  {
                    id: "tc_12",
                    name: "bf_task_dispatch",
                    args: {
                      projectId: "v2-tools",
                      taskId: createdTaskId,
                      agentId: spawnedPeerId,
                      autonomous: false,
                    },
                  },
                  {
                    id: "tc_13",
                    name: "bf_team_delegate",
                    args: {
                      projectId: "v2-tools",
                      goal: "Coordinate V2 milestone delivery",
                      autonomyLevel: "high",
                      reasoningEffort: "medium",
                    },
                  },
                  { id: "tc_14", name: "bf_team_status", args: { projectId: "v2-tools" } },
                ],
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }

          return new Response(
            encodeOpenAiSse({ text: "All V2 management actions completed." }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }

        // Bot / PM mock turns
        const lastUser = String(body.messages?.filter((m) => m.role === "user").at(-1)?.content ?? "");
        if (lastUser === "Hello from Main Manager") {
          coderMessageDone = true;
        }
        return new Response(
          encodeOpenAiSse({ text: `Mock bot reply (${String(body.model)})` }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    mockServers.push(mockHttp);

    const rootDir = makeTempRoot("bf-v2-tools-");
    const cfg = makeBaseTestConfig(rootDir, {
      "meta-http": {
        runtime: "native_http",
        protocol: "openai_compatible",
        baseUrl: `http://127.0.0.1:${mockHttp.port}/meta`,
        apiKeyEnv: "META_TEST_SECRET",
        models: { "meta-1": { id: "meta-1", capabilities: ["reasoning", "planning"], tier: "flagship" } },
      },
      "bot-http": {
        runtime: "native_http",
        protocol: "openai_compatible",
        baseUrl: `http://127.0.0.1:${mockHttp.port}/bot`,
        models: { "bot-1": { id: "bot-1", capabilities: ["coding"], tier: "balanced" } },
      },
    });
    cfg.routing.defaultsByIntent.meta_orchestrator = { provider: "meta-http", model: "meta-1" };
    cfg.routing.defaultsByIntent.project_manager = { provider: "bot-http", model: "bot-1" };
    cfg.routing.defaultsByIntent.coding_parallel = { provider: "bot-http", model: "bot-1" };
    cfg.routing.defaultsByIntent.verifier_default = { provider: "bot-http", model: "bot-1" };
    cfg.memory.dreaming.debounceSeconds = 120;
    saveHubConfig(join(rootDir, "system", "config.json"), cfg);
    writeFileSync(join(rootDir, "system", "secrets.env"), `META_TEST_SECRET=${leakedSecret}\n`, "utf8");

    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    app.engine.executeCommand({
      commandId: "v2_chat_run",
      type: "chat.send",
      text: "Configure hot-v2, spawn Coder-V2 & Verifier-V2, update model, message bot, manage tasks, and delegate goal.",
    });

    await app.core.drainOutboxOnce();
    await waitUntil(() => metaStep >= 6, 15_000, "meta_tool_steps");
    await app.core.drainOutboxOnce();

    // 1. Main Agent system prompt documents all V2 tools
    for (const toolName of [
      "bf_project_create",
      "bf_config_get",
      "bf_config_update",
      "bf_bot_spawn",
      "bf_bot_update_model",
      "bf_bot_message",
      "bf_task_list",
      "bf_task_create",
      "bf_task_update",
      "bf_task_dispatch",
      "bf_team_delegate",
      "bf_team_status",
    ]) {
      expect(capturedMetaSystemPrompt).toContain(toolName);
    }

    // 2. Project & config overrides persisted and hot-reloaded
    const project = app.db.getProject("v2-tools");
    expect(project).not.toBeNull();
    expect(project?.routingOverrides.coding_parallel).toEqual({ provider: "hot-v2", model: "hot-coder" });
    const persistedConfig = JSON.parse(readFileSync(join(rootDir, "system", "config.json"), "utf8")) as HubConfig;
    expect(persistedConfig.providers["hot-v2"]).toBeTruthy();
    expect(persistedConfig.guardrails.maxTaskAutoRetries).toBe(3);

    // 3. Spawned bots & updated model
    const agents = app.db.listAgents(project?.id);
    const coder = agents.find((a) => a.name === "Coder-V2");
    const verifier = agents.find((a) => a.name === "Verifier-V2");
    const pm = agents.find((a) => a.scope === "project");
    expect(coder?.provider).toBe("hot-v2");
    expect(coder?.model).toBe("hot-coder");
    expect(verifier?.scope).toBe("verifier");

    // 4. Direct bf_bot_message stamped orchestrator role & triggered turn
    const coderTimeline = app.db.listAgentTimeline(coder?.id ?? "");
    const mgrMsg = coderTimeline.find((m) => m.content === "Hello from Main Manager");
    expect(mgrMsg).toBeTruthy();
    expect(mgrMsg?.senderAgentId).toBe(app.engine.metaAgentId);
    expect(mgrMsg?.senderRole).toBe("orchestrator");
    expect(coderTimeline.some((m) => m.role === "assistant" && m.content.includes("hot-coder"))).toBe(true);

    // 5. Task creation, update, DAG deps, and dispatch
    const rootTask = app.db.getTask(createdTaskId);
    expect(rootTask?.specMd).toBe("Updated spec by Main Manager");
    expect(rootTask?.priority).toBe(2);
    expect(rootTask?.assignedAgentId).toBe(coder?.id ?? null);
    expect(rootTask?.status).toBe("in_review");

    // 6. bf_team_delegate attribution on PM timeline
    const pmTimeline = app.db.listAgentTimeline(pm?.id ?? "");
    const delegationItem = pmTimeline.find((m) => m.content === "Coordinate V2 milestone delivery");
    expect(delegationItem).toBeTruthy();
    expect(delegationItem?.kind).toBe("message");
    expect(delegationItem?.role).toBe("user");
    expect(delegationItem?.senderAgentId).toBe(app.engine.metaAgentId);
    expect(delegationItem?.senderRole).toBe("orchestrator");
    expect(delegationItem?.title).toMatch(/^Main Manager Delegation \(goal_/);
  }, 20_000);

  it("enforces PUT /api/projects/:id/artifact writes (utf8 + base64 PNG), preview WS events, 403 traversal/scope blocks, 415 extension rejection, and factory-droid-acp in config.example.json", async () => {
    const rootDir = makeTempRoot("bf-v2-art-");
    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    const token = readFileSync(join(rootDir, "system", ".daemon-token"), "utf8").trim();
    const { project } = app.engine.executeCommand({
      commandId: "v2_art_proj",
      type: "project.create",
      name: "Artifact Put Lab",
      seedDemoArtifacts: true,
    }) as { project: { id: string; rootPath: string } };

    // 1. Auth & origin guards
    const unauthPut = await fetch(`${app.url}/api/projects/${project.id}/artifact?path=plans/new.md`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# Unauth", encoding: "utf8" }),
    });
    expect(unauthPut.status).toBe(401);

    const evilOriginPut = await fetch(`${app.url}/api/projects/${project.id}/artifact?path=plans/new.md`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-bf-token": token,
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ content: "# Evil", encoding: "utf8" }),
    });
    expect(evilOriginPut.status).toBe(403);

    // Subscribe to project:<id>:previews for artifact.updated verification
    const ws = openAuthedWs(`${app.url.replace("http://", "ws://")}/ws`, token);
    await new Promise<void>((res) => (ws.onopen = () => res()));
    const previewEvents: Array<{ topic: string; eventType: string; data: Record<string, unknown> }> = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        kind?: string;
        topic: string;
        eventType: string;
        data: Record<string, unknown>;
      };
      if (msg.kind === "event") previewEvents.push(msg);
    });
    ws.send(JSON.stringify({ kind: "subscribe", topic: `project:${project.id}:previews` }));
    await syncWs(ws);

    // 2. Doc UTF-8 write via query param + nested dir creation
    const mdRes = await fetch(
      `${app.url}/api/projects/${project.id}/artifact?path=${encodeURIComponent("plans/v2/architecture.md")}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", "x-bf-token": token },
        body: JSON.stringify({ content: "# Architecture V2\n\nSaved cleanly.\n", encoding: "utf8" }),
      },
    );
    expect(mdRes.status).toBe(200);
    const mdBody = (await mdRes.json()) as { ok: boolean; relativePath: string; sizeBytes: number; updatedAt: number };
    expect(mdBody.ok).toBe(true);
    expect(mdBody.relativePath).toBe("plans/v2/architecture.md");
    expect(mdBody.sizeBytes).toBeGreaterThan(10);
    expect(existsSync(join(project.rootPath, "plans/v2/architecture.md"))).toBe(true);
    expect(readFileSync(join(project.rootPath, "plans/v2/architecture.md"), "utf8")).toContain("Architecture V2");

    await syncWs(ws);
    expect(
      previewEvents.some(
        (e) =>
          e.topic === `project:${project.id}:previews` &&
          e.eventType === "artifact.updated" &&
          e.data?.relativePath === "plans/v2/architecture.md" &&
          e.data?.projectId === project.id,
      ),
    ).toBe(true);

    // 3. PNG base64 write with data URL prefix via body path fallback
    const oneByOnePng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const pngRes = await fetch(`${app.url}/api/projects/${project.id}/artifact`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-bf-token": token },
      body: JSON.stringify({
        path: "artifacts/crop.png",
        content: `data:image/png;base64,${oneByOnePng}`,
        encoding: "base64",
      }),
    });
    expect(pngRes.status).toBe(200);
    const pngBody = (await pngRes.json()) as { ok: boolean; relativePath: string; sizeBytes: number };
    expect(pngBody.ok).toBe(true);
    expect(pngBody.relativePath).toBe("artifacts/crop.png");
    const savedPngBytes = readFileSync(join(project.rootPath, "artifacts/crop.png"));
    expect(savedPngBytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // 4. 403 traversal & outside-allowed-folder blocks
    for (const badPath of [
      "../system/secrets.env",
      "plans/../../outside.md",
      "repo/README.md",
      "worktrees/wt-1/note.md",
      "MEMORY.md",
    ]) {
      const res = await fetch(
        `${app.url}/api/projects/${project.id}/artifact?path=${encodeURIComponent(badPath)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json", "x-bf-token": token },
          body: JSON.stringify({ content: "blocked", encoding: "utf8" }),
        },
      );
      expect(res.status).toBe(403);
    }

    // 5. 415 disallowed extension
    for (const badExtPath of ["artifacts/tool.exe", "artifacts/script.ts", "plans/page.html"]) {
      const res = await fetch(
        `${app.url}/api/projects/${project.id}/artifact?path=${encodeURIComponent(badExtPath)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json", "x-bf-token": token },
          body: JSON.stringify({ content: "disallowed", encoding: "utf8" }),
        },
      );
      expect(res.status).toBe(415);
    }

    // 6. Verify config.example.json parses cleanly and includes factory-droid-acp
    const exampleCfg = HubConfigSchema.parse(
      JSON.parse(readFileSync(resolve(import.meta.dir, "../config.example.json"), "utf8")),
    );
    const droid = exampleCfg.providers["factory-droid-acp"];
    expect(droid).toBeTruthy();
    expect(droid?.runtime).toBe("acp_stdio");
    expect(droid?.command).toBe("droid");
    expect(droid?.args).toEqual(["exec", "-o", "acp"]);
    expect(droid?.models["gpt-6.1-sol"]?.id).toBe("gpt-6.1-sol");

    ws.close();
  });
});
