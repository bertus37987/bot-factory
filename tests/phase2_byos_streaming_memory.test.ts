import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubConfig } from "@bot-factory/shared";
import { loadHubConfig, saveHubConfig, SecretScrubber } from "../apps/daemon/src/config";
import { startBotFactoryDaemon, type BotFactoryApp } from "../apps/daemon/src/index";
import { CliStreamRuntime } from "../apps/daemon/src/runtimes/cliStreamRuntime";
import { NativeHttpRuntime } from "../apps/daemon/src/runtimes/nativeHttpRuntime";
import type { NormalizedAgentEvent } from "../apps/daemon/src/runtimes/types";

const tempDirs: string[] = [];
const runningApps: BotFactoryApp[] = [];
const mockServers: Array<ReturnType<typeof Bun.serve>> = [];
const runtimesToClose: Array<{ shutdownAllSync(): void }> = [];
const savedEnv = new Map<string, string | undefined>();

function rememberEnv(key: string): void {
  if (!savedEnv.has(key)) {
    savedEnv.set(key, process.env[key]);
  }
}

function makeTempRoot(prefix = "bf-p2-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function openAuthedWs(url: string, token: string): WebSocket {
  return new WebSocket(url, { headers: { "x-bf-token": token } } as unknown as string[]);
}

function waitForWsEvent(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 6000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("ws_wait_timeout"));
    }, timeoutMs);
    const handler = (ev: MessageEvent) => {
      const parsed = JSON.parse(String(ev.data));
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(parsed);
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitUntil_timeout");
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
    runningApps.pop()!.stop();
  }
  while (runtimesToClose.length > 0) {
    runtimesToClose.pop()!.shutdownAllSync();
  }
  while (mockServers.length > 0) {
    mockServers.pop()!.stop(true);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows handle release delay
    }
  }
});

describe("Phase 2 — Open BYOS Native HTTP SSE, CliStreamRuntime, Interactive ACP Permissions & Active Memory", () => {
  it("streams SSE and executes multi-step tool calls across openai_compatible, google_gemini (x-goog-api-key), and anthropic", async () => {
    rememberEnv("BOT_FACTORY_OFFLINE_MOCK");
    delete process.env.BOT_FACTORY_OFFLINE_MOCK;

    const seenHeaders: Array<{ path: string; xGoogApiKey: string | null; xApiKey: string | null; auth: string | null }> = [];
    const seenGeminiBodies: Array<Record<string, unknown>> = [];
    let openaiStep = 0;
    let geminiStep = 0;
    let anthropicStep = 0;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        seenHeaders.push({
          path: url.pathname + url.search,
          xGoogApiKey: req.headers.get("x-goog-api-key"),
          xApiKey: req.headers.get("x-api-key"),
          auth: req.headers.get("authorization"),
        });

        if (url.pathname === "/openai/chat/completions") {
          openaiStep++;
          const body = (await req.json()) as { messages: Array<{ role: string; content: unknown }>; reasoning_effort?: string };
          const encoder = new TextEncoder();
          if (openaiStep === 1) {
            expect(body.reasoning_effort).toBe("high");
            const sse = [
              `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Planning OpenAI lookup. " } }] })}\n\n`,
              `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_oai_1", type: "function", function: { name: "lookup_port", arguments: '{"svc":' } }] } }] })}\n\n`,
              `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hub"}' } }] } }] })}\n\n`,
              `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 25 } })}\n\n`,
              "data: [DONE]\n\n",
            ].join("");
            return new Response(encoder.encode(sse), { headers: { "content-type": "text/event-stream" } });
          }
          const toolMsg = body.messages.find((m) => m.role === "tool");
          expect(String(toolMsg?.content ?? "")).toContain("4310");
          const sse = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: "OpenAI port " } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: "is 4310." } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 140, completion_tokens: 12 } })}\n\n`,
            "data: [DONE]\n\n",
          ].join("");
          return new Response(encoder.encode(sse), { headers: { "content-type": "text/event-stream" } });
        }

        if (url.pathname === "/gemini/models/gemini-byos:streamGenerateContent") {
          geminiStep++;
          const body = (await req.json()) as Record<string, unknown>;
          seenGeminiBodies.push(body);
          const encoder = new TextEncoder();
          if (geminiStep === 1) {
            const sse = [
              `data: ${JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [
                        { thought: true, text: "Inspecting Gemini tool. " },
                        { functionCall: { id: "gcall_1", name: "lookup_port", args: { svc: "gemini" } } },
                      ],
                    },
                  },
                ],
                usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 10, thoughtsTokenCount: 8 },
              })}\n\n`,
              "data: [DONE]\n\n",
            ].join("");
            return new Response(encoder.encode(sse), { headers: { "content-type": "text/event-stream" } });
          }
          const sse = [
            `data: ${JSON.stringify({
              candidates: [{ content: { parts: [{ text: "Gemini SSE tool done." }] } }],
              usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 9 },
            })}\n\n`,
            "data: [DONE]\n\n",
          ].join("");
          return new Response(encoder.encode(sse), { headers: { "content-type": "text/event-stream" } });
        }

        if (url.pathname === "/gemini/models/text-embedding-004:embedContent") {
          return Response.json({ embedding: { values: [3, 4, 0] } });
        }

        if (url.pathname === "/anthropic/v1/messages") {
          anthropicStep++;
          const body = (await req.json()) as { thinking?: { type: string; budget_tokens: number }; messages: Array<{ role: string; content: unknown }> };
          const encoder = new TextEncoder();
          if (anthropicStep === 1) {
            expect(body.thinking?.type).toBe("enabled");
            const sse = [
              `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 75, output_tokens: 5 } } })}\n\n`,
              `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } })}\n\n`,
              `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Thinking in Claude." } })}\n\n`,
              `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "lookup_port" } })}\n\n`,
              `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"svc":"anthropic"}' } })}\n\n`,
              `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 22 } })}\n\n`,
            ].join("");
            return new Response(encoder.encode(sse), { headers: { "content-type": "text/event-stream" } });
          }
          const sse = [
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 110, output_tokens: 4 } } })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Anthropic SSE multi-step done." } })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 16 } })}\n\n`,
          ].join("");
          return new Response(encoder.encode(sse), { headers: { "content-type": "text/event-stream" } });
        }

        return new Response("Not Found", { status: 404 });
      },
    });
    mockServers.push(server);

    const rootDir = makeTempRoot();
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const cfg = makeBaseTestConfig(rootDir, {
      "byos-openai": {
        runtime: "native_http",
        protocol: "openai_compatible",
        baseUrl: `${baseUrl}/openai`,
        apiKeyEnv: "BYOS_OAI_KEY",
        models: { custom: { id: "gpt-byos", capabilities: ["coding"], tier: "flagship" } },
      },
      "byos-gemini": {
        runtime: "native_http",
        protocol: "google_gemini",
        baseUrl: `${baseUrl}/gemini`,
        apiKeyEnv: "BYOS_GEM_KEY",
        embeddingModel: "text-embedding-004",
        models: { custom: { id: "gemini-byos", capabilities: ["reasoning"], tier: "flagship" } },
      },
      "byos-anthropic": {
        runtime: "native_http",
        protocol: "anthropic",
        baseUrl: `${baseUrl}/anthropic`,
        apiKeyEnv: "BYOS_ANT_KEY",
        models: { custom: { id: "claude-byos", capabilities: ["coding"], tier: "flagship" } },
      },
    });
    const secrets = {
      BYOS_OAI_KEY: "test-oai-secret-value-1234",
      BYOS_GEM_KEY: "test-gem-secret-value-1234",
      BYOS_ANT_KEY: "test-ant-secret-value-1234",
    };
    const scrubber = new SecretScrubber(secrets);
    const runtime = new NativeHttpRuntime(cfg, secrets, scrubber);
    runtimesToClose.push(runtime);

    const tools = [
      {
        name: "lookup_port",
        description: "Look up configured service port",
        parametersJsonSchema: { type: "object", properties: { svc: { type: "string" } }, required: ["svc"] },
      },
    ];
    const onToolCall = async (call: { id: string; name: string; args: Record<string, unknown> }) => ({
      service: call.args.svc,
      port: 4310,
    });

    const collectTurn = async (provider: string): Promise<NormalizedAgentEvent[]> => {
      const h = await runtime.startSession({
        agentId: `ag_${provider}`,
        sessionId: `ses_${provider}`,
        provider,
        model: "custom",
        cwd: rootDir,
        systemPrompt: "You are a BYOS test agent.",
        reasoningEffort: "high",
      });
      const events: NormalizedAgentEvent[] = [];
      for await (const ev of runtime.sendTurn(h, { userText: "Check port", history: [], tools, onToolCall })) {
        events.push(ev);
      }
      await runtime.closeSession(h);
      return events;
    };

    const oaiEvents = await collectTurn("byos-openai");
    expect(oaiEvents.some((e) => e.type === "thought" && e.text.includes("Planning OpenAI"))).toBe(true);
    expect(oaiEvents.some((e) => e.type === "tool_result" && e.output.includes("4310"))).toBe(true);
    expect(oaiEvents.find((e) => e.type === "done")).toEqual({ type: "done", finalText: "OpenAI port is 4310." });

    const gemEvents = await collectTurn("byos-gemini");
    expect(gemEvents.some((e) => e.type === "thought" && e.text.includes("Inspecting Gemini"))).toBe(true);
    expect(gemEvents.some((e) => e.type === "tool_result" && e.output.includes("4310"))).toBe(true);
    expect(gemEvents.find((e) => e.type === "done")).toEqual({ type: "done", finalText: "Gemini SSE tool done." });
    expect((seenGeminiBodies[0]?.generationConfig as { thinkingConfig?: { thinkingBudget?: number } })?.thinkingConfig?.thinkingBudget).toBe(16384);

    const geminiEmb = await runtime.embedText("byos-gemini", "text-embedding-004", "normalize me");
    expect(geminiEmb).not.toBeNull();
    expect(geminiEmb![0]).toBeCloseTo(0.6, 4);
    expect(geminiEmb![1]).toBeCloseTo(0.8, 4);

    const antEvents = await collectTurn("byos-anthropic");
    expect(antEvents.some((e) => e.type === "thought" && e.text.includes("Thinking in Claude"))).toBe(true);
    expect(antEvents.some((e) => e.type === "tool_result" && e.output.includes("4310"))).toBe(true);
    expect(antEvents.find((e) => e.type === "done")).toEqual({
      type: "done",
      finalText: "Anthropic SSE multi-step done.",
    });

    const gemReq = seenHeaders.filter((h) => h.path.startsWith("/gemini/"));
    expect(gemReq.length).toBeGreaterThanOrEqual(3);
    for (const h of gemReq) {
      expect(h.xGoogApiKey).toBe(secrets.BYOS_GEM_KEY);
      expect(h.path).not.toContain(secrets.BYOS_GEM_KEY);
    }
    const antReq = seenHeaders.filter((h) => h.path.startsWith("/anthropic/"));
    expect(antReq.every((h) => h.xApiKey === secrets.BYOS_ANT_KEY)).toBe(true);
    const oaiReq = seenHeaders.filter((h) => h.path.startsWith("/openai/"));
    expect(oaiReq.every((h) => h.auth === `Bearer ${secrets.BYOS_OAI_KEY}`)).toBe(true);
  });

  it("runs CliStreamRuntime synthetic claude & codex NDJSON adapters and wires cli_stream into OrchestrationEngine", async () => {
    const rootDir = makeTempRoot();
    const claudeMockPath = join(rootDir, "mock-claude.ts");
    const codexMockPath = join(rootDir, "mock-codex.ts");

    writeFileSync(
      claudeMockPath,
      `const args = process.argv.slice(2);
const hasEffort = args.includes("--effort");
const effVal = hasEffort ? args[args.indexOf("--effort") + 1] : "none";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "claude_ses_42" }) + "\\n");
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const prompt = typeof msg.message?.content === "string" ? msg.message.content : "turn";
    process.stdout.write(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Claude thought effort=" + effVal } } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tc_c1", name: "Edit", input: { file_path: "README.md" } }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tc_c1", content: "edited README.md" }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Claude OK: " + prompt.slice(0, 40) } } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", is_error: false, usage: { input_tokens: 45, output_tokens: 15 } }) + "\\n");
  }
});`,
      "utf8",
    );

    writeFileSync(
      codexMockPath,
      `const args = process.argv.slice(2);
const isResume = args.includes("resume");
let stdinData = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdinData += d));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex_thr_77" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "Codex thinking resume=" + isResume } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.started", item: { id: "cmd1", type: "command_execution", command: "bun test" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "cmd1", type: "command_execution", command: "bun test", exit_code: 0, aggregated_output: "all passed" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "Codex reply resume=" + isResume + " len=" + stdinData.trim().length } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 30, output_tokens: 11 } }) + "\\n");
});`,
      "utf8",
    );

    // 1. Direct CliStreamRuntime unit lifecycle for both adapters
    const cfg = makeBaseTestConfig(rootDir, {
      "claude-cli": {
        runtime: "cli_stream",
        adapter: "claude",
        command: "bun",
        args: ["run", claudeMockPath],
        models: { sonnet: { id: "claude-sonnet-4-5", capabilities: ["coding"], tier: "flagship" } },
      },
      "codex-cli": {
        runtime: "cli_stream",
        adapter: "codex",
        command: "bun",
        args: ["run", codexMockPath],
        models: { codex: { id: "gpt-5-codex", capabilities: ["coding"], tier: "flagship" } },
      },
    });
    const cliRt = new CliStreamRuntime(cfg, join(rootDir, "system", "logs"), {}, new SecretScrubber({}));
    runtimesToClose.push(cliRt);

    const codexH = await cliRt.startSession({
      agentId: "bot_codex",
      sessionId: "ses_codex_1",
      provider: "codex-cli",
      model: "codex",
      cwd: rootDir,
      systemPrompt: "You are codex test.",
      reasoningEffort: "max",
      autonomyLevel: "high",
    });

    const codexTurn1: NormalizedAgentEvent[] = [];
    for await (const ev of cliRt.sendTurn(codexH, { userText: "First codex turn", history: [] })) {
      codexTurn1.push(ev);
    }
    expect(codexTurn1.some((e) => e.type === "thought" && e.text.includes("resume=false"))).toBe(true);
    expect(codexTurn1.some((e) => e.type === "tool_result" && e.output.includes("all passed"))).toBe(true);
    expect(codexTurn1.find((e) => e.type === "done")?.type).toBe("done");

    const codexTurn2: NormalizedAgentEvent[] = [];
    for await (const ev of cliRt.sendTurn(codexH, { userText: "Second codex turn", history: [] })) {
      codexTurn2.push(ev);
    }
    expect(codexTurn2.some((e) => e.type === "thought" && e.text.includes("resume=true"))).toBe(true);
    await cliRt.closeSession(codexH);

    // 2. Full OrchestrationEngine wiring via config.json + cliStreamRuntime
    rememberEnv("BOT_FACTORY_OFFLINE_MOCK");
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";
    saveHubConfig(join(rootDir, "system", "config.json"), cfg);
    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    const token = readFileSync(join(rootDir, "system", ".daemon-token"), "utf8").trim();
    const ws = openAuthedWs(app.url.replace("http://", "ws://") + "/ws", token);
    await new Promise<void>((res) => (ws.onopen = () => res()));
    const wsEvents: Array<{ topic: string; eventType?: string; data?: any }> = [];
    ws.addEventListener("message", (ev) => {
      const parsed = JSON.parse(String(ev.data));
      if (parsed.kind === "event") wsEvents.push(parsed);
    });

    const proj = (
      app.engine.executeCommand({
        commandId: "cli_proj_1",
        type: "project.create",
        name: "CLI Stream Project",
        seedDemoArtifacts: false,
      }) as { project: { id: string } }
    ).project;

    const bot = (
      app.engine.executeCommand({
        commandId: "cli_bot_1",
        type: "bot.spawn",
        projectId: proj.id,
        name: "Claude-Worker",
        scope: "peer",
        provider: "claude-cli",
        model: "sonnet",
        reasoningEffort: "high",
        autonomyLevel: "medium",
      }) as { agent: { id: string; activeSessionId: string } }
    ).agent;

    const tlSnapP = waitForWsEvent(ws, (m) => m.kind === "snapshot" && m.topic === `bot:${bot.id}:timeline`);
    ws.send(JSON.stringify({ kind: "subscribe", topic: `bot:${bot.id}:timeline` }));
    await tlSnapP;

    const task = (
      app.engine.executeCommand({
        commandId: "cli_tsk_1",
        type: "task.create",
        projectId: proj.id,
        title: "Run Claude CLI worker",
        specMd: "Stream output via claude adapter",
        priority: 1,
      }) as { task: { id: string } }
    ).task;

    app.engine.executeCommand({
      commandId: "cli_disp_1",
      type: "task.dispatch",
      projectId: proj.id,
      taskId: task.id,
      agentId: bot.id,
    });
    await app.core.drainOutboxOnce();

    expect(app.db.getTask(task.id)!.status).toBe("in_review");
    expect(app.db.getSessionTokenTotal(bot.activeSessionId)).toBe(60);
    await waitUntil(() => wsEvents.some((e) => e.eventType === "tool.result"));
    expect(wsEvents.some((e) => e.eventType === "timeline.delta" && e.data?.kind === "thought")).toBe(true);
    expect(wsEvents.some((e) => e.eventType === "timeline.delta" && e.data?.kind === "text_delta")).toBe(true);
    expect(wsEvents.some((e) => e.eventType === "tool.result" && e.data?.output?.includes("edited README.md"))).toBe(true);

    ws.close();
  });

  it("suspends on bidirectional ACP session/request_permission and resolves Allow/Deny via permission.respond over WS", async () => {
    rememberEnv("BOT_FACTORY_OFFLINE_MOCK");
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";

    const rootDir = makeTempRoot();
    const acpMockPath = join(rootDir, "mock-acp-perm.ts");
    writeFileSync(
      acpMockPath,
      `let buf = "";
let nextReqId = 500;
let activePromptId = null;
let activeSessionId = "acp_ext_perm_1";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
    } else if (msg.method === "session/new") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: activeSessionId } }) + "\\n");
    } else if (msg.method === "session/prompt") {
      activePromptId = msg.id;
      const permReqId = nextReqId++;
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: permReqId,
        method: "session/request_permission",
        params: {
          toolCall: { toolCallId: "tc_del_1", kind: "delete", title: "Delete obsolete artifact", locations: [{ path: "old.txt" }] },
          options: [
            { optionId: "allow_once_opt", kind: "allow_once" },
            { optionId: "allow_always_opt", kind: "allow_always" },
            { optionId: "deny_opt", kind: "reject_once" }
          ]
        }
      }) + "\\n");
    } else if (msg.id !== undefined && msg.method === undefined) {
      const outcome = msg.result?.outcome;
      const text = outcome?.outcome === "selected" ? "Permitted:" + outcome.optionId : "Denied:cancelled";
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text }] } }
      }) + "\\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: activePromptId, result: { stopReason: "end_turn" } }) + "\\n");
    }
  }
});`,
      "utf8",
    );

    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);
    const token = readFileSync(join(rootDir, "system", ".daemon-token"), "utf8").trim();
    const ws = openAuthedWs(app.url.replace("http://", "ws://") + "/ws", token);
    await new Promise<void>((res) => (ws.onopen = () => res()));

    const sendWsCommand = async <T = any>(payload: Record<string, unknown>): Promise<T> => {
      const commandId = `ws_${crypto.randomUUID().slice(0, 8)}`;
      const ackP = waitForWsEvent(ws, (m) => m.kind === "ack" && m.commandId === commandId);
      ws.send(JSON.stringify({ kind: "command", payload: { ...payload, commandId } }));
      const ack = await ackP;
      if (!ack.ok) throw new Error(ack.error);
      return ack.result as T;
    };

    const gSnapP = waitForWsEvent(ws, (m) => m.kind === "snapshot" && m.topic === "global:status");
    ws.send(JSON.stringify({ kind: "subscribe", topic: "global:status" }));
    await gSnapP;

    // Hot-update devin-acp command via config.update RPC
    await sendWsCommand({
      type: "config.update",
      patchJson: JSON.stringify({
        providers: {
          "devin-acp": {
            command: "bun",
            args: ["run", acpMockPath],
          },
        },
      }),
    });

    const { project } = await sendWsCommand({
      type: "project.create",
      name: "ACP Perm Project",
      seedDemoArtifacts: false,
    });

    const { agent: acpBot } = await sendWsCommand({
      type: "bot.spawn",
      projectId: project.id,
      name: "ACP-Perm-Bot",
      scope: "peer",
      provider: "devin-acp",
      model: "swe-2-max",
      autonomyLevel: "medium",
    });

    const botSnapP = waitForWsEvent(ws, (m) => m.kind === "snapshot" && m.topic === `bot:${acpBot.id}:timeline`);
    ws.send(JSON.stringify({ kind: "subscribe", topic: `bot:${acpBot.id}:timeline` }));
    await botSnapP;

    // Turn 1: Allow once
    const { task: task1 } = await sendWsCommand({
      type: "task.create",
      projectId: project.id,
      title: "Delete file with approval",
      specMd: "Ask permission and proceed on allow",
      priority: 1,
    });

    const permReqGlobalP = waitForWsEvent(ws, (m) => m.kind === "event" && m.topic === "global:status" && m.eventType === "permission.requested");
    const permReqBotP = waitForWsEvent(ws, (m) => m.kind === "event" && m.topic === `bot:${acpBot.id}:timeline` && m.eventType === "permission.requested");
    await sendWsCommand({ type: "task.dispatch", projectId: project.id, taskId: task1.id, agentId: acpBot.id });

    const [permGlobal, permBot] = await Promise.all([permReqGlobalP, permReqBotP]);
    expect(permGlobal.data.id).toBe(permBot.data.id);
    expect(app.db.getAgent(acpBot.id)!.status).toBe("requires_action");

    const quiet = app.engine.getQuietStatusProjection();
    expect(quiet.pendingPermissionsCount).toBe(1);
    expect(quiet.pendingPermissions?.[0]?.id).toBe(permGlobal.data.id);
    expect(quiet.inboxNotices.some((n) => n.level === "action" && n.message.includes("Delete obsolete artifact"))).toBe(true);

    const permResolvedP = waitForWsEvent(ws, (m) => m.kind === "event" && m.topic === "global:status" && m.eventType === "permission.resolved");
    await sendWsCommand({
      type: "permission.respond",
      permissionId: permGlobal.data.id,
      decision: "allow_once",
    });
    const resolvedEvt = await permResolvedP;
    expect(resolvedEvt.data.decision).toBe("allow_once");

    await app.core.drainOutboxOnce();
    expect(app.db.getTask(task1.id)!.status).toBe("in_review");
    expect(app.db.listAgentTimeline(acpBot.id).some((m) => m.content.includes("Permitted:allow_once_opt"))).toBe(true);

    // Return bot from waiting_review to idle via bot.resume, then test Deny
    await sendWsCommand({ type: "bot.resume", agentId: acpBot.id });
    expect(app.db.getAgent(acpBot.id)!.status).toBe("idle");

    const { task: task2 } = await sendWsCommand({
      type: "task.create",
      projectId: project.id,
      title: "Delete file with denial",
      specMd: "Ask permission and handle deny",
      priority: 1,
    });
    const permReq2P = waitForWsEvent(ws, (m) => m.kind === "event" && m.topic === "global:status" && m.eventType === "permission.requested");
    await sendWsCommand({ type: "task.dispatch", projectId: project.id, taskId: task2.id, agentId: acpBot.id });
    const permReq2 = await permReq2P;

    await sendWsCommand({
      type: "permission.respond",
      permissionId: permReq2.data.id,
      decision: "deny",
    });
    await app.core.drainOutboxOnce();
    expect(app.db.listAgentTimeline(acpBot.id).some((m) => m.content.includes("Denied:cancelled"))).toBe(true);

    ws.close();
  });

  it("wires active memory (chat:meta auto-ingest, LLM DreamExtractor, hybridSearch, L1 CRUD, auto-compaction, bot.resume, and selfmod config hot-reload)", async () => {
    rememberEnv("BOT_FACTORY_OFFLINE_MOCK");
    delete process.env.BOT_FACTORY_OFFLINE_MOCK;

    const capturedPrompts: Array<{ system: string; user: string }> = [];
    let chatCallCount = 0;

    const mockServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/v1/embeddings") {
          const body = (await req.json()) as { input: string };
          const isWal = body.input.toLowerCase().includes("wal") || body.input.toLowerCase().includes("outbox");
          return Response.json({ data: [{ embedding: isWal ? [0.9, 0.1, 0] : [0.1, 0.9, 0] }] });
        }
        if (url.pathname === "/v1/chat/completions") {
          const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
          const sys = body.messages.find((m) => m.role === "system")?.content ?? "";
          const usr = body.messages[body.messages.length - 1]?.content ?? "";
          const encoder = new TextEncoder();

          if (sys.includes("Supermemory Consolidation Engine")) {
            const dreamJson = JSON.stringify({
              newFacts: [
                {
                  entity: "architecture",
                  factText: "Hub persistence relies on SQLite WAL and outbox effects.",
                  kind: "decision",
                  isStatic: true,
                },
              ],
            });
            const sse = [
              `data: ${JSON.stringify({ choices: [{ delta: { content: dreamJson } }] })}\n\n`,
              "data: [DONE]\n\n",
            ].join("");
            return new Response(encoder.encode(sse), { headers: { "content-type": "text/event-stream" } });
          }

          if (sys.includes("independent Bot Factory self-modification verifier")) {
            const sse = [
              `data: ${JSON.stringify({ choices: [{ delta: { content: "Verified safe config patch.\nVERDICT: PASS" } }] })}\n\n`,
              "data: [DONE]\n\n",
            ].join("");
            return new Response(encoder.encode(sse), { headers: { "content-type": "text/event-stream" } });
          }

          chatCallCount++;
          capturedPrompts.push({ system: sys, user: usr });
          const reply = chatCallCount === 1 ? "Understood, SQLite WAL is noted." : "Recalled project and WAL architecture.";
          const usage = chatCallCount === 1 ? { prompt_tokens: 2800, completion_tokens: 1400 } : { prompt_tokens: 200, completion_tokens: 40 };
          const sse = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [], usage })}\n\n`,
            "data: [DONE]\n\n",
          ].join("");
          return new Response(encoder.encode(sse), { headers: { "content-type": "text/event-stream" } });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    mockServers.push(mockServer);

    const rootDir = makeTempRoot();
    const baseCfg = makeBaseTestConfig(rootDir, {
      "mock-llm": {
        runtime: "native_http",
        protocol: "openai_compatible",
        baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
        embeddingModel: "embed-v1",
        models: {
          smart: { id: "mock-smart", capabilities: ["reasoning", "review"], tier: "flagship" },
        },
      },
    });
    baseCfg.routing.defaultsByIntent.meta_orchestrator = { provider: "mock-llm", model: "smart" };
    baseCfg.routing.defaultsByIntent.memory_dreaming = { provider: "mock-llm", model: "smart" };
    baseCfg.routing.defaultsByIntent.verifier_default = { provider: "mock-llm", model: "smart" };
    baseCfg.memory.dreaming.mode = "instant";
    baseCfg.memory.embeddings = { provider: "mock-llm", model: "embed-v1" };
    baseCfg.guardrails.autoCompactThresholdTokens = 4000;
    saveHubConfig(join(rootDir, "system", "config.json"), baseCfg);

    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    const token = readFileSync(join(rootDir, "system", ".daemon-token"), "utf8").trim();
    const ws = openAuthedWs(app.url.replace("http://", "ws://") + "/ws", token);
    await new Promise<void>((res) => (ws.onopen = () => res()));
    const chatEvents: Array<{ topic: string; eventType?: string; data?: any }> = [];
    ws.addEventListener("message", (ev) => {
      const parsed = JSON.parse(String(ev.data));
      if (parsed.kind === "event" && parsed.topic === "chat:meta") chatEvents.push(parsed);
    });
    const snapP = waitForWsEvent(ws, (m) => m.kind === "snapshot" && m.topic === "chat:meta");
    ws.send(JSON.stringify({ kind: "subscribe", topic: "chat:meta" }));
    await snapP;

    // Create a project and test L1 memory get/update
    const { project } = app.engine.executeCommand({
      commandId: "mem_proj_1",
      type: "project.create",
      name: "Active Memory Lab",
      seedDemoArtifacts: false,
    }) as { project: { id: string; slug: string } };

    const updatedGlobalL1 = app.engine.executeCommand({
      commandId: "mem_l1_upd_g",
      type: "memory.l1.update",
      target: "global",
      content: "# Global Memory\n- Prefer clean Bun TypeScript services.",
    }) as { usedChars: number; content: string };
    expect(updatedGlobalL1.content).toContain("Prefer clean Bun");

    const readProjL1 = app.engine.executeCommand({
      commandId: "mem_l1_get_p",
      type: "memory.l1.get",
      target: "project",
      projectId: project.id,
    }) as { content: string; gaugeHeader: string };
    expect(readProjL1.content).toContain("Project Memory");
    expect(readProjL1.gaugeHeader).toContain("chars]");

    // Turn 1: chat.send triggers chat.delta, auto-ingest -> LLM DreamExtractor + embeddings, and auto-compaction!
    app.engine.executeCommand({
      commandId: "mem_chat_1",
      type: "chat.send",
      text: "Remember that hub persistence uses SQLite WAL and outbox effects.",
      projectId: project.id,
      reasoningEffort: "medium",
      autonomyLevel: "medium",
    });
    await app.core.drainOutboxOnce();

    // Check streaming delta on chat:meta
    await waitUntil(() => chatEvents.some((e) => e.eventType === "chat.delta"));
    expect(chatEvents.some((e) => e.eventType === "chat.delta" && e.data?.text?.includes("SQLite WAL"))).toBe(true);

    // Check auto-ingest + DreamExtractor + vector embeddings + hybridSearch
    const hybrid = await app.memory.hybridSearch("global", "SQLite WAL outbox", 5);
    expect(hybrid.usedEmbeddings).toBe(true);
    expect(hybrid.facts.some((f) => f.factText.includes("SQLite WAL"))).toBe(true);

    // Check auto-compaction refreshed systemPrompt & bumped generation to 2
    const meta = app.db.getAgent(app.engine.metaAgentId)!;
    const sessionAfterCompact = app.db.getSession(meta.activeSessionId!)!;
    expect(sessionAfterCompact.generation).toBe(2);
    expect(sessionAfterCompact.tokenIn).toBe(0);
    expect(sessionAfterCompact.tokenOut).toBe(0);
    expect(sessionAfterCompact.systemPrompt).toContain("SQLite WAL");
    expect(sessionAfterCompact.systemPrompt).toContain("Prefer clean Bun");

    // Turn 2: verify recallForTurn + chat.send.projectId summary appear in outgoing ephemeral context
    app.engine.executeCommand({
      commandId: "mem_chat_2",
      type: "chat.send",
      text: "What persistence model does our hub use?",
      projectId: project.id,
    });
    await app.core.drainOutboxOnce();

    expect(capturedPrompts.length).toBe(2);
    expect(capturedPrompts[1]!.user).toContain(`<active_project_context id="${project.id}"`);
    expect(capturedPrompts[1]!.user).toContain("<ephemeral_memory_recall");
    expect(capturedPrompts[1]!.user).toContain("SQLite WAL");

    // Test routing.set_override, bot.stop + bot.resume, checkpoint.list/rollback, task.merge guard, project.archive, inbox.dismiss
    const overrideRes = app.engine.executeCommand({
      commandId: "mem_route_1",
      type: "routing.set_override",
      projectId: project.id,
      intent: "coding_parallel",
      target: { provider: "mock-llm", model: "smart" },
    }) as { project: { routingOverrides: Record<string, unknown> } };
    expect(overrideRes.project.routingOverrides.coding_parallel).toEqual({ provider: "mock-llm", model: "smart" });

    const peer = (
      app.engine.executeCommand({
        commandId: "mem_peer_1",
        type: "bot.spawn",
        projectId: project.id,
        name: "Resume-Worker",
        scope: "peer",
      }) as { agent: { id: string; activeSessionId: string; worktreePath: string } }
    ).agent;

    // Dispatch a task to create a checkpoint, mutate worktree, then roll back via checkpoint.rollback
    const cpTask = (
      app.engine.executeCommand({
        commandId: "mem_cp_task",
        type: "task.create",
        projectId: project.id,
        title: "Checkpoint task",
        specMd: "Produce checkpoint",
        priority: 1,
      }) as { task: { id: string } }
    ).task;
    app.engine.executeCommand({
      commandId: "mem_cp_disp",
      type: "task.dispatch",
      projectId: project.id,
      taskId: cpTask.id,
      agentId: peer.id,
    });
    await app.core.drainOutboxOnce();

    const cpList = app.engine.executeCommand({
      commandId: "mem_cp_list",
      type: "checkpoint.list",
      projectId: project.id,
      agentId: peer.id,
    }) as { checkpoints: Array<{ id: string }> };
    expect(cpList.checkpoints.length).toBeGreaterThanOrEqual(1);
    const dirtyFile = join(peer.worktreePath, "unwanted-dirty.txt");
    writeFileSync(dirtyFile, "should disappear on rollback", "utf8");
    app.engine.executeCommand({
      commandId: "mem_cp_rb",
      type: "checkpoint.rollback",
      projectId: project.id,
      checkpointId: cpList.checkpoints[0]!.id,
    });
    await app.core.drainOutboxOnce();
    expect(readFileSync(join(peer.worktreePath, `.bf-task-${cpTask.id}.md`), "utf8")).toContain("Checkpoint task");
    expect(existsSync(dirtyFile)).toBe(false);

    app.engine.executeCommand({ commandId: "mem_stop_1", type: "bot.stop", agentId: peer.id });
    await app.core.drainOutboxOnce();
    expect(app.db.getAgent(peer.id)!.status).toBe("stopped");

    const resumed = app.engine.executeCommand({
      commandId: "mem_resume_1",
      type: "bot.resume",
      agentId: peer.id,
    }) as { status: string; sessionId: string };
    expect(resumed.status).toBe("idle");
    expect(resumed.sessionId).not.toBe(peer.activeSessionId);

    const tMerge = (
      app.engine.executeCommand({
        commandId: "mem_t_create",
        type: "task.create",
        projectId: project.id,
        title: "Guard check",
        specMd: "Test task.merge guard",
        priority: 2,
      }) as { task: { id: string } }
    ).task;
    expect(() =>
      app.engine.executeCommand({
        commandId: "mem_t_merge_early",
        type: "task.merge",
        projectId: project.id,
        taskId: tMerge.id,
        strategy: "squash",
      }),
    ).toThrow("task_not_verified:ready");

    app.db.runAtomicWrite(() => app.db.upsertTask({ ...app.db.getTask(tMerge.id)!, status: "verified" }));
    expect(() =>
      app.engine.executeCommand({
        commandId: "mem_t_merge_stub",
        type: "task.merge",
        projectId: project.id,
        taskId: tMerge.id,
        strategy: "squash",
      }),
    ).toThrow("task_merge_phase3_pending");

    const notice = app.engine.getQuietStatusProjection().inboxNotices[0];
    if (notice) {
      const dismissed = app.engine.executeCommand({
        commandId: "mem_dismiss_1",
        type: "inbox.dismiss",
        noticeId: notice.id,
      }) as { dismissed: boolean };
      expect(dismissed.dismissed).toBe(true);
      expect(app.engine.getQuietStatusProjection().inboxNotices.some((n) => n.id === notice.id)).toBe(false);
    }

    const archived = app.engine.executeCommand({
      commandId: "mem_archive_1",
      type: "project.archive",
      projectId: project.id,
      status: "archived",
    }) as { project: { status: string } };
    expect(archived.project.status).toBe("archived");

    // Self-mod config_patch promote hot-reloads config in-memory (providers & guardrails)
    const stagedCfg = (
      app.engine.executeCommand({
        commandId: "mem_smod_cfg",
        type: "selfmod.propose",
        kind: "config_patch",
        targetId: "config",
        title: "Hot reload new provider + debate cap",
        rationale: "Verify reloadConfig on selfmod.promote",
        content: JSON.stringify({
          guardrails: { maxDebateRounds: 5 },
          providers: {
            "hot-added": {
              runtime: "native_http",
              protocol: "openai_compatible",
              baseUrl: "https://api.example.com/v1",
              models: { "hot-1": { id: "hot-1", capabilities: ["coding"], tier: "fast" } },
            },
          },
        }),
        autoVerify: true,
      }) as { proposal: { id: string } }
    ).proposal;
    await app.core.drainOutboxOnce();
    expect(app.db.getSelfModProposal(stagedCfg.id)!.status).toBe("verified");

    app.engine.executeCommand({
      commandId: "mem_smod_promote",
      type: "selfmod.promote",
      proposalId: stagedCfg.id,
    });
    const snapAfterPromote = app.engine.getGlobalSnapshot();
    expect(snapAfterPromote.providers.some((p) => p.name === "hot-added")).toBe(true);

    // Promoted plugin block is injected into buildFrozenSystemPrompt for new sessions
    const stagedPlug = (
      app.engine.executeCommand({
        commandId: "mem_smod_plug",
        type: "selfmod.propose",
        kind: "plugin",
        targetId: "p2-plugin-check",
        title: "Inject active plugin block",
        rationale: "Verify plugin prompt injection",
        content: "# Active Plugin Rule\nAlways prefer deterministic checks.",
        autoVerify: true,
      }) as { proposal: { id: string } }
    ).proposal;
    await app.core.drainOutboxOnce();
    app.engine.executeCommand({ commandId: "mem_smod_plug_promote", type: "selfmod.promote", proposalId: stagedPlug.id });

    const plugBot = (
      app.engine.executeCommand({
        commandId: "mem_bot_plug",
        type: "bot.spawn",
        projectId: project.id,
        name: "Plugin-Aware-Bot",
        scope: "peer",
      }) as { agent: { activeSessionId: string } }
    ).agent;
    expect(app.db.getSession(plugBot.activeSessionId)!.systemPrompt).toContain("Always prefer deterministic checks.");

    ws.close();
  });
});
