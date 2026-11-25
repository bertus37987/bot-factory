import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type HubConfig, type TaskRecord, type VerificationReportRecord } from "@bot-factory/shared";
import { loadHubConfig, saveHubConfig, SecretScrubber } from "../apps/daemon/src/config";
import { CommandCore } from "../apps/daemon/src/core/commandCore";
import { StateDatabase } from "../apps/daemon/src/db/database";
import { createSubagentWorktree, extractAndApplySubagentPatch } from "../apps/daemon/src/git/worktrees";
import { startBotFactoryDaemon, type BotFactoryApp } from "../apps/daemon/src/index";
import { computeMcpFetchTimeoutMs, DEFAULT_SUBAGENT_WAIT_MS } from "../apps/daemon/src/mcp/mcpBridge";
import { LocalSuperHermesMemory } from "../apps/daemon/src/memory/memoryEngine";
import { appendRetryFeedback, AutonomyLoop } from "../apps/daemon/src/orchestration/autonomyLoop";
import { SubagentManager } from "../apps/daemon/src/orchestration/subagentManager";
import { AcpSubprocessRuntime } from "../apps/daemon/src/runtimes/acpSubprocessRuntime";
import { CliStreamRuntime } from "../apps/daemon/src/runtimes/cliStreamRuntime";
import {
  boundToolOutputForContext,
  buildAnthropicMessages,
  buildGeminiContents,
  buildOpenAiMessages,
  NativeHttpRuntime,
  stableStringify,
} from "../apps/daemon/src/runtimes/nativeHttpRuntime";
import { ModelRouter } from "../apps/daemon/src/runtimes/router";
import type { NormalizedAgentEvent } from "../apps/daemon/src/runtimes/types";
import { IndependentVerifier } from "../apps/daemon/src/phase3/verifier";

const tempDirs: string[] = [];
const openDbs: StateDatabase[] = [];
const runningApps: BotFactoryApp[] = [];
const mockServers: Array<ReturnType<typeof Bun.serve>> = [];
const runtimesToClose: Array<{ shutdownAllSync(): void }> = [];
const savedEnv = new Map<string, string | undefined>();

function rememberEnv(key: string): void {
  if (!savedEnv.has(key)) {
    savedEnv.set(key, process.env[key]);
  }
}

function makeTempDir(prefix = "bf-hu-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runGitSync(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Bot Test",
      GIT_AUTHOR_EMAIL: "test@bot-factory.local",
      GIT_COMMITTER_NAME: "Bot Test",
      GIT_COMMITTER_EMAIL: "test@bot-factory.local",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${proc.exitCode}): ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

function initTempGitRepo(rootDir: string): string {
  const repoDir = join(rootDir, "repo");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
  writeFileSync(join(repoDir, "src", "index.ts"), "export const ok = true;\n", "utf8");
  runGitSync(["init", "-b", "main"], repoDir);
  runGitSync(["config", "user.email", "test@bot-factory.local"], repoDir);
  runGitSync(["config", "user.name", "Bot Test"], repoDir);
  runGitSync(["add", "-A"], repoDir);
  runGitSync(["commit", "-m", "initial commit"], repoDir);
  return repoDir;
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
  for (const [k, v] of savedEnv.entries()) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
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
  while (openDbs.length > 0) {
    try {
      openDbs.pop()!.close();
    } catch {
      // ignore close error
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows handle delay
    }
  }
});

describe("Wave 2 Harness & Multi-Agent Upgrades", () => {
  it("keeps conversation & compaction history intact across 12+ tool calls in listActiveSessionMessages", () => {
    const rootDir = makeTempDir();
    const db = new StateDatabase(join(rootDir, "state.db"));
    openDbs.push(db);

    const projectId = newId("prj");
    const agentId = newId("agt");
    const sessionId = newId("ses");
    const now = Date.now();
    db.insertProject({
      id: projectId,
      name: "History Lab",
      slug: "history-lab",
      rootPath: rootDir,
      repoPath: rootDir,
      routingOverrides: {},
      verifyChecks: [],
      status: "active",
      createdAt: now,
    });
    db.upsertAgent({
      id: agentId,
      projectId,
      parentAgentId: null,
      scope: "peer",
      name: "Builder-Hist",
      runtimeType: "native_http",
      provider: "mock",
      model: "smart",
      status: "idle",
      worktreePath: rootDir,
      worktreeBranch: "main",
      pid: null,
      activeSessionId: sessionId,
      lastSummary: "",
      updatedAt: now,
    });
    db.createSession({
      id: sessionId,
      agentId,
      parentSessionId: null,
      systemPrompt: "sys",
      systemPromptHash: "hash1",
      generation: 2,
      tokenIn: 0,
      tokenOut: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    // Compaction summary + 4 conversation messages
    db.appendMessage({
      id: newId("msg"),
      agentId,
      sessionId,
      seq: 0,
      kind: "status",
      role: "system",
      title: "Compaction Gen #2",
      content: "Prior context: implement auth safely.",
      createdAt: now + 1,
    });
    for (let i = 0; i < 4; i++) {
      db.appendMessage({
        id: newId("msg"),
        agentId,
        sessionId,
        seq: 0,
        kind: "message",
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Conversation turn ${i}`,
        createdAt: now + 2 + i,
      });
    }

    // 15 tool_calls (30 raw rows if appended directly, or 15 upserted rows)
    for (let t = 0; t < 15; t++) {
      const tcId = `tc_${t}`;
      db.upsertToolCallMessage({
        id: newId("msg"),
        agentId,
        sessionId,
        seq: 0,
        kind: "tool_call",
        role: "tool",
        title: `read_file(${t})`,
        content: `reading ${t}`,
        toolCallId: tcId,
        toolStatus: "in_progress",
        createdAt: now + 20 + t * 2,
      });
      db.upsertToolCallMessage({
        id: newId("msg"),
        agentId,
        sessionId,
        seq: 0,
        kind: "tool_call",
        role: "tool",
        title: "read_file",
        content: `result ${t}`,
        toolCallId: tcId,
        toolStatus: "completed",
        exitCode: 0,
        createdAt: now + 21 + t * 2,
      });
    }
    // Also inject 14 extra raw tool_call rows to verify SQL filtering before LIMIT 24
    for (let t = 0; t < 14; t++) {
      db.appendMessage({
        id: newId("msg"),
        agentId,
        sessionId,
        seq: 0,
        kind: "tool_call",
        role: "tool",
        title: `raw_tool_${t}`,
        content: `raw output ${t}`,
        toolCallId: `raw_${t}`,
        toolStatus: "completed",
        createdAt: now + 100 + t,
      });
    }

    const activeHistory = db.listActiveSessionMessages(sessionId, 24);
    expect(activeHistory.length).toBe(5);
    expect(activeHistory[0]!.title).toBe("Compaction Gen #2");
    expect(activeHistory.slice(1).map((m) => m.content)).toEqual([
      "Conversation turn 0",
      "Conversation turn 1",
      "Conversation turn 2",
      "Conversation turn 3",
    ]);

    // Timeline still shows tool_calls for UI without duplicate in_progress rows from upsertToolCallMessage
    const timeline = db.listAgentTimeline(agentId, 100);
    const upsertedCompleted = timeline.filter((m) => m.toolCallId === "tc_0");
    expect(upsertedCompleted.length).toBe(1);
    expect(upsertedCompleted[0]!.toolStatus).toBe("completed");
  });

  it("maps Compaction Gen #N system summaries into Gemini, Anthropic, and OpenAI payloads without dropping them", async () => {
    rememberEnv("BOT_FACTORY_OFFLINE_MOCK");
    delete process.env.BOT_FACTORY_OFFLINE_MOCK;

    const history = [
      { role: "system" as const, content: "Compacted 14 messages: MUST keep SQLite WAL invariant." },
      { role: "user" as const, content: "How should we persist state?" },
      { role: "assistant" as const, content: "Via SQLite WAL." },
    ];

    const gemContents = buildGeminiContents(history, "Confirm the invariant.");
    expect(gemContents.some((c) => c.role === "user" && JSON.stringify(c.parts).includes("SQLite WAL invariant"))).toBe(true);
    expect(gemContents[0]!.role).toBe("user");
    expect(gemContents[1]!.role).toBe("model");

    const antMsgs = buildAnthropicMessages(history, "Confirm the invariant.");
    expect(antMsgs[0]!.role).toBe("user");
    expect(String(antMsgs[0]!.content)).toContain("SQLite WAL invariant");
    expect(antMsgs[1]!.role).toBe("assistant");

    const oaiMsgs = buildOpenAiMessages("Frozen System", history, "Confirm the invariant.");
    expect(oaiMsgs[0]!.role).toBe("system");
    expect(oaiMsgs.slice(1).some((m) => m.role === "user" && String(m.content).includes("SQLite WAL invariant"))).toBe(true);

    // Live mock HTTP verification for Gemini + Anthropic prompt cache & compaction preservation
    let seenGeminiBody: Record<string, unknown> | null = null;
    let seenAnthropicBody: Record<string, unknown> | null = null;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.includes(":streamGenerateContent")) {
          seenGeminiBody = (await req.json()) as Record<string, unknown>;
          return Response.json({
            candidates: [{ content: { parts: [{ text: "Gemini kept compaction." }] } }],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 },
          });
        }
        if (url.pathname.endsWith("/v1/messages")) {
          seenAnthropicBody = (await req.json()) as Record<string, unknown>;
          return Response.json({
            content: [{ type: "text", text: "Anthropic kept compaction." }],
            usage: { input_tokens: 20, output_tokens: 5 },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    mockServers.push(server);

    const rootDir = makeTempDir();
    const cfg = makeBaseTestConfig(rootDir, {
      "test-gem": {
        runtime: "native_http",
        protocol: "google_gemini",
        baseUrl: `http://127.0.0.1:${server.port}/gemini`,
        apiKeyEnv: "GEM_KEY",
        models: { flash: { id: "gemini-2.5-flash", capabilities: ["coding"], tier: "fast" } },
      },
      "test-ant": {
        runtime: "native_http",
        protocol: "anthropic",
        baseUrl: `http://127.0.0.1:${server.port}/anthropic`,
        apiKeyEnv: "ANT_KEY",
        models: { sonnet: { id: "claude-sonnet", capabilities: ["coding"], tier: "flagship" } },
      },
    });
    const secrets = { GEM_KEY: "gem-secret", ANT_KEY: "ant-secret" };
    const rt = new NativeHttpRuntime(cfg, secrets, new SecretScrubber(secrets));
    runtimesToClose.push(rt);

    const gemH = await rt.startSession({
      agentId: "ag_gem",
      sessionId: "ses_gem",
      provider: "test-gem",
      model: "flash",
      cwd: rootDir,
      systemPrompt: "Sys Gem",
    });
    const gemEvents: NormalizedAgentEvent[] = [];
    for await (const ev of rt.sendTurn(gemH, { userText: "Continue", history })) {
      gemEvents.push(ev);
    }
    expect(gemEvents.find((e) => e.type === "done")).toEqual({ type: "done", finalText: "Gemini kept compaction." });
    expect(JSON.stringify(seenGeminiBody)).toContain("SQLite WAL invariant");

    const antH = await rt.startSession({
      agentId: "ag_ant",
      sessionId: "ses_ant",
      provider: "test-ant",
      model: "sonnet",
      cwd: rootDir,
      systemPrompt: "Sys Ant",
    });
    const antEvents: NormalizedAgentEvent[] = [];
    for await (const ev of rt.sendTurn(antH, {
      userText: "Continue",
      history,
      tools: [
        { name: "ping", description: "Ping", parametersJsonSchema: { type: "object", properties: {} } },
      ],
      onToolCall: async () => ({ ok: true }),
    })) {
      antEvents.push(ev);
    }
    expect(antEvents.find((e) => e.type === "done")).toEqual({ type: "done", finalText: "Anthropic kept compaction." });
    expect(JSON.stringify(seenAnthropicBody)).toContain("SQLite WAL invariant");
    const antSys = (seenAnthropicBody as { system?: Array<{ cache_control?: { type: string } }> } | null)?.system;
    expect(antSys?.[0]?.cache_control).toEqual({ type: "ephemeral" });
    const antTools = (seenAnthropicBody as { tools?: Array<{ cache_control?: { type: string } }> } | null)?.tools;
    expect(antTools?.[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("trips doom-loop breaker on 3 identical tool calls, passes final tool_choice none, bounds oversized tool output, and joins multi-step text", async () => {
    rememberEnv("BOT_FACTORY_OFFLINE_MOCK");
    delete process.env.BOT_FACTORY_OFFLINE_MOCK;

    // Verify canonical stableStringify and head+tail truncation directly
    expect(stableStringify({ b: 2, a: { y: 9, x: 1 } })).toBe(stableStringify({ a: { x: 1, y: 9 }, b: 2 }));
    const bigText = `HEAD_SENTINEL_${"A".repeat(20_000)}_TAIL_SENTINEL`;
    const bounded = boundToolOutputForContext(bigText, 12_000);
    expect(bounded.length).toBeLessThanOrEqual(12_000);
    expect(bounded).toContain("HEAD_SENTINEL_");
    expect(bounded).toContain("_TAIL_SENTINEL");
    expect(bounded).toContain("truncated");

    const seenOaiBodies: Array<{ tools?: unknown[]; tool_choice?: unknown; messages: Array<Record<string, unknown>> }> = [];
    const seenAntBodies: Array<{ tools?: unknown[]; tool_choice?: unknown; messages: Array<Record<string, unknown>> }> = [];
    let oaiStep = 0;
    let antStep = 0;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/openai/chat/completions") {
          oaiStep += 1;
          const body = (await req.json()) as {
            tools?: unknown[];
            tool_choice?: unknown;
            messages: Array<Record<string, unknown>>;
          };
          seenOaiBodies.push(body);
          if (oaiStep === 1) {
            return Response.json({
              choices: [
                {
                  message: {
                    content: "Step 1 intro.",
                    tool_calls: [{ id: "c1", function: { name: "dump_big", arguments: '{"b":2,"a":1}' } }],
                  },
                },
              ],
            });
          }
          if (oaiStep === 2) {
            return Response.json({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [{ id: "c2", function: { name: "dump_big", arguments: '{"a":1,"b":2}' } }],
                  },
                },
              ],
            });
          }
          if (oaiStep === 3) {
            // 3rd identical canonical call -> should trip circuit breaker before executing tool!
            return Response.json({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [{ id: "c3", function: { name: "dump_big", arguments: '{"a":1,"b":2}' } }],
                  },
                },
              ],
            });
          }
          return Response.json({
            choices: [{ message: { content: "Stopped loop and summarized." } }],
          });
        }

        if (url.pathname === "/anthropic/v1/messages") {
          antStep += 1;
          const body = (await req.json()) as {
            tools?: unknown[];
            tool_choice?: unknown;
            messages: Array<Record<string, unknown>>;
          };
          seenAntBodies.push(body);
          if (antStep <= 2) {
            // Emit empty unsigned thinking block + tool_use to verify empty thinking is dropped on step 2
            return Response.json({
              content: [
                { type: "thinking", thinking: "" },
                { type: "text", text: antStep === 1 ? "Checking once." : "Checking twice." },
                { type: "tool_use", id: `ant_tc_${antStep}`, name: "always_same", input: { key: "same" } },
              ],
            });
          }
          if (antStep === 3) {
            return Response.json({
              content: [{ type: "tool_use", id: "ant_tc_3", name: "always_same", input: { key: "same" } }],
            });
          }
          return Response.json({
            content: [{ type: "text", text: "Anthropic wrapped up." }],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    mockServers.push(server);

    const rootDir = makeTempDir();
    const cfg = makeBaseTestConfig(rootDir, {
      "loop-oai": {
        runtime: "native_http",
        protocol: "openai_compatible",
        baseUrl: `http://127.0.0.1:${server.port}/openai`,
        apiKeyEnv: "OAI_KEY",
        models: { gpt: { id: "gpt-loop", capabilities: ["coding"], tier: "flagship" } },
      },
      "loop-ant": {
        runtime: "native_http",
        protocol: "anthropic",
        baseUrl: `http://127.0.0.1:${server.port}/anthropic`,
        apiKeyEnv: "ANT_KEY",
        models: { claude: { id: "claude-loop", capabilities: ["coding"], tier: "flagship" } },
      },
    });
    const secrets = { OAI_KEY: "oai-sec", ANT_KEY: "ant-sec" };
    const rt = new NativeHttpRuntime(cfg, secrets, new SecretScrubber(secrets));
    runtimesToClose.push(rt);

    let oaiExecCount = 0;
    const oaiH = await rt.startSession({
      agentId: "ag_oai_loop",
      sessionId: "ses_oai_loop",
      provider: "loop-oai",
      model: "gpt",
      cwd: rootDir,
      systemPrompt: "Loop guard test",
    });
    const oaiEvents: NormalizedAgentEvent[] = [];
    for await (const ev of rt.sendTurn(oaiH, {
      userText: "Run dump",
      history: [],
      maxToolSteps: 10,
      tools: [{ name: "dump_big", description: "Dump", parametersJsonSchema: { type: "object", properties: {} } }],
      onToolCall: async () => {
        oaiExecCount += 1;
        return bigText;
      },
    })) {
      oaiEvents.push(ev);
    }

    // 3rd identical call is blocked BEFORE executing onToolCall, then 4th request gets tool_choice: "none" and exits
    expect(oaiExecCount).toBe(2);
    expect(oaiStep).toBe(4);
    const finalOaiReq = seenOaiBodies[3]!;
    expect(Array.isArray(finalOaiReq.tools)).toBe(true);
    expect(finalOaiReq.tool_choice).toBe("none");

    // Verify oversized tool output sent to LLM context was capped <= 12,000 chars while preserving head & tail
    const toolContentInStep2 = String(seenOaiBodies[1]!.messages.find((m) => m.role === "tool")?.content ?? "");
    expect(toolContentInStep2.length).toBeLessThanOrEqual(12_000);
    expect(toolContentInStep2).toContain("HEAD_SENTINEL_");
    expect(toolContentInStep2).toContain("_TAIL_SENTINEL");

    // Verify step 3 tripped tool_result includes Loop Breaker reflection and multi-step text joined with \n\n
    const breakerMsg = String(finalOaiReq.messages[finalOaiReq.messages.length - 1]?.content ?? "");
    expect(breakerMsg).toContain("[Loop Breaker]");
    const oaiDone = oaiEvents.find((e) => e.type === "done") as { type: "done"; finalText: string };
    expect(oaiDone.finalText).toBe("Step 1 intro.\n\nStopped loop and summarized.");

    // Anthropic: empty unsigned thinking block dropped, tool_choice: { type: "none" } on final wrap-up, \n\n join
    let antExecCount = 0;
    const antH = await rt.startSession({
      agentId: "ag_ant_loop",
      sessionId: "ses_ant_loop",
      provider: "loop-ant",
      model: "claude",
      cwd: rootDir,
      systemPrompt: "Ant loop guard",
      reasoningEffort: "high",
    });
    const antEvents: NormalizedAgentEvent[] = [];
    for await (const ev of rt.sendTurn(antH, {
      userText: "Run always_same",
      history: [],
      maxToolSteps: 10,
      tools: [{ name: "always_same", description: "Same", parametersJsonSchema: { type: "object", properties: {} } }],
      onToolCall: async () => {
        antExecCount += 1;
        return { ok: true };
      },
    })) {
      antEvents.push(ev);
    }
    expect(antExecCount).toBe(2);
    expect(antStep).toBe(4);
    const step2AssistantBlocks = seenAntBodies[1]!.messages.find((m) => m.role === "assistant")?.content as Array<{
      type: string;
    }>;
    expect(step2AssistantBlocks.some((b) => b.type === "thinking")).toBe(false);
    expect(seenAntBodies[3]!.tools).toBeTruthy();
    expect(seenAntBodies[3]!.tool_choice).toEqual({ type: "none" });
    const antDone = antEvents.find((e) => e.type === "done") as { type: "done"; finalText: string };
    expect(antDone.finalText).toBe("Checking once.\n\nChecking twice.\n\nAnthropic wrapped up.");
  });

  it("preserves specMd head in appendRetryFeedback, merges committed+uncommitted worktree diffs, keeps 800-char failure tail, and advances parallel DAG branches", async () => {
    // 1. appendRetryFeedback preserves original specMd head & newest retry diagnostics
    const originalHead = `# CRITICAL SPEC HEADER\nMust implement foo() and bar().\n${"Requirement detail line.\n".repeat(250)}`;
    const retry1 = appendRetryFeedback(originalHead, 1, `Attempt 1 error: ${"E".repeat(4500)}`);
    expect(retry1.startsWith("# CRITICAL SPEC HEADER")).toBe(true);
    expect(retry1).toContain("Attempt 1");

    const retry2 = appendRetryFeedback(retry1, 2, `Attempt 2 error: TAIL_FAIL_MARKER_999`);
    expect(retry2.length).toBeLessThanOrEqual(12_000);
    expect(retry2.startsWith("# CRITICAL SPEC HEADER")).toBe(true);
    expect(retry2).toContain("## Verifier Retry Feedback (Attempt 2)");
    expect(retry2).toContain("TAIL_FAIL_MARKER_999");

    // 2. Verifier branch diff + 800-char failure tail + AutonomyLoop retry & parallel DAG advancement
    rememberEnv("BOT_FACTORY_OFFLINE_MOCK");
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";

    const rootDir = makeTempDir();
    const repoDir = initTempGitRepo(rootDir);
    const wtDir = join(rootDir, "worktrees", "wt-author");
    mkdirSync(join(rootDir, "worktrees"), { recursive: true });
    runGitSync(["worktree", "add", "-b", "bf/author-1", wtDir, "HEAD"], repoDir);

    // Committed file on author branch + uncommitted file in worktree
    writeFileSync(join(wtDir, "src", "committed_feature.ts"), "export const committed = 1;\n", "utf8");
    runGitSync(["add", "src/committed_feature.ts"], wtDir);
    runGitSync(["commit", "-m", "commit feature on branch"], wtDir);
    writeFileSync(join(wtDir, "src", "uncommitted_note.txt"), "wip note\n", "utf8");

    mkdirSync(join(rootDir, "handoffs"), { recursive: true });
    const handoffRel = "handoffs/tsk_1.md";
    writeFileSync(join(rootDir, handoffRel), "# Handoff\n\n## Changed Files\n- `src/committed_feature.ts`\n", "utf8");

    const db = new StateDatabase(join(rootDir, "state.db"));
    openDbs.push(db);
    const loaded = loadHubConfig({ rootDir, port: 0 });
    const scrubber = new SecretScrubber({});
    const core = new CommandCore(db);
    const router = new ModelRouter(loaded.config);
    const memory = new LocalSuperHermesMemory(db, loaded.config, join(rootDir, "memory"), scrubber);
    const nativeRt = new NativeHttpRuntime(loaded.config, {}, scrubber);
    const acpRt = new AcpSubprocessRuntime(loaded.config, join(rootDir, "logs"), scrubber);
    runtimesToClose.push(nativeRt, acpRt);

    const now = Date.now();
    const projectId = newId("prj");
    const authorId = newId("agt");
    const taskId = "tsk_verify_1";

    // Failing check whose error tail is past char 400 (must NOT be chopped at 200 chars!)
    const scriptCheckCmd = `bun -e "console.error('${"X".repeat(350)}__IMPORTANT_TAIL_ERROR_CODE_42__'); process.exit(1)"`;

    const project = {
      id: projectId,
      name: "Verifier Upgrade",
      slug: "verifier-upgrade",
      rootPath: rootDir,
      repoPath: repoDir,
      routingOverrides: {},
      status: "active" as const,
      verifyChecks: [{ name: "custom_fail_tail", cmd: scriptCheckCmd, timeoutMs: 10_000 }],
      createdAt: now,
    };
    db.insertProject(project);
    db.upsertAgent({
      id: authorId,
      projectId,
      parentAgentId: null,
      scope: "peer",
      name: "Author-1",
      runtimeType: "native_http",
      provider: "openai",
      model: "gpt-5",
      status: "waiting_review",
      worktreePath: wtDir,
      worktreeBranch: "bf/author-1",
      pid: null,
      activeSessionId: null,
      lastSummary: "",
      updatedAt: now,
    });
    const task: TaskRecord = {
      id: taskId,
      projectId,
      parentTaskId: null,
      title: "Feature + Check Tail",
      specMd: "ORIGINAL_TASK_SPEC_HEAD",
      status: "in_review",
      priority: 1,
      assignedAgentId: authorId,
      sourceAnnotationId: null,
      worktreeBranch: "bf/author-1",
      handoffPath: handoffRel,
      retryCount: 0,
      dependsOn: [],
      autoRetryCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    db.upsertTask(task);

    const verifier = new IndependentVerifier(loaded, db, memory, router, nativeRt, acpRt, scrubber);
    const report = await verifier.verifyTask({ project, task });

    expect(report.verdict).toBe("fail");
    const wtCheck = report.checks.find((c) => c.name === "worktree_evidence")!;
    expect(wtCheck.passed).toBe(true);
    // Committed branch file AND uncommitted worktree file BOTH visible!
    expect(wtCheck.detail).toContain("src/committed_feature.ts");
    expect(wtCheck.detail).toContain("src/uncommitted_note.txt");

    // Failed check tail preserved past 200 chars
    expect(report.findings.some((f) => f.includes("__IMPORTANT_TAIL_ERROR_CODE_42__"))).toBe(true);

    // 3. AutonomyLoop: retry preserves specMd head + full check diagnostics, and sibling DAG branches advance on exhaustion
    const dispatchedTasks: string[] = [];
    const peer2Id = newId("agt");
    db.upsertAgent({
      id: peer2Id,
      projectId,
      parentAgentId: null,
      scope: "peer",
      name: "Peer-2",
      runtimeType: "native_http",
      provider: "openai",
      model: "gpt-5",
      status: "idle",
      worktreePath: null,
      worktreeBranch: null,
      pid: null,
      activeSessionId: null,
      lastSummary: "",
      updatedAt: now,
    });

    const taskBId = "tsk_branch_b";
    const taskCId = "tsk_branch_c";
    db.upsertTask({
      id: taskBId,
      projectId,
      parentTaskId: null,
      title: "Branch B Root",
      specMd: "B spec",
      status: "in_review",
      priority: 1,
      assignedAgentId: peer2Id,
      sourceAnnotationId: null,
      worktreeBranch: null,
      handoffPath: null,
      retryCount: 0,
      dependsOn: [],
      autoRetryCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    db.upsertTask({
      id: taskCId,
      projectId,
      parentTaskId: null,
      title: "Branch C Dependent",
      specMd: "C spec",
      status: "ready",
      priority: 1,
      assignedAgentId: null,
      sourceAnnotationId: null,
      worktreeBranch: null,
      handoffPath: null,
      retryCount: 0,
      dependsOn: [taskBId],
      autoRetryCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const autonomy = new AutonomyLoop(db, core, scrubber, {
      getConfig: () => loaded.config,
      getQuietStatusProjection: () => ({
        activeProjects: 1,
        runningBots: 0,
        waitingReviews: 0,
        openAnnotations: 0,
        activeDebates: 0,
        stagedSelfMods: 0,
        inboxNotices: [],
      }),
      getProjectBoardSnapshot: () => ({}),
      spawnPeerBot: () => db.getAgent(peer2Id)!,
      dispatchTask: ({ taskId: tid }) => {
        dispatchedTasks.push(tid);
      },
      runAgentTurn: async () => ({ ok: true, text: "ok" }),
      onGoalReportFallback: async () => {},
    });

    const goal = autonomy.startGoal({ projectId, goal: "Parallel DAG test" });
    autonomy.attachTasks(projectId, [taskId, taskBId, taskCId], goal.goalId);

    // Retry attempt 1 receives full check diagnostics & preserves ORIGINAL_TASK_SPEC_HEAD
    autonomy.onVerificationCompleted(projectId, taskId, report);
    const retriedTask = db.getTask(taskId)!;
    expect(retriedTask.autoRetryCount).toBe(1);
    expect(retriedTask.specMd.startsWith("ORIGINAL_TASK_SPEC_HEAD")).toBe(true);
    expect(retriedTask.specMd).toContain("cmd:custom_fail_tail");
    expect(retriedTask.specMd).toContain("__IMPORTANT_TAIL_ERROR_CODE_42__");

    // Exhaust retries on taskId via onPeerTaskFailed -> author slot released to idle!
    db.upsertTask({ ...retriedTask, autoRetryCount: loaded.config.guardrails.maxTaskAutoRetries });
    db.updateAgentStatus(authorId, "error", { lastSummary: "Turn crashed" });
    autonomy.onPeerTaskFailed(projectId, taskId, "Fatal build error");
    expect(db.getAgent(authorId)!.status).toBe("idle");

    // Even though taskId exhausted and goal became blocked, Branch B passing MUST still dispatch Branch C!
    db.upsertTask({ ...db.getTask(taskBId)!, status: "verified" });
    const passReport: VerificationReportRecord = {
      ...report,
      id: newId("vr"),
      targetId: taskBId,
      verdict: "pass",
      checks: [{ name: "handoff_exists", passed: true, detail: "ok" }],
      findings: [],
    };
    autonomy.onVerificationCompleted(projectId, taskBId, passReport);
    expect(dispatchedTasks).toContain(taskCId);
  });

  it("persists and rehydrates autonomous goal DAG state across database restarts", () => {
    const rootDir = makeTempDir();
    const dbPath = join(rootDir, "state.db");
    const cfg = makeBaseTestConfig(rootDir);
    const scrubber = new SecretScrubber({});
    const now = Date.now();
    const projectId = newId("prj");
    const taskAId = newId("tsk");
    const taskBId = newId("tsk");

    const makeLoop = (db: StateDatabase) =>
      new AutonomyLoop(db, new CommandCore(db, 1), scrubber, {
        getConfig: () => cfg,
        getQuietStatusProjection: () => ({
          activeProjects: 0,
          runningBots: 0,
          waitingReviews: 0,
          openAnnotations: 0,
          activeDebates: 0,
          stagedSelfMods: 0,
          inboxNotices: [],
        }),
        getProjectBoardSnapshot: () => ({}),
        spawnPeerBot: () => {
          throw new Error("not_needed");
        },
        dispatchTask: () => {},
        runAgentTurn: async () => ({ ok: true, text: "ok" }),
        onGoalReportFallback: async () => {},
      });

    const firstDb = new StateDatabase(dbPath);
    let goalId = "";
    try {
      firstDb.insertProject({
        id: projectId,
        name: "Restart DAG Lab",
        slug: "restart-dag-lab",
        rootPath: rootDir,
        repoPath: rootDir,
        routingOverrides: {},
        verifyChecks: [],
        status: "active",
        createdAt: now,
      });
      for (const [id, title, deps] of [
        [taskAId, "Restart root", []],
        [taskBId, "Restart dependent", [taskAId]],
      ] as Array<[string, string, string[]]>) {
        firstDb.upsertTask({
          id,
          projectId,
          parentTaskId: null,
          title,
          specMd: `${title} spec`,
          status: "ready",
          priority: 1,
          assignedAgentId: null,
          sourceAnnotationId: null,
          worktreeBranch: null,
          handoffPath: null,
          retryCount: 0,
          dependsOn: deps,
          autoRetryCount: 0,
          createdAt: now,
          updatedAt: now,
        });
      }
      const firstLoop = makeLoop(firstDb);
      const goal = firstLoop.startGoal({ projectId, goal: "Survive restart", autonomyLevel: "high" });
      goalId = goal.goalId;
      firstLoop.attachTasks(projectId, [taskAId, taskBId], goal.goalId);
      expect(firstDb.getTask(taskAId)?.goalId).toBe(goalId);
      expect(firstDb.getTask(taskBId)?.goalId).toBe(goalId);
    } finally {
      firstDb.close();
    }

    const restartedDb = new StateDatabase(dbPath);
    try {
      const restartedLoop = makeLoop(restartedDb);
      const goals = restartedLoop.listGoals(projectId);
      expect(goals).toHaveLength(1);
      expect(goals[0]).toMatchObject({
        goalId,
        projectId,
        goal: "Survive restart",
        status: "active",
      });
      expect(goals[0]?.taskIds).toEqual(expect.arrayContaining([taskAId, taskBId]));
      expect(restartedLoop.isAutonomousTask(taskAId)).toBe(true);
      expect(restartedLoop.isAutonomousTask(taskBId)).toBe(true);
      expect(restartedLoop.getActiveGoalForProject(projectId)?.goalId).toBe(goalId);
    } finally {
      restartedDb.close();
    }
  });

  it("preserves original goal links and resumes independent branches across multiple persisted goals", () => {
    const rootDir = makeTempDir();
    const dbPath = join(rootDir, "state.db");
    const cfg = makeBaseTestConfig(rootDir);
    cfg.guardrails.maxConcurrentBotsPerProject = 1;
    const scrubber = new SecretScrubber({});
    const now = Date.now();
    const projectId = newId("prj");
    const agentId = newId("agt");
    const sessionId = newId("ses");
    const makeTask = (id: string, title: string): TaskRecord => ({
      id,
      projectId,
      parentTaskId: null,
      title,
      specMd: `${title} spec`,
      status: "ready",
      priority: 1,
      assignedAgentId: null,
      sourceAnnotationId: null,
      worktreeBranch: null,
      handoffPath: null,
      retryCount: 0,
      dependsOn: [],
      autoRetryCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const makeLoop = (
      db: StateDatabase,
      dispatchTask: (params: { projectId: string; taskId: string; agentId?: string; autonomous: boolean }) => void = () => {},
    ) =>
      new AutonomyLoop(db, new CommandCore(db, 1), scrubber, {
        getConfig: () => cfg,
        getQuietStatusProjection: () => ({
          activeProjects: 0,
          runningBots: 0,
          waitingReviews: 0,
          openAnnotations: 0,
          activeDebates: 0,
          stagedSelfMods: 0,
          inboxNotices: [],
        }),
        getProjectBoardSnapshot: () => ({}),
        spawnPeerBot: () => {
          throw new Error("capacity_exhausted");
        },
        dispatchTask,
        runAgentTurn: async () => ({ ok: true, text: "ok" }),
        onGoalReportFallback: async () => {},
      });

    const firstDb = new StateDatabase(dbPath);
    let oldGoalId = "";
    let blockedGoalId = "";
    let newerGoalId = "";
    try {
      firstDb.insertProject({
        id: projectId,
        name: "Goal Branch Lab",
        slug: "goal-branch-lab",
        rootPath: rootDir,
        repoPath: rootDir,
        routingOverrides: {},
        verifyChecks: [],
        status: "active",
        createdAt: now,
      });
      firstDb.upsertAgent({
        id: agentId,
        projectId,
        parentAgentId: null,
        scope: "peer",
        name: "Restart-Peer",
        runtimeType: "native_http",
        provider: "mock",
        model: "smart",
        status: "idle",
        worktreePath: rootDir,
        worktreeBranch: "main",
        pid: null,
        activeSessionId: sessionId,
        lastSummary: "",
        updatedAt: now,
      });
      firstDb.createSession({
        id: sessionId,
        agentId,
        parentSessionId: null,
        systemPrompt: "sys",
        systemPromptHash: "hash",
        generation: 1,
        tokenIn: 0,
        tokenOut: 0,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      for (const task of [makeTask("tsk_old", "Old goal branch"), makeTask("tsk_blocked", "Blocked goal independent branch"), makeTask("tsk_new", "New goal branch")]) {
        firstDb.upsertTask(task);
      }

      const loop = makeLoop(firstDb);
      const oldGoal = loop.startGoal({ projectId, goal: "Old goal" });
      oldGoalId = oldGoal.goalId;
      loop.attachTasks(projectId, ["tsk_old"], oldGoalId);
      const blockedGoal = loop.startGoal({ projectId, goal: "Blocked goal with independent branch" });
      blockedGoalId = blockedGoal.goalId;
      loop.attachTasks(projectId, ["tsk_blocked"], blockedGoalId);
      loop.markGoalReported(projectId, "blocked", blockedGoalId);
      const newerGoal = loop.startGoal({ projectId, goal: "Newer goal" });
      newerGoalId = newerGoal.goalId;
      loop.attachTasks(projectId, ["tsk_new"], newerGoalId);

      loop.markTaskAutonomous("tsk_old", projectId);
      expect(firstDb.getTask("tsk_old")?.goalId).toBe(oldGoalId);
      expect(loop.getGoal(oldGoalId)?.taskIds).toContain("tsk_old");
      expect(loop.getGoal(newerGoalId)?.taskIds).not.toContain("tsk_old");
    } finally {
      firstDb.close();
    }

    const restartedDb = new StateDatabase(dbPath);
    try {
      const dispatched: string[] = [];
      const restartedLoop = makeLoop(restartedDb, ({ taskId }) => {
        dispatched.push(taskId);
      });
      expect(restartedLoop.getGoal(blockedGoalId)?.status).toBe("blocked");
      expect(restartedLoop.getGoal(newerGoalId)?.status).toBe("active");
      expect(restartedLoop.resumePersistedGoals()).toBe(3);
      expect(dispatched).toEqual(expect.arrayContaining(["tsk_old", "tsk_blocked", "tsk_new"]));
    } finally {
      restartedDb.close();
    }
  });

  it("does not restart autonomous work on bots with unresolved crash admissions", () => {
    const rootDir = makeTempDir();
    const dbPath = join(rootDir, "state.db");
    const cfg = makeBaseTestConfig(rootDir);
    cfg.guardrails.maxConcurrentBotsPerProject = 1;
    const scrubber = new SecretScrubber({});
    const now = Date.now();
    const projectId = newId("prj");
    const agentId = newId("agt");
    const sessionId = newId("ses");
    const taskId = newId("tsk");

    const db = new StateDatabase(dbPath);
    try {
      db.insertProject({
        id: projectId,
        name: "Crash Admission Lab",
        slug: "crash-admission-lab",
        rootPath: rootDir,
        repoPath: rootDir,
        routingOverrides: {},
        verifyChecks: [],
        status: "active",
        createdAt: now,
      });
      db.upsertAgent({
        id: agentId,
        projectId,
        parentAgentId: null,
        scope: "peer",
        name: "Crash-Blocked-Peer",
        runtimeType: "native_http",
        provider: "mock",
        model: "smart",
        status: "idle",
        worktreePath: rootDir,
        worktreeBranch: "main",
        pid: null,
        activeSessionId: sessionId,
        lastSummary: "",
        updatedAt: now,
      });
      db.createSession({
        id: sessionId,
        agentId,
        parentSessionId: null,
        systemPrompt: "sys",
        systemPromptHash: "hash",
        generation: 1,
        tokenIn: 0,
        tokenOut: 0,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const admission = db.enqueueAdmission(sessionId, "crashed turn", "started");
      db.updateAdmissionStatus(admission.id, "unknown");
      db.upsertTask({
        id: "tsk_crashed_unmerged",
        projectId,
        parentTaskId: null,
        title: "Crashed unmerged task",
        specMd: "spec",
        status: "claimed",
        priority: 1,
        assignedAgentId: agentId,
        sourceAnnotationId: null,
        worktreeBranch: null,
        handoffPath: null,
        retryCount: 0,
        dependsOn: [],
        autoRetryCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      db.upsertTask({
        id: taskId,
        projectId,
        parentTaskId: null,
        title: "Ready after restart",
        specMd: "spec",
        status: "ready",
        priority: 1,
        assignedAgentId: agentId,
        sourceAnnotationId: null,
        worktreeBranch: null,
        handoffPath: null,
        retryCount: 0,
        dependsOn: [],
        autoRetryCount: 0,
        createdAt: now,
        updatedAt: now,
      });

      const dispatched: string[] = [];
      const loop = new AutonomyLoop(db, new CommandCore(db, 1), scrubber, {
        getConfig: () => cfg,
        getQuietStatusProjection: () => ({
          activeProjects: 0,
          runningBots: 0,
          waitingReviews: 0,
          openAnnotations: 0,
          activeDebates: 0,
          stagedSelfMods: 0,
          inboxNotices: [],
        }),
        getProjectBoardSnapshot: () => ({}),
        spawnPeerBot: () => {
          throw new Error("capacity_exhausted");
        },
        dispatchTask: ({ taskId: dispatchedTaskId }) => {
          dispatched.push(dispatchedTaskId);
        },
        runAgentTurn: async () => ({ ok: true, text: "ok" }),
        onGoalReportFallback: async () => {},
      });
      const goal = loop.startGoal({ projectId, goal: "Recover safely" });
      loop.attachTasks(projectId, [taskId], goal.goalId);

      expect(loop.resumePersistedGoals()).toBe(0);
      expect(dispatched).toEqual([]);
      expect(db.getTask(taskId)?.status).toBe("ready");

      db.updateAdmissionStatus(admission.id, "terminal");
      expect(loop.resumePersistedGoals()).toBe(0);
      expect(dispatched).toEqual([]);
      expect(db.getTask(taskId)?.status).toBe("ready");

      const crashedTask = db.getTask("tsk_crashed_unmerged")!;
      db.upsertTask({ ...crashedTask, status: "verified", updatedAt: Date.now() });
      expect(loop.resumePersistedGoals()).toBe(0);
      expect(dispatched).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("enforces symlink & path-escape rejection in extractAndApplySubagentPatch, returns typed SubagentResultEnvelope, and honors 60s MCP wait default", async () => {
    // 1. mcpBridge default 60s wait timeout
    expect(DEFAULT_SUBAGENT_WAIT_MS).toBe(60_000);
    expect(computeMcpFetchTimeoutMs("bf_subagent_wait", { subagentId: "sub_1" })).toBe(65_000);
    expect(computeMcpFetchTimeoutMs("bf_subagent_wait", { subagentId: "sub_1", timeoutMs: 25_000 })).toBe(30_000);
    expect(computeMcpFetchTimeoutMs("bf_subagent_status", {})).toBe(15_000);

    // 2. extractAndApplySubagentPatch symlink mode 120000 rejection & symlink directory escape rejection
    const rootDir = makeTempDir();
    const repoDir = initTempGitRepo(rootDir);
    const parentWt = join(rootDir, "worktrees", "wt-parent");
    mkdirSync(join(rootDir, "worktrees"), { recursive: true });
    runGitSync(["worktree", "add", "-b", "bf/parent", parentWt, "HEAD"], repoDir);

    const sub1 = await createSubagentWorktree({
      projectRoot: rootDir,
      parentWorktreePath: parentWt,
      subagentId: "sub_sym_1",
    });

    // Inject a committed mode 120000 symlink entry directly into the child index, commit, and checkout to worktree
    const targetPathTmp = join(rootDir, "symlink_target.txt");
    writeFileSync(targetPathTmp, "../outside_secret.txt", "utf8");
    const symlinkBlobSha = runGitSync(["hash-object", "-w", targetPathTmp], sub1.worktreePath);
    runGitSync(["update-index", "--add", "--cacheinfo", `120000,${symlinkBlobSha},evil_symlink`], sub1.worktreePath);
    runGitSync(["commit", "-m", "add symlink"], sub1.worktreePath);
    runGitSync(["checkout", "--", "evil_symlink"], sub1.worktreePath);

    const symApply = await extractAndApplySubagentPatch({
      repoPath: repoDir,
      parentWorktreePath: parentWt,
      childWorktreePath: sub1.worktreePath,
      childBranch: sub1.branch,
    });
    expect(symApply.ok).toBe(false);
    expect(symApply.error).toContain("symlink_not_allowed_in_subagent_patch");
    expect(existsSync(join(parentWt, "evil_symlink"))).toBe(false);

    // Also test a parent worktree containing an escaping symlinked directory (skipped if OS disallows symlink creation)
    const outsideDir = join(rootDir, "outside_dir");
    mkdirSync(outsideDir, { recursive: true });
    let symlinkSupported = true;
    try {
      symlinkSync(outsideDir, join(parentWt, "escape_dir"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      symlinkSupported = false;
    }
    if (symlinkSupported) {
      const sub2 = await createSubagentWorktree({
        projectRoot: rootDir,
        parentWorktreePath: parentWt,
        subagentId: "sub_esc_2",
      });
      mkdirSync(join(sub2.worktreePath, "escape_dir"), { recursive: true });
      writeFileSync(join(sub2.worktreePath, "escape_dir", "pwn.txt"), "escape", "utf8");
      const escApply = await extractAndApplySubagentPatch({
        repoPath: repoDir,
        parentWorktreePath: parentWt,
        childWorktreePath: sub2.worktreePath,
        childBranch: sub2.branch,
      });
      expect(escApply.ok).toBe(false);
      expect(escApply.error).toContain("subagent_patch_path_outside_parent_worktree");
      expect(existsSync(join(outsideDir, "pwn.txt"))).toBe(false);
    }

    // 3. SubagentManager typed envelope (success with filesTouched + diffStat, and failure with error)
    const db = new StateDatabase(join(rootDir, "state.db"));
    openDbs.push(db);
    const loaded = loadHubConfig({ rootDir, port: 0 });
    const scrubber = new SecretScrubber({});
    const core = new CommandCore(db);
    const router = new ModelRouter(loaded.config);
    const memory = new LocalSuperHermesMemory(db, loaded.config, join(rootDir, "memory"), scrubber);

    const now = Date.now();
    const projectId = newId("prj");
    const parentId = newId("agt");
    db.insertProject({
      id: projectId,
      name: "Subagent Env",
      slug: "subagent-env",
      rootPath: rootDir,
      repoPath: repoDir,
      routingOverrides: {},
      verifyChecks: [],
      status: "active",
      createdAt: now,
    });
    db.upsertAgent({
      id: parentId,
      projectId,
      parentAgentId: null,
      scope: "peer",
      name: "Parent-Peer",
      runtimeType: "native_http",
      provider: "openai",
      model: "gpt-5",
      status: "working",
      worktreePath: parentWt,
      worktreeBranch: "bf/parent",
      pid: null,
      activeSessionId: null,
      lastSummary: "",
      updatedAt: now,
    });

    let failNextSubTurn = false;
    const manager = new SubagentManager(loaded, db, core, memory, router, scrubber, {
      getQuietStatusProjection: () => ({
        activeProjects: 1,
        runningBots: 1,
        waitingReviews: 0,
        openAnnotations: 0,
        activeDebates: 0,
        stagedSelfMods: 0,
        inboxNotices: [],
      }),
      getProjectBoardSnapshot: () => ({}),
      runAgentTurn: async (agentId) => {
        const sub = db.getAgent(agentId)!;
        if (failNextSubTurn) {
          db.updateAgentStatus(agentId, "error", { lastSummary: "Subagent crashed cleanly" });
          return { ok: false, text: "", error: "simulated_subagent_boom" };
        }
        writeFileSync(join(sub.worktreePath!, "src", "sub_added.ts"), "export const x = 42;\n", "utf8");
        db.appendMessage({
          id: newId("msg"),
          agentId,
          sessionId: sub.activeSessionId!,
          seq: 0,
          kind: "message",
          role: "assistant",
          content: "Created src/sub_added.ts cleanly.",
          createdAt: Date.now(),
        });
        db.updateAgentStatus(agentId, "idle", { lastSummary: "Done" });
        return { ok: true, text: "Created src/sub_added.ts cleanly." };
      },
      abortAndCloseAgentSession: async () => {},
      revokeMcpTokensForAgent: () => {},
    });

    const spawnedOk = await manager.spawnSubagent({
      projectId,
      parentAgentId: parentId,
      name: "Code-Env",
      mode: "code",
      prompt: "Write src/sub_added.ts",
    });
    await manager.executeSubagentTurn({
      projectId,
      parentAgentId: parentId,
      subagentId: spawnedOk.subagent.id,
      prompt: "Write src/sub_added.ts",
    });

    const waitedOk = await manager.waitForSubagent(parentId, spawnedOk.subagent.id, 5000);
    expect(waitedOk.status).toBe("completed");
    expect(waitedOk.timedOut).toBe(false);
    expect(waitedOk.error).toBeNull();
    expect(waitedOk.filesTouched).toContain("src/sub_added.ts");
    expect(waitedOk.diffStat).toBeTruthy();
    expect(waitedOk.latestOutput).toContain("Created src/sub_added.ts");
    expect(waitedOk.summary).toContain("Created src/sub_added.ts");

    const statusOk = manager.getStatus(parentId, spawnedOk.subagent.id) as {
      status: string;
      filesTouched: string[];
    };
    expect(statusOk.status).toBe("completed");
    expect(statusOk.filesTouched).toContain("src/sub_added.ts");

    failNextSubTurn = true;
    const spawnedFail = await manager.spawnSubagent({
      projectId,
      parentAgentId: parentId,
      name: "RO-Fail",
      mode: "readonly",
      prompt: "Fail cleanly",
    });
    await manager.executeSubagentTurn({
      projectId,
      parentAgentId: parentId,
      subagentId: spawnedFail.subagent.id,
      prompt: "Fail cleanly",
    });
    const waitedFail = await manager.waitForSubagent(parentId, spawnedFail.subagent.id, 5000);
    expect(waitedFail.status).toBe("failed");
    expect(waitedFail.error).toContain("simulated_subagent_boom");
    expect(waitedFail.summary).toContain("simulated_subagent_boom");
  });

  it("keeps Codex CLI sessions alive across clean per-turn process exits so Turn 2 uses codex exec resume in Engine", async () => {
    rememberEnv("BOT_FACTORY_OFFLINE_MOCK");
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";

    const rootDir = makeTempDir();
    const codexMockPath = join(rootDir, "mock-codex-multi.ts");
    writeFileSync(
      codexMockPath,
      `const args = process.argv.slice(2);
const isResume = args.includes("resume");
let stdinData = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdinData += d));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex_thread_99" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "Turn reply resume=" + isResume } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 15, output_tokens: 5 } }) + "\\n");
});`,
      "utf8",
    );

    const cfg = makeBaseTestConfig(rootDir, {
      "codex-multi": {
        runtime: "cli_stream",
        adapter: "codex",
        command: "bun",
        args: ["run", codexMockPath],
        models: { codex: { id: "gpt-5-codex", capabilities: ["coding"], tier: "flagship" } },
      },
    });

    // 1. Direct CliStreamRuntime liveness check after clean exit
    const cliRt = new CliStreamRuntime(cfg, join(rootDir, "logs"), {}, new SecretScrubber({}));
    runtimesToClose.push(cliRt);
    const handle = await cliRt.startSession({
      agentId: "bot_codex_live",
      sessionId: "ses_codex_live",
      provider: "codex-multi",
      model: "codex",
      cwd: rootDir,
      systemPrompt: "Sys",
    });

    const t1: NormalizedAgentEvent[] = [];
    for await (const ev of cliRt.sendTurn(handle, { userText: "Turn 1", history: [] })) {
      t1.push(ev);
    }
    expect(t1.find((e) => e.type === "done")).toEqual({ type: "done", finalText: "Turn reply resume=false" });
    // Even immediately after turn.completed AND after subprocess exits, session MUST remain alive!
    expect(cliRt.isSessionAlive(handle.sessionId)).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(cliRt.isSessionAlive(handle.sessionId)).toBe(true);

    const t2: NormalizedAgentEvent[] = [];
    for await (const ev of cliRt.sendTurn(handle, { userText: "Turn 2", history: [] })) {
      t2.push(ev);
    }
    expect(t2.find((e) => e.type === "done")).toEqual({ type: "done", finalText: "Turn reply resume=true" });
    await cliRt.closeSession(handle);

    // 2. Full OrchestrationEngine multi-turn integration check
    const engRoot = makeTempDir();
    const engCfg = makeBaseTestConfig(engRoot, {
      "codex-multi": {
        runtime: "cli_stream",
        adapter: "codex",
        command: "bun",
        args: ["run", codexMockPath],
        models: { codex: { id: "gpt-5-codex", capabilities: ["coding"], tier: "flagship" } },
      },
    });
    saveHubConfig(join(engRoot, "system", "config.json"), engCfg);
    const app = startBotFactoryDaemon({ rootDir: engRoot, port: 0 });
    runningApps.push(app);

    const { project } = app.engine.executeCommand({
      commandId: "hu_prj_1",
      type: "project.create",
      name: "Codex Resume Project",
      seedDemoArtifacts: false,
    }) as { project: { id: string } };

    const { agent } = app.engine.executeCommand({
      commandId: "hu_bot_1",
      type: "bot.spawn",
      projectId: project.id,
      name: "Codex-Multi-Bot",
      scope: "peer",
      provider: "codex-multi",
      model: "codex",
    }) as { agent: { id: string } };

    app.engine.executeCommand({
      commandId: "hu_msg_1",
      type: "bot.message",
      projectId: project.id,
      agentId: agent.id,
      message: "First codex message",
    });
    await app.core.drainOutboxOnce();

    // Wait briefly for Turn 1 subprocess exit to settle before sending Turn 2
    await new Promise((r) => setTimeout(r, 150));

    app.engine.executeCommand({
      commandId: "hu_msg_2",
      type: "bot.message",
      projectId: project.id,
      agentId: agent.id,
      message: "Second codex message",
    });
    await app.core.drainOutboxOnce();

    const timeline = app.db.listAgentTimeline(agent.id, 50);
    const assistantReplies = timeline.filter((m) => m.kind === "message" && m.role === "assistant").map((m) => m.content);
    expect(assistantReplies).toContain("Turn reply resume=false");
    expect(assistantReplies).toContain("Turn reply resume=true");
  });

  it("compacts stale tool outputs older than 3 steps, trips consecutive all-error breaker, enforces per-request HTTP timeout, and cleans up task child subagents", async () => {
    rememberEnv("BOT_FACTORY_OFFLINE_MOCK");
    delete process.env.BOT_FACTORY_OFFLINE_MOCK;

    let staleStep = 0;
    let errStep = 0;
    const seenStaleSteps: Array<Array<Record<string, unknown>>> = [];
    const seenErrSteps: Array<{ tool_choice?: unknown; messages: Array<Record<string, unknown>> }> = [];

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/stale/chat/completions") {
          staleStep += 1;
          const body = (await req.json()) as { messages: Array<Record<string, unknown>> };
          seenStaleSteps.push(body.messages);
          if (staleStep <= 5) {
            return Response.json({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [{ id: `s_${staleStep}`, function: { name: "step_tool", arguments: JSON.stringify({ n: staleStep }) } }],
                  },
                },
              ],
            });
          }
          return Response.json({ choices: [{ message: { content: "Stale check finished." } }] });
        }
        if (url.pathname === "/errloop/chat/completions") {
          errStep += 1;
          const body = (await req.json()) as { tool_choice?: unknown; messages: Array<Record<string, unknown>> };
          seenErrSteps.push(body);
          if (errStep <= 3) {
            return Response.json({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [{ id: `e_${errStep}`, function: { name: "fail_tool", arguments: JSON.stringify({ attempt: errStep }) } }],
                  },
                },
              ],
            });
          }
          return Response.json({ choices: [{ message: { content: "Reported consecutive error blocker." } }] });
        }
        if (url.pathname === "/hang/chat/completions") {
          return new Response(
            new ReadableStream({
              start() {
                // Intentionally never enqueue or close to exercise per-request AbortSignal timeout
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    mockServers.push(server);

    const rootDir = makeTempDir();
    const cfg = makeBaseTestConfig(rootDir, {
      "stale-oai": {
        runtime: "native_http",
        protocol: "openai_compatible",
        baseUrl: `http://127.0.0.1:${server.port}/stale`,
        apiKeyEnv: "K1",
        models: { m: { id: "m-stale", capabilities: ["coding"], tier: "fast" } },
      },
      "err-oai": {
        runtime: "native_http",
        protocol: "openai_compatible",
        baseUrl: `http://127.0.0.1:${server.port}/errloop`,
        apiKeyEnv: "K1",
        models: { m: { id: "m-err", capabilities: ["coding"], tier: "fast" } },
      },
      "hang-oai": {
        runtime: "native_http",
        protocol: "openai_compatible",
        baseUrl: `http://127.0.0.1:${server.port}/hang`,
        apiKeyEnv: "K1",
        models: { m: { id: "m-hang", capabilities: ["coding"], tier: "fast" } },
      },
    });
    const rt = new NativeHttpRuntime(cfg, { K1: "secret" }, new SecretScrubber({ K1: "secret" }), { requestTimeoutMs: 120 });
    runtimesToClose.push(rt);

    // 1. Stale tool output > 3 steps gets compacted in step 5 (currentStep=4, step 0 age=4 > 3)
    const h1 = await rt.startSession({
      agentId: "ag_stale",
      sessionId: "ses_stale",
      provider: "stale-oai",
      model: "m",
      cwd: rootDir,
      systemPrompt: "sys",
    });
    for await (const _ of rt.sendTurn(h1, {
      userText: "Run 5 steps",
      history: [],
      maxToolSteps: 10,
      tools: [{ name: "step_tool", description: "step", parametersJsonSchema: { type: "object", properties: {} } }],
      onToolCall: async ({ args }) => `OUT_${String(args.n)}_${"Z".repeat(900)}`,
    })) {
      // consume
    }
    const step5Msgs = seenStaleSteps[4] ?? [];
    const step1ToolMsg = step5Msgs.find((m) => m.role === "tool" && m.tool_call_id === "s_1");
    expect(String(step1ToolMsg?.content ?? "")).toContain("[compacted tool output from step 1:");

    // 2. 3 consecutive all-error steps with distinct args still trip breaker
    const h2 = await rt.startSession({
      agentId: "ag_err",
      sessionId: "ses_err",
      provider: "err-oai",
      model: "m",
      cwd: rootDir,
      systemPrompt: "sys",
    });
    const errEvents: NormalizedAgentEvent[] = [];
    for await (const ev of rt.sendTurn(h2, {
      userText: "Run failing steps",
      history: [],
      maxToolSteps: 10,
      tools: [{ name: "fail_tool", description: "fail", parametersJsonSchema: { type: "object", properties: {} } }],
      onToolCall: async () => {
        throw new Error("boom");
      },
    })) {
      errEvents.push(ev);
    }
    expect(errStep).toBe(4);
    expect(seenErrSteps[3]?.tool_choice).toBe("none");
    expect(errEvents.find((e) => e.type === "done")).toEqual({
      type: "done",
      finalText: "Reported consecutive error blocker.",
    });

    // 3. Per-request timeout aborts hung SSE stream cleanly
    const h3 = await rt.startSession({
      agentId: "ag_hang",
      sessionId: "ses_hang",
      provider: "hang-oai",
      model: "m",
      cwd: rootDir,
      systemPrompt: "sys",
    });
    const hangEvents: NormalizedAgentEvent[] = [];
    for await (const ev of rt.sendTurn(h3, { userText: "Hang", history: [] })) {
      hangEvents.push(ev);
    }
    expect(hangEvents.some((e) => e.type === "error" && e.message.includes("timed out"))).toBe(true);

    // 4. executePeerTask cleans up child subagents when task completes
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";
    const appRoot = makeTempDir();
    const repoDir = initTempGitRepo(appRoot);
    const app = startBotFactoryDaemon({ rootDir: appRoot, port: 0 });
    runningApps.push(app);
    const { project } = app.engine.executeCommand({
      commandId: "hu_clean_prj",
      type: "project.create",
      name: "Sub Cleanup",
      externalRepoPath: repoDir,
      seedDemoArtifacts: false,
    }) as { project: { id: string } };
    const { agent: peer } = app.engine.executeCommand({
      commandId: "hu_clean_peer",
      type: "bot.spawn",
      projectId: project.id,
      name: "Cleanup-Peer",
      scope: "peer",
    }) as { agent: { id: string } };
    const { task } = app.engine.executeCommand({
      commandId: "hu_clean_tsk",
      type: "task.create",
      projectId: project.id,
      title: "Task with leftover subagent",
      specMd: "Complete work",
      priority: 2,
    }) as { task: { id: string } };

    app.engine.executeCommand({
      commandId: "hu_clean_disp",
      type: "task.dispatch",
      projectId: project.id,
      taskId: task.id,
      agentId: peer.id,
    });
    // Spawn a sidekick owned by peer right before draining task.run -> executePeerTask must clean it up on finish!
    const spawnedSidekick = await app.engine.handleMcpToolCall("bf_subagent_spawn", {
      projectId: project.id,
      agentId: peer.id,
      args: { name: "Leftover-Scout", mode: "readonly", prompt: "Quick look" },
    }) as { subagent?: { id: string } };
    expect(spawnedSidekick.subagent?.id).toBeTruthy();
    await app.core.drainOutboxOnce();

    const sidekickAfter = app.db.getAgent(spawnedSidekick.subagent?.id ?? "");
    expect(sidekickAfter?.status).toBe("stopped");
  });
});
