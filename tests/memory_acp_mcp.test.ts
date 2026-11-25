import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHubConfig, SecretScrubber } from "../apps/daemon/src/config";
import { StateDatabase } from "../apps/daemon/src/db/database";
import { handleMcpJsonRpcRequest, MCP_TOOLS } from "../apps/daemon/src/mcp/mcpBridge";
import { LocalSuperHermesMemory, type DreamOpBatch } from "../apps/daemon/src/memory/memoryEngine";
import { AcpSubprocessRuntime, resolveAcpPermission, type AcpPermissionOption } from "../apps/daemon/src/runtimes/acpSubprocessRuntime";
import { ModelRouter } from "../apps/daemon/src/runtimes/router";

const tempDirs: string[] = [];
const openDbs: StateDatabase[] = [];
const openMemories: LocalSuperHermesMemory[] = [];

function makeTempDir(prefix = "bf-unit-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createMemoryHarness(opts?: {
  secrets?: Record<string, string>;
  dreamExtractor?: (input: {
    namespace: string;
    chunks: string[];
    existingFacts: Array<{ id: string; factText: string }>;
  }) => Promise<DreamOpBatch>;
}) {
  const rootDir = makeTempDir();
  const loaded = loadHubConfig({ rootDir });
  const db = new StateDatabase(loaded.dbPath);
  openDbs.push(db);
  const scrubber = new SecretScrubber(opts?.secrets ?? {});
  const memory = new LocalSuperHermesMemory(db, loaded.config, loaded.memoryDir, scrubber, opts?.dreamExtractor);
  openMemories.push(memory);
  return { rootDir, loaded, db, scrubber, memory };
}

afterEach(() => {
  while (openMemories.length > 0) {
    openMemories.pop()!.stop();
  }
  while (openDbs.length > 0) {
    openDbs.pop()!.close();
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

describe("1. Hermes Frozen System-Prompt Invariant & CWD-free Prefix Ordering", () => {
  it("shares an identical Tier-1 + Tier-2 CWD-free prefix across bots in different worktrees", () => {
    const { rootDir, memory } = createMemoryHarness();
    const projectRoot = join(rootDir, "projects", "demo");

    const sharedInput = {
      identity: "You are a specialized Bot-Factory worker.",
      toolsBrief: "Use bf_task_claim and bf_handoff_write via MCP.",
      cwdIndependentInstructions: "Always run bun test before finishing.",
      projectContext: "Project Alpha: clean-room TypeScript daemon.",
      namespace: "project:demo",
      projectRoot,
      modelLabel: "devin-acp/swe-2-max",
    };

    const promptA = memory.buildFrozenSystemPrompt({
      ...sharedInput,
      worktreePath: join(projectRoot, "worktrees", "bot-alpha"),
    });
    const promptB = memory.buildFrozenSystemPrompt({
      ...sharedInput,
      worktreePath: join(projectRoot, "worktrees", "bot-beta"),
    });

    const marker = "<!-- TIER:CONTEXT_WORKSPACE -->";
    const idxA = promptA.systemPrompt.indexOf(marker);
    const idxB = promptB.systemPrompt.indexOf(marker);
    expect(idxA).toBeGreaterThan(0);
    expect(idxB).toBeGreaterThan(0);

    const prefixA = promptA.systemPrompt.slice(0, idxA);
    const prefixB = promptB.systemPrompt.slice(0, idxB);
    expect(prefixA).toBe(prefixB);
    expect(prefixA).not.toContain("bot-alpha");
    expect(prefixA).not.toContain("bot-beta");

    // Tier ordering invariant: STABLE -> CONTEXT_CWD_FREE -> CONTEXT_WORKSPACE -> VOLATILE_FROZEN_SNAPSHOT
    const idxStable = promptA.systemPrompt.indexOf("<!-- TIER:STABLE -->");
    const idxCwdFree = promptA.systemPrompt.indexOf("<!-- TIER:CONTEXT_CWD_FREE -->");
    const idxVolatile = promptA.systemPrompt.indexOf("<!-- TIER:VOLATILE_FROZEN_SNAPSHOT -->");
    expect(idxStable).toBeLessThan(idxCwdFree);
    expect(idxCwdFree).toBeLessThan(idxA);
    expect(idxA).toBeLessThan(idxVolatile);

    // Different worktree paths still yield distinct full-prompt hashes
    expect(promptA.hash).not.toBe(promptB.hash);
  });

  it("throws l1_capacity_exceeded when writing beyond maxChars", () => {
    const { loaded, memory } = createMemoryHarness();
    const targetFile = join(loaded.memoryDir, "PROJECT_L1_TEST.md");

    expect(() => memory.writeL1File(targetFile, "x".repeat(51), 50)).toThrow("l1_capacity_exceeded");
    const saved = memory.writeL1File(targetFile, "x".repeat(50), 50);
    expect(saved).toEqual({ usedChars: 50, maxChars: 50 });
    expect(readFileSync(targetFile, "utf8")).toHaveLength(50);

    writeFileSync(targetFile, "y".repeat(80), "utf8");
    const clamped = memory.readL1File(targetFile, 50);
    expect(clamped.content).toHaveLength(50);
    expect(clamped.usedChars).toBe(80);
    expect(clamped.gaugeHeader).toContain("truncated");
  });
});

describe("2. Supermemory Temporal Fact Graph & Decay", () => {
  it("creates v2 on updates, marks v1 is_latest = 0, and preserves audit history", async () => {
    const ns = "project:temporal";
    let mode: "initial" | "update" = "initial";
    let v1Id = "";

    const { db, memory } = createMemoryHarness({
      dreamExtractor: async ({ existingFacts }) => {
        if (mode === "initial") {
          return {
            newFacts: [{ entity: "auth", factText: "Auth uses HS256 JWT tokens", kind: "decision", isStatic: true }],
          };
        }
        const oldFact = existingFacts.find((f) => f.factText.includes("HS256"));
        v1Id = oldFact?.id ?? "";
        return {
          updates: [{ oldId: v1Id, entity: "auth", factText: "Auth migrated to EdDSA JWT tokens", kind: "decision" }],
        };
      },
    });

    await memory.ingestDocument({ docId: "doc_1", namespace: ns, content: "Initial auth spec", instant: true });
    const initialLive = db.listLiveMemoryFacts(ns);
    expect(initialLive).toHaveLength(1);
    const v1Before = initialLive[0]!;
    expect(v1Before.version).toBe(1);
    expect(v1Before.isLatest).toBe(true);

    mode = "update";
    await memory.ingestDocument({ docId: "doc_2", namespace: ns, content: "Updated auth spec", instant: true });

    // v1 is preserved in audit history with is_latest = 0
    const v1After = db.getMemoryFact(v1Before.id)!;
    expect(v1After).not.toBeNull();
    expect(v1After.isLatest).toBe(false);
    expect(v1After.factText).toBe("Auth uses HS256 JWT tokens");

    // Live facts now show only v2
    const liveAfter = db.listLiveMemoryFacts(ns);
    expect(liveAfter).toHaveLength(1);
    const v2 = liveAfter[0]!;
    expect(v2.version).toBe(2);
    expect(v2.isLatest).toBe(true);
    expect(v2.factText).toBe("Auth migrated to EdDSA JWT tokens");

    const edge = db.db
      .query("SELECT src_id, dst_id, rel FROM memory_edges WHERE src_id = ? AND dst_id = ?")
      .get(v2.id, v1Before.id) as { src_id: string; dst_id: string; rel: string } | null;
    expect(edge).toEqual({ src_id: v2.id, dst_id: v1Before.id, rel: "updates" });
  });

  it("keeps both facts latest on extends and traverses edges via getRelatedFacts", () => {
    const { db } = createMemoryHarness();
    const ns = "project:graph";

    const rootFact = db.insertMemoryFact({
      namespace: ns,
      entity: "renderer",
      factText: "3D viewport uses Three.js WebGLRenderer",
      kind: "fact",
    });
    const extendedFact = db.insertMemoryFact({
      namespace: ns,
      entity: "renderer",
      factText: "WebGLRenderer enables ACESFilmicToneMapping",
      kind: "fact",
      extendsFactId: rootFact.id,
    });
    const secondHopFact = db.insertMemoryFact({
      namespace: ns,
      entity: "renderer",
      factText: "Tone mapping exposure is tuned to 1.1",
      kind: "fact",
      extendsFactId: extendedFact.id,
    });

    const live = db.listLiveMemoryFacts(ns);
    expect(live.map((f) => f.id).sort()).toEqual([rootFact.id, extendedFact.id, secondHopFact.id].sort());
    expect(db.getMemoryFact(rootFact.id)!.isLatest).toBe(true);
    expect(db.getMemoryFact(extendedFact.id)!.isLatest).toBe(true);
    expect(db.getMemoryFact(secondHopFact.id)!.isLatest).toBe(true);

    // 1-hop traversal returns direct neighbor only
    const oneHop = db.getRelatedFacts(rootFact.id, 1);
    expect(oneHop.map((f) => f.id)).toEqual([extendedFact.id]);

    // Multi-hop traversal reaches secondHopFact across extends edges
    const multiHop = db.getRelatedFacts(rootFact.id, 3);
    expect(multiHop.map((f) => f.id)).toContain(extendedFact.id);
    expect(multiHop.map((f) => f.id)).toContain(secondHopFact.id);
  });

  it("excludes past forgetAfter from live_memory_facts and marks is_forgotten = 1 in sweepExpired()", () => {
    const { db, memory } = createMemoryHarness();
    const ns = "project:decay";
    const nowSec = Math.floor(Date.now() / 1000);

    const expired = db.insertMemoryFact({
      namespace: ns,
      entity: "ephemeral",
      factText: "Temporary port 4399 diagnostic note",
      kind: "episode",
      forgetAfter: nowSec - 60,
    });
    const active = db.insertMemoryFact({
      namespace: ns,
      entity: "persistent",
      factText: "Daemon binds 127.0.0.1 only",
      kind: "fact",
      forgetAfter: nowSec + 3600,
    });

    // View live_memory_facts immediately filters out expired facts
    const viewRows = db.db
      .query("SELECT id FROM live_memory_facts WHERE namespace = ?")
      .all(ns) as Array<{ id: string }>;
    expect(viewRows.map((r) => r.id)).toEqual([active.id]);

    // Before sweepExpired, raw row still has is_forgotten = 0
    expect(db.getMemoryFact(expired.id)!.isForgotten).toBe(false);

    const sweptCount = memory.sweepExpired();
    expect(sweptCount).toBe(1);

    const expiredRow = db.getMemoryFact(expired.id)!;
    expect(expiredRow.isForgotten).toBe(true);
    expect(expiredRow.forgetReason).toBe("expired");
    expect(db.getMemoryFact(active.id)!.isForgotten).toBe(false);
  });
});

describe("3. SecretScrubber", () => {
  it("redacts configured secrets, Bearer tokens, and inline credentials before persisting", async () => {
    const rawSecret = "sk-mistral-super-secret-value-987654";
    const bearerToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadValue1234";
    const inlineKey = "my_inline_token_value_1234567890";

    const { loaded, db, scrubber, memory } = createMemoryHarness({
      secrets: { MISTRAL_API_KEY: rawSecret },
    });

    const sample = `Key=${rawSecret} Auth: Bearer ${bearerToken} api_key=${inlineKey}`;
    const scrubbed = scrubber.scrub(sample);
    expect(scrubbed).not.toContain(rawSecret);
    expect(scrubbed).not.toContain(bearerToken);
    expect(scrubbed).not.toContain(inlineKey);
    expect(scrubbed).toContain("[REDACTED_SECRET]");
    expect(scrubbed).toContain("Bearer [REDACTED_TOKEN]");
    expect(scrubbed).toContain("api_key=[REDACTED]");

    // Persisting to L1 file writes scrubbed content only
    const l1Path = join(loaded.memoryDir, "SCRUB_CHECK.md");
    memory.writeL1File(l1Path, `Saved secret ${rawSecret} and Bearer ${bearerToken}`, 500);
    const onDisk = readFileSync(l1Path, "utf8");
    expect(onDisk).not.toContain(rawSecret);
    expect(onDisk).not.toContain(bearerToken);
    expect(onDisk).toContain("[REDACTED_SECRET]");
    expect(onDisk).toContain("Bearer [REDACTED_TOKEN]");

    // Ingesting a document persists scrubbed content in SQLite
    await memory.ingestDocument({
      docId: "doc_secret",
      namespace: "project:scrub",
      content: `Decision: never log ${rawSecret} or Bearer ${bearerToken}`,
      instant: true,
    });
    const docRow = db.db.query("SELECT content FROM documents WHERE id = ?").get("doc_secret") as { content: string };
    expect(docRow.content).not.toContain(rawSecret);
    expect(docRow.content).not.toContain(bearerToken);
  });
});

describe("4. ModelRouter", () => {
  it("routes exclusive roster intents and picks a different provider for cross-family verification", () => {
    const dir = makeTempDir();
    const loaded = loadHubConfig({ rootDir: dir });
    const router = new ModelRouter(loaded.config);

    const codingDeep = router.resolveIntent("coding_deep");
    expect(codingDeep).toEqual({
      provider: "devin-acp",
      model: "swe-2-max",
      runtimeKind: "acp_stdio",
      resolvedModelId: "swe-2-max",
    });

    const dreaming = router.resolveIntent("memory_dreaming");
    expect(dreaming).toEqual({
      provider: "mistral-hosted",
      model: "glm-5.3-flash",
      runtimeKind: "native_http",
      resolvedModelId: "glm-5.3-flash",
    });

    // Default verifier_default is google-antigravity/gemini-4-hydrogen; excluding google-antigravity must switch provider
    const crossFromGoogle = router.resolveIntent("verifier_default", {
      excludeProvider: "google-antigravity",
    });
    expect(crossFromGoogle.provider).not.toBe("google-antigravity");
    expect(crossFromGoogle.provider).toBe("mistral-hosted");

    // Excluding mistral-hosted from coding_parallel switches to another provider
    const crossFromMistral = router.resolveIntent("coding_parallel", {
      excludeProvider: "mistral-hosted",
    });
    expect(crossFromMistral.provider).not.toBe("mistral-hosted");
    expect(crossFromMistral.provider).toBe("google-antigravity");
  });
});

describe("5. ACP Permission Policy (resolveAcpPermission)", () => {
  const worktreeCwd = join(tmpdir(), "bf-wt-policy-test");
  const allowOptions: AcpPermissionOption[] = [
    { optionId: "allow_1", kind: "allow_once", name: "Allow once" },
    { optionId: "reject_1", kind: "reject_once", name: "Reject" },
  ];

  it("auto-approves safe in-worktree edits", () => {
    const res = resolveAcpPermission(
      {
        toolCall: {
          toolCallId: "tc_1",
          kind: "edit",
          title: "Edit apps/daemon/src/index.ts",
          locations: [{ path: "apps/daemon/src/index.ts" }],
        },
        options: allowOptions,
      },
      worktreeCwd,
    );

    expect(res).toEqual({
      outcome: { outcome: "selected", optionId: "allow_1" },
      escalated: false,
      reason: "auto_approved_in_worktree",
    });
  });

  it("cancels when options are empty or contain no allow option", () => {
    const emptyRes = resolveAcpPermission(
      {
        toolCall: { toolCallId: "tc_2", kind: "read", title: "Read README.md" },
        options: [],
      },
      worktreeCwd,
    );
    expect(emptyRes).toEqual({
      outcome: { outcome: "cancelled" },
      escalated: false,
      reason: "no_allow_option_offered",
    });

    const rejectOnlyRes = resolveAcpPermission(
      {
        toolCall: { toolCallId: "tc_3", kind: "read", title: "Read README.md" },
        options: [{ optionId: "reject_1", kind: "reject_once" }],
      },
      worktreeCwd,
    );
    expect(rejectOnlyRes).toEqual({
      outcome: { outcome: "cancelled" },
      escalated: false,
      reason: "no_allow_option_offered",
    });
  });

  it("escalates and cancels destructive commands (rm -rf, secrets.env)", () => {
    const rmRes = resolveAcpPermission(
      {
        toolCall: { toolCallId: "tc_4", kind: "execute", title: "Run rm -rf ./dist" },
        options: allowOptions,
      },
      worktreeCwd,
    );
    expect(rmRes.outcome).toEqual({ outcome: "cancelled" });
    expect(rmRes.escalated).toBe(true);
    expect(rmRes.reason).toContain("destructive_pattern_blocked:");

    const secretsRes = resolveAcpPermission(
      {
        toolCall: { toolCallId: "tc_5", kind: "read", title: "Inspect system/secrets.env" },
        options: allowOptions,
      },
      worktreeCwd,
    );
    expect(secretsRes.outcome).toEqual({ outcome: "cancelled" });
    expect(secretsRes.escalated).toBe(true);
    expect(secretsRes.reason).toContain("destructive_pattern_blocked:");
  });

  it("escalates and cancels paths escaping the assigned worktree", () => {
    const res = resolveAcpPermission(
      {
        toolCall: {
          toolCallId: "tc_6",
          kind: "edit",
          title: "Write outside file",
          locations: [{ path: "../../outside.txt" }],
        },
        options: allowOptions,
      },
      worktreeCwd,
    );
    expect(res.outcome).toEqual({ outcome: "cancelled" });
    expect(res.escalated).toBe(true);
    expect(res.reason).toBe("path_outside_worktree:../../outside.txt");
  });
});

describe("6. MCP Bridge (handleMcpJsonRpcRequest)", () => {
  const noopCall = async () => ({});

  it("handles initialize", async () => {
    const resp = await handleMcpJsonRpcRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      noopCall,
    );
    expect(resp).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "bot-factory-mcp-bridge", version: "0.1.0" },
      },
    });
  });

  it("lists all 14 bf_* tools on tools/list", async () => {
    const resp = await handleMcpJsonRpcRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      noopCall,
    );
    expect(resp?.error).toBeUndefined();
    const result = resp?.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(14);
    expect(MCP_TOOLS).toHaveLength(14);
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual([
      "bf_task_list",
      "bf_task_claim",
      "bf_task_update",
      "bf_handoff_write",
      "bf_memory_search",
      "bf_fix_tasks_list",
      "bf_fix_task_resolve",
      "bf_debate_post",
      "bf_subagent_spawn",
      "bf_subagent_status",
      "bf_subagent_wait",
      "bf_subagent_message",
      "bf_subagent_kill",
      "bf_subagent_apply_patch",
    ]);
  });

  it("forwards tools/call to callTool callback and formats result / errors cleanly", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const mockCallTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "bf_task_claim") {
        throw new Error("no_ready_tasks");
      }
      return { ok: true, facts: ["fact-1"] };
    };

    const okResp = await handleMcpJsonRpcRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "bf_memory_search", arguments: { query: "router" } },
      },
      mockCallTool,
    );
    expect(calls).toEqual([{ name: "bf_memory_search", args: { query: "router" } }]);
    expect(okResp).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [{ type: "text", text: JSON.stringify({ ok: true, facts: ["fact-1"] }, null, 2) }],
        isError: false,
      },
    });

    const errResp = await handleMcpJsonRpcRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "bf_task_claim", arguments: {} },
      },
      mockCallTool,
    );
    expect(errResp).toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: {
        content: [{ type: "text", text: "no_ready_tasks" }],
        isError: true,
      },
    });

    const unknownResp = await handleMcpJsonRpcRequest(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "bf_nonexistent", arguments: {} },
      },
      mockCallTool,
    );
    expect(unknownResp).toEqual({
      jsonrpc: "2.0",
      id: 5,
      error: { code: -32602, message: "Unknown tool: bf_nonexistent" },
    });
  });
});

describe("7. AcpSubprocessRuntime End-to-End Lifecycle (Timeout, Pause, Handshake Failure & Shutdown)", () => {
  function makeMockAcpConfig(rootDir: string, scriptPath: string) {
    const loaded = loadHubConfig({ rootDir });
    loaded.config.providers["devin-acp"] = {
      runtime: "acp_stdio",
      command: "bun",
      args: ["run", scriptPath],
      models: {
        "swe-2-max": { id: "swe-2-max", capabilities: ["coding_deep"], tier: "flagship" },
      },
    };
    return loaded;
  }

  it("cleans up subprocess & active map entry on handshake failure", async () => {
    const rootDir = makeTempDir("bf-acp-fail-");
    const scriptPath = join(rootDir, "fail-acp.ts");
    writeFileSync(
      scriptPath,
      `process.stdin.setEncoding("utf8");
       process.stdin.on("data", (d) => {
         for (const line of String(d).split("\\n").filter(Boolean)) {
           const msg = JSON.parse(line);
           if (msg.method === "initialize") {
             process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "init_denied" } }) + "\\n");
           }
         }
       });`,
      "utf8",
    );
    const loaded = makeMockAcpConfig(rootDir, scriptPath);
    const runtime = new AcpSubprocessRuntime(loaded.config, loaded.logsDir, new SecretScrubber({}), { requestTimeoutMs: 1000 });

    await expect(
      runtime.startSession({
        agentId: "bot_fail",
        sessionId: "ses_fail",
        provider: "devin-acp",
        model: "swe-2-max",
        cwd: rootDir,
        systemPrompt: "test",
      }),
    ).rejects.toThrow("init_denied");
    expect(runtime.getActiveCount()).toBe(0);
  });

  it("enforces turn timeout on hung session/prompt and terminates cleanly on shutdownAllSync()", async () => {
    const rootDir = makeTempDir("bf-acp-hang-");
    const scriptPath = join(rootDir, "hang-acp.ts");
    writeFileSync(
      scriptPath,
      `process.stdin.setEncoding("utf8");
       let buf = "";
       process.stdin.on("data", (d) => {
         buf += String(d);
         let nl;
         while ((nl = buf.indexOf("\\n")) !== -1) {
           const line = buf.slice(0, nl).trim();
           buf = buf.slice(nl + 1);
           if (!line) continue;
           const msg = JSON.parse(line);
           if (msg.method === "initialize") {
             process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
           } else if (msg.method === "session/new") {
             process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "ext_1" } }) + "\\n");
           }
           // Intentionally never respond to session/prompt to simulate a wedged agent
         }
       });`,
      "utf8",
    );
    const loaded = makeMockAcpConfig(rootDir, scriptPath);
    const runtime = new AcpSubprocessRuntime(loaded.config, loaded.logsDir, new SecretScrubber({}), { requestTimeoutMs: 250 });

    const handle = await runtime.startSession({
      agentId: "bot_hang",
      sessionId: "ses_hang",
      provider: "devin-acp",
      model: "swe-2-max",
      cwd: rootDir,
      systemPrompt: "test",
    });
    expect(runtime.getActiveCount()).toBe(1);

    const events = [];
    for await (const evt of runtime.sendTurn(handle, { userText: "hang forever", history: [] })) {
      events.push(evt);
    }
    expect(events.some((e) => e.type === "error" && e.message.includes("acp_turn_timeout"))).toBe(true);

    runtime.shutdownAllSync();
    expect(runtime.getActiveCount()).toBe(0);
  });

  it("streams updates, supports clean pause abort without hanging, and cleans up on hard_stop", async () => {
    const rootDir = makeTempDir("bf-acp-ok-");
    const scriptPath = join(rootDir, "ok-acp.ts");
    writeFileSync(
      scriptPath,
      `process.stdin.setEncoding("utf8");
       let buf = "";
       process.stdin.on("data", (d) => {
         buf += String(d);
         let nl;
         while ((nl = buf.indexOf("\\n")) !== -1) {
           const line = buf.slice(0, nl).trim();
           buf = buf.slice(nl + 1);
           if (!line) continue;
           const msg = JSON.parse(line);
           if (msg.method === "initialize") {
             process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
           } else if (msg.method === "session/new") {
             process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "ext_ok" } }) + "\\n");
           } else if (msg.method === "session/prompt") {
             const txt = msg.params?.prompt?.[0]?.text ?? "";
             if (txt.includes("WAIT_FOR_PAUSE")) {
               process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "partial-" } } } }) + "\\n");
               // Hold open so pause abort can interrupt cleanly
             } else {
               process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "hello world" } } } }) + "\\n");
               process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }) + "\\n");
             }
           }
         }
       });`,
      "utf8",
    );
    const loaded = makeMockAcpConfig(rootDir, scriptPath);
    const runtime = new AcpSubprocessRuntime(loaded.config, loaded.logsDir, new SecretScrubber({}), { requestTimeoutMs: 3000 });

    const handle = await runtime.startSession({
      agentId: "bot_ok",
      sessionId: "ses_ok",
      provider: "devin-acp",
      model: "swe-2-max",
      cwd: rootDir,
      systemPrompt: "test",
    });

    // Normal turn completes cleanly
    const evs1 = [];
    for await (const evt of runtime.sendTurn(handle, { userText: "say hi", history: [] })) {
      evs1.push(evt);
    }
    expect(evs1.some((e) => e.type === "done" && e.finalText === "hello world")).toBe(true);

    // Pause abort resolves an in-flight turn cleanly while keeping the session alive
    const evs2: Array<{ type: string; finalText?: string }> = [];
    const turnPromise = (async () => {
      for await (const evt of runtime.sendTurn(handle, { userText: "WAIT_FOR_PAUSE", history: [] })) {
        evs2.push(evt as { type: string; finalText?: string });
      }
    })();
    await new Promise((r) => setTimeout(r, 120));
    await runtime.abort(handle, "pause");
    await turnPromise;
    expect(evs2.some((e) => e.type === "done")).toBe(true);
    expect(runtime.getActiveCount()).toBe(1);

    // Hard stop terminates process tree and removes from active map
    await runtime.abort(handle, "hard_stop");
    expect(runtime.getActiveCount()).toBe(0);
  });
});
