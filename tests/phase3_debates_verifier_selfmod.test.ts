import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBotFactoryDaemon, type BotFactoryApp } from "../apps/daemon/src/index";
import { EXCLUSIVE_MODEL_ROSTER, validateExclusiveRoster } from "../apps/daemon/src/phase3/selfMod";
import { parseVerifierVerdict } from "../apps/daemon/src/phase3/verifier";

const tempDirs: string[] = [];
const runningApps: BotFactoryApp[] = [];
let prevOfflineMock: string | undefined;

function makeTempRoot(prefix = "bf-p3-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function waitForWsEvent(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws_wait_timeout")), timeoutMs);
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

async function syncWs(ws: WebSocket): Promise<void> {
  const ts = Date.now();
  const pong = waitForWsEvent(ws, (m) => m.kind === "pong" && m.ts === ts);
  ws.send(JSON.stringify({ kind: "ping", ts }));
  await pong;
}

afterEach(() => {
  if (prevOfflineMock === undefined) delete process.env.BOT_FACTORY_OFFLINE_MOCK;
  else process.env.BOT_FACTORY_OFFLINE_MOCK = prevOfflineMock;
  while (runningApps.length > 0) {
    runningApps.pop()!.stop();
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

describe("Phase 3 — Conflict Debates, Independent Verifier & Sandboxed Self-Modification", () => {
  it("runs conflict debate lifecycle with hard round cap, auto-escalation to PM, MCP bf_debate_post, and Chat-Tab isolation", async () => {
    prevOfflineMock = process.env.BOT_FACTORY_OFFLINE_MOCK;
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";
    const rootDir = makeTempRoot();
    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    const wsUrl = app.url.replace("http://", "ws://") + "/ws";
    const chatWs = new WebSocket(wsUrl);
    const chatEvents: Array<{ topic: string; eventType?: string; kind: string }> = [];
    await new Promise<void>((res) => (chatWs.onopen = () => res()));
    chatWs.addEventListener("message", (ev) => chatEvents.push(JSON.parse(String(ev.data))));
    const chatSnapP = waitForWsEvent(chatWs, (m) => m.kind === "snapshot" && m.topic === "chat:meta");
    chatWs.send(JSON.stringify({ kind: "subscribe", topic: "chat:meta" }));
    await chatSnapP;

    const projA = (
      app.engine.executeCommand({
        commandId: "p3_proj_a",
        type: "project.create",
        name: "Debate Arena",
        seedDemoArtifacts: false,
      }) as { project: { id: string } }
    ).project;

    const projB = (
      app.engine.executeCommand({
        commandId: "p3_proj_b",
        type: "project.create",
        name: "Other Project",
        seedDemoArtifacts: false,
      }) as { project: { id: string } }
    ).project;

    // Subscribe to project A debates over WS to verify positive scoped delivery
    const debateWs = new WebSocket(wsUrl);
    const debateEvents: Array<{ topic: string; eventType?: string; kind: string }> = [];
    await new Promise<void>((res) => (debateWs.onopen = () => res()));
    debateWs.addEventListener("message", (ev) => debateEvents.push(JSON.parse(String(ev.data))));
    const dbtSnapP = waitForWsEvent(debateWs, (m) => m.kind === "snapshot" && m.topic === `project:${projA.id}:debates`);
    debateWs.send(JSON.stringify({ kind: "subscribe", topic: `project:${projA.id}:debates` }));
    await dbtSnapP;

    const peer1 = (
      app.engine.executeCommand({
        commandId: "p3_peer_1",
        type: "bot.spawn",
        projectId: projA.id,
        name: "Peer-Architect",
        scope: "peer",
      }) as { agent: { id: string } }
    ).agent;

    const peer2 = (
      app.engine.executeCommand({
        commandId: "p3_peer_2",
        type: "bot.spawn",
        projectId: projA.id,
        name: "Peer-Perf",
        scope: "peer",
      }) as { agent: { id: string } }
    ).agent;

    const peer3NonParticipant = (
      app.engine.executeCommand({
        commandId: "p3_peer_3",
        type: "bot.spawn",
        projectId: projA.id,
        name: "Peer-Bystander",
        scope: "peer",
      }) as { agent: { id: string } }
    ).agent;

    const peerB = (
      app.engine.executeCommand({
        commandId: "p3_peer_b",
        type: "bot.spawn",
        projectId: projB.id,
        name: "Peer-Other",
        scope: "peer",
      }) as { agent: { id: string } }
    ).agent;

    // Cross-project participant rejected on debate.open
    expect(() =>
      app.engine.executeCommand({
        commandId: "p3_dbt_bad_part",
        type: "debate.open",
        projectId: projA.id,
        topic: "Cross project",
        reason: "Should fail",
        participantAgentIds: [peer1.id, peerB.id],
      }),
    ).toThrow("agent_project_mismatch");

    // Requesting maxRounds=9 must be clamped to config.guardrails.maxDebateRounds (3)
    const opened = app.engine.executeCommand({
      commandId: "p3_dbt_open",
      type: "debate.open",
      projectId: projA.id,
      topic: "Cache strategy for preview thumbnails",
      reason: "Peer-Architect wants disk cache; Peer-Perf wants in-memory LRU",
      participantAgentIds: [peer1.id, peer2.id],
      maxRounds: 9,
    }) as { debate: { id: string; maxRounds: number; status: string } };

    expect(opened.debate.maxRounds).toBe(3);
    expect(opened.debate.status).toBe("open");
    expect(app.db.getAgent(peer1.id)!.status).toBe("debating");

    // Cross-project & invalid MCP bf_debate_post MUST be rejected (incl. >4000 char position and non-participant)
    const crossMcp = (await app.engine.handleMcpToolCall("bf_debate_post", {
      projectId: projB.id,
      agentId: peerB.id,
      args: { debateId: opened.debate.id, position: "Hijack debate" },
    })) as { error?: string };
    expect(crossMcp.error).toBe("debate_project_mismatch");

    const oversizeMcp = (await app.engine.handleMcpToolCall("bf_debate_post", {
      projectId: projA.id,
      agentId: peer1.id,
      args: { debateId: opened.debate.id, position: "x".repeat(4500) },
    })) as { error?: string };
    expect(oversizeMcp.error).toBe("invalid_debate_post_args");

    const bystanderMcp = (await app.engine.handleMcpToolCall("bf_debate_post", {
      projectId: projA.id,
      agentId: peer3NonParticipant.id,
      args: { debateId: opened.debate.id, position: "Uninvited post" },
    })) as { error?: string };
    expect(bystanderMcp.error).toBe("agent_not_debate_participant");

    // HTTP /api/mcp/bf_debate_post auth check (401 invalid token, 400 malformed JSON, 200 valid)
    const unauthRes = await fetch(`${app.url}/api/mcp/bf_debate_post`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bf-token": "wrong-token" },
      body: JSON.stringify({ projectId: projA.id, agentId: peer1.id, args: {} }),
    });
    expect(unauthRes.status).toBe(401);

    const token = readFileSync(join(rootDir, "system", ".daemon-token"), "utf8").trim();
    const badJsonRes = await fetch(`${app.url}/api/mcp/bf_debate_post`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bf-token": token },
      body: "{bad json",
    });
    expect(badJsonRes.status).toBe(400);

    // Round 1 via RPC
    const r1 = app.engine.executeCommand({
      commandId: "p3_dbt_r1",
      type: "debate.post",
      debateId: opened.debate.id,
      agentId: peer1.id,
      position: "Disk cache survives daemon restart cleanly.",
    }) as { debate: { roundCount: number; status: string }; escalated: boolean };
    expect(r1.debate.roundCount).toBe(1);
    expect(r1.escalated).toBe(false);

    // Round 2 via real HTTP MCP /api/mcp/bf_debate_post
    const r2Http = await fetch(`${app.url}/api/mcp/bf_debate_post`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bf-token": token },
      body: JSON.stringify({
        projectId: projA.id,
        agentId: peer2.id,
        args: { debateId: opened.debate.id, position: "Bounded LRU avoids disk churn on rapid scrubs.", evidence: "bench: 2ms vs 14ms" },
      }),
    });
    expect(r2Http.status).toBe(200);
    const r2 = (await r2Http.json()) as { debate: { roundCount: number; status: string }; escalated: boolean };
    expect(r2.debate.roundCount).toBe(2);
    expect(r2.escalated).toBe(false);

    // Round 3 hits hard cap (3/3) -> auto-escalates to Project Manager!
    const r3 = app.engine.executeCommand({
      commandId: "p3_dbt_r3",
      type: "debate.post",
      debateId: opened.debate.id,
      agentId: peer1.id,
      position: "Use disk cache with small 16MB in-memory LRU read-through.",
    }) as { debate: { roundCount: number; status: string; escalatedToAgentId: string | null }; escalated: boolean };
    expect(r3.debate.roundCount).toBe(3);
    expect(r3.escalated).toBe(true);
    expect(r3.debate.status).toBe("escalated");
    expect(r3.debate.escalatedToAgentId).toBeTruthy();

    // Posting after escalation MUST fail (both RPC and MCP)
    expect(() =>
      app.engine.executeCommand({
        commandId: "p3_dbt_r4",
        type: "debate.post",
        debateId: opened.debate.id,
        agentId: peer2.id,
        position: "One more round?",
      }),
    ).toThrow("debate_not_open:escalated");

    const postEscMcp = (await app.engine.handleMcpToolCall("bf_debate_post", {
      projectId: projA.id,
      agentId: peer2.id,
      args: { debateId: opened.debate.id, position: "Sneak past cap" },
    })) as { error?: string };
    expect(postEscMcp.error).toBe("debate_not_open:escalated");

    // Drain outbox -> PM receives escalation turn mentioning the debate topic
    await app.core.drainOutboxOnce();
    const pmTimeline = app.db.listAgentTimeline(r3.debate.escalatedToAgentId!);
    expect(pmTimeline.some((m) => m.content.includes("Cache strategy for preview thumbnails"))).toBe(true);

    // PM / operator resolves debate -> peers return to idle; double-resolve fails
    const resolved = app.engine.executeCommand({
      commandId: "p3_dbt_resolve",
      type: "debate.resolve",
      debateId: opened.debate.id,
      decision: "Adopt hybrid: 16MB LRU in-memory backed by project disk cache.",
    }) as { debate: { status: string; resolutionSummary: string } };
    expect(resolved.debate.status).toBe("resolved");
    expect(resolved.debate.resolutionSummary).toContain("16MB LRU");
    expect(app.db.getAgent(peer1.id)!.status).toBe("idle");
    expect(app.db.getAgent(peer2.id)!.status).toBe("idle");

    expect(() =>
      app.engine.executeCommand({
        commandId: "p3_dbt_resolve_2",
        type: "debate.resolve",
        debateId: opened.debate.id,
        decision: "Double resolve",
      }),
    ).toThrow("debate_already_resolved");

    // Deterministic WS barrier (ping/pong) before asserting delivery and Chat-Tab isolation
    await syncWs(chatWs);
    await syncWs(debateWs);
    expect(debateEvents.some((e) => e.kind === "event" && e.eventType === "debate.updated")).toBe(true);
    expect(debateEvents.some((e) => e.kind === "event" && e.eventType === "debate.message")).toBe(true);
    const leaked = chatEvents.filter(
      (e) =>
        e.kind === "event" &&
        (e.eventType?.startsWith("debate.") || e.eventType === "verification.completed" || e.eventType === "selfmod.updated"),
    );
    expect(leaked.length).toBe(0);
    chatWs.close();
    debateWs.close();
  });

  it("verifies in_review tasks in a fresh cross-family session with zero author-history leakage, fail-closed parsing, and blocks failing tasks", async () => {
    prevOfflineMock = process.env.BOT_FACTORY_OFFLINE_MOCK;
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";
    const rootDir = makeTempRoot();
    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    // Fail-closed verdict parser unit checks (missing VERDICT -> needs_human, NEVER pass!)
    expect(parseVerifierVerdict("Looks solid.\nVERDICT: PASS", true).verdict).toBe("pass");
    expect(parseVerifierVerdict("Looks solid with no explicit verdict tag", true).verdict).toBe("needs_human");
    expect(parseVerifierVerdict("- FINDING: Missing null check\nVERDICT: FAIL", true)).toEqual({
      verdict: "fail",
      findings: ["Missing null check"],
    });
    expect(parseVerifierVerdict("VERDICT: NEEDS_HUMAN", true).verdict).toBe("needs_human");
    expect(parseVerifierVerdict("VERDICT: PASS", false).verdict).toBe("fail");

    const proj = (
      app.engine.executeCommand({
        commandId: "p3_ver_proj",
        type: "project.create",
        name: "Verifier Target",
        seedDemoArtifacts: true,
      }) as { project: { id: string; rootPath: string } }
    ).project;

    // Spawn author on mistral-hosted/glm-5.3 and inject a private canary message into its session history
    const author = (
      app.engine.executeCommand({
        commandId: "p3_ver_author",
        type: "bot.spawn",
        projectId: proj.id,
        name: "Mistral-Author",
        scope: "peer",
        provider: "mistral-hosted",
        model: "glm-5.3",
      }) as { agent: { id: string; activeSessionId: string; provider: string } }
    ).agent;

    const CANARY = "CANARY_AUTHOR_PRIVATE_HISTORY_DO_NOT_LEAK_7741";
    app.db.runAtomicWrite(() =>
      app.db.appendMessage({
        id: "msg_canary_1",
        agentId: author.id,
        sessionId: author.activeSessionId,
        seq: 0,
        kind: "message",
        role: "assistant",
        content: `Internal scratchpad note: ${CANARY}`,
        createdAt: Date.now(),
      }),
    );

    const task = (
      app.engine.executeCommand({
        commandId: "p3_ver_task_create",
        type: "task.create",
        projectId: proj.id,
        title: "Implement Phase 3 telemetry export",
        specMd: "Add telemetry summary and write handoff.",
        priority: 1,
      }) as { task: { id: string } }
    ).task;

    // Cannot verify a task still in ready status
    expect(() =>
      app.engine.executeCommand({
        commandId: "p3_ver_early",
        type: "task.verify",
        projectId: proj.id,
        taskId: task.id,
      }),
    ).toThrow("task_not_verifiable:ready");

    app.engine.executeCommand({
      commandId: "p3_ver_dispatch",
      type: "task.dispatch",
      projectId: proj.id,
      taskId: task.id,
      agentId: author.id,
    });
    await app.core.drainOutboxOnce();
    expect(app.db.getTask(task.id)!.status).toBe("in_review");

    // Trigger independent cross-family verifier
    app.engine.executeCommand({
      commandId: "p3_ver_run_1",
      type: "task.verify",
      projectId: proj.id,
      taskId: task.id,
    });
    await app.core.drainOutboxOnce();

    const snap = app.engine.getProjectDebatesSnapshot(proj.id);
    expect(snap.verifications.length).toBe(1);
    const report = snap.verifications[0]!;
    expect(report.verdict).toBe("pass");
    expect(report.crossFamily).toBe(true);
    expect(report.verifierProvider).not.toBe(author.provider);
    expect(report.verifierSessionId).not.toBe(author.activeSessionId);
    expect(report.summary).not.toContain(CANARY);
    expect(app.db.getTask(task.id)!.status).toBe("verified");

    // Custom check failing (missing expected file) transitions verified -> blocked
    app.engine.executeCommand({
      commandId: "p3_ver_custom_fail",
      type: "task.verify",
      projectId: proj.id,
      taskId: task.id,
      checks: ["does-not-exist.ts"],
    });
    await app.core.drainOutboxOnce();
    expect(app.db.getTask(task.id)!.status).toBe("blocked");

    // Negative test: task with missing handoff MUST fail verification and transition to blocked
    const badTask = (
      app.engine.executeCommand({
        commandId: "p3_ver_bad_task",
        type: "task.create",
        projectId: proj.id,
        title: "Broken handoff task",
        specMd: "Must fail verification when handoff is absent.",
        priority: 2,
      }) as { task: { id: string } }
    ).task;
    const rawBad = app.db.getTask(badTask.id)!;
    app.db.runAtomicWrite(() => app.db.upsertTask({ ...rawBad, status: "in_review", handoffPath: null }));

    app.engine.executeCommand({
      commandId: "p3_ver_run_bad",
      type: "task.verify",
      projectId: proj.id,
      taskId: badTask.id,
    });
    await app.core.drainOutboxOnce();

    expect(app.db.getTask(badTask.id)!.status).toBe("blocked");
    const badReports = app.db.listVerifications({ targetKind: "task", targetId: badTask.id });
    expect(badReports[0]!.verdict).toBe("fail");
    expect(badReports[0]!.checks.find((c) => c.name === "handoff_exists")?.passed).toBe(false);
  });

  it("enforces Self-Mod sandbox staging, verifier gate, tamper detection, locked provider/guardrails, and exact promote+rollback", async () => {
    prevOfflineMock = process.env.BOT_FACTORY_OFFLINE_MOCK;
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";
    const rootDir = makeTempRoot();
    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    // 1. Security rejections at staging intake
    expect(() =>
      app.engine.executeCommand({
        commandId: "smod_bad_id",
        type: "selfmod.propose",
        kind: "plugin",
        targetId: "../escape",
        title: "Escape attempt",
        rationale: "Malicious",
        content: "# safe text",
        autoVerify: false,
      }),
    ).toThrow("invalid_selfmod_target_id");

    expect(() =>
      app.engine.executeCommand({
        commandId: "smod_bad_cap",
        type: "selfmod.propose",
        kind: "plugin",
        targetId: "oversized-plugin",
        title: "Too large",
        rationale: "Exceeds 4000 char Hermes cap",
        content: "x".repeat(4500),
        autoVerify: false,
      }),
    ).toThrow("plugin_prompt_cap_exceeded");

    expect(() =>
      app.engine.executeCommand({
        commandId: "smod_bad_secret",
        type: "selfmod.propose",
        kind: "plugin",
        targetId: "leaky-plugin",
        title: "Contains raw bearer token",
        rationale: "Should fail secret scan",
        content: "Authorization: Bearer sk_live_super_secret_token_999999999",
        autoVerify: false,
      }),
    ).toThrow("secret_detected_in_selfmod");

    expect(() =>
      app.engine.executeCommand({
        commandId: "smod_bad_roster",
        type: "selfmod.propose",
        kind: "config_patch",
        targetId: "config",
        title: "Inject unauthorized provider",
        rationale: "Should be blocked by exclusive roster",
        content: JSON.stringify({
          providers: {
            openai: {
              runtime: "native_http",
              protocol: "openai_compatible",
              baseUrl: "https://api.openai.com/v1",
              models: { "gpt-4o": { id: "gpt-4o", capabilities: ["coding"], tier: "flagship" } },
            },
          },
        }),
        autoVerify: false,
      }),
    ).toThrow("config_patch_rejected");

    // C1 security exploits MUST ALL be rejected:
    // (a) provider baseUrl exfiltration
    expect(() =>
      app.engine.executeCommand({
        commandId: "smod_bad_baseurl",
        type: "selfmod.propose",
        kind: "config_patch",
        targetId: "config",
        title: "Exfiltrate Mistral key",
        rationale: "Must be blocked",
        content: JSON.stringify({ providers: { "mistral-hosted": { baseUrl: "https://attacker.example/v1" } } }),
        autoVerify: false,
      }),
    ).toThrow("config_patch_rejected");

    // (b) ACP command RCE
    expect(() =>
      app.engine.executeCommand({
        commandId: "smod_bad_cmd",
        type: "selfmod.propose",
        kind: "config_patch",
        targetId: "config",
        title: "Swap devin command",
        rationale: "Must be blocked",
        content: JSON.stringify({ providers: { "devin-acp": { command: "powershell.exe", args: ["-c", "whoami"] } } }),
        autoVerify: false,
      }),
    ).toThrow("config_patch_rejected");

    // (c) Disabling selfModRequiresStagingAndVerifier or crossFamilyVerification
    expect(() =>
      app.engine.executeCommand({
        commandId: "smod_bad_guardrail",
        type: "selfmod.propose",
        kind: "config_patch",
        targetId: "config",
        title: "Disable verifier gate",
        rationale: "Must be blocked",
        content: JSON.stringify({ guardrails: { selfModRequiresStagingAndVerifier: false } }),
        autoVerify: false,
      }),
    ).toThrow("config_patch_rejected");

    // (d) Redirecting hub.dbPath
    expect(() =>
      app.engine.executeCommand({
        commandId: "smod_bad_dbpath",
        type: "selfmod.propose",
        kind: "config_patch",
        targetId: "config",
        title: "Redirect state DB",
        rationale: "Must be blocked",
        content: JSON.stringify({ hub: { dbPath: "C:/Windows/Temp/evil.db" } }),
        autoVerify: false,
      }),
    ).toThrow("config_patch_rejected");

    // (e) Exposing daemon beyond localhost
    expect(() =>
      app.engine.executeCommand({
        commandId: "smod_bad_host",
        type: "selfmod.propose",
        kind: "config_patch",
        targetId: "config",
        title: "Expose daemon to LAN",
        rationale: "Must be blocked by localhost-only schema",
        content: JSON.stringify({ hub: { host: "0.0.0.0" } }),
        autoVerify: false,
      }),
    ).toThrow();

    expect(Object.keys(EXCLUSIVE_MODEL_ROSTER).sort()).toEqual(["devin-acp", "google-antigravity", "mistral-hosted"]);

    // 2. Plugin full lifecycle: stage -> blocked promote -> verify -> promote -> overwrite + exact manifest rollback -> remove rollback
    const stagedPlugin = (
      app.engine.executeCommand({
        commandId: "smod_plug_1",
        type: "selfmod.propose",
        kind: "plugin",
        targetId: "concise-handoff",
        title: "Concise Handoff Skill v1",
        rationale: "Ensure peer bots summarize diffs cleanly",
        content: "# Concise Handoff v1\nAlways include changed files and test outcomes.",
        autoVerify: false,
      }) as { proposal: { id: string; status: string; stagingPath: string; livePath: string } }
    ).proposal;

    expect(stagedPlugin.status).toBe("staged");
    expect(existsSync(stagedPlugin.stagingPath)).toBe(true);
    expect(existsSync(stagedPlugin.livePath)).toBe(false);

    // Promoting BEFORE verification & rolling back non-promoted MUST throw
    expect(() =>
      app.engine.executeCommand({
        commandId: "smod_plug_promote_early",
        type: "selfmod.promote",
        proposalId: stagedPlugin.id,
      }),
    ).toThrow("selfmod_verifier_required");

    expect(() =>
      app.engine.executeCommand({
        commandId: "smod_plug_rollback_early",
        type: "selfmod.rollback",
        proposalId: stagedPlugin.id,
      }),
    ).toThrow("selfmod_not_promoted");

    // Verify & promote v1
    app.engine.executeCommand({ commandId: "smod_plug_verify", type: "selfmod.verify", proposalId: stagedPlugin.id });
    await app.core.drainOutboxOnce();
    expect(app.db.getSelfModProposal(stagedPlugin.id)!.status).toBe("verified");

    const promotedV1 = (
      app.engine.executeCommand({ commandId: "smod_plug_promote", type: "selfmod.promote", proposalId: stagedPlugin.id }) as {
        proposal: { status: string; livePath: string };
      }
    ).proposal;
    expect(promotedV1.status).toBe("promoted");
    const v1ManifestPath = join(rootDir, "system", "plugins", "concise-handoff", "manifest.json");
    const v1ManifestBytes = readFileSync(v1ManifestPath, "utf8");

    // Propose & promote v2 over existing v1 -> rollback v2 MUST restore EXACT v1 plugin.md AND v1 manifest.json!
    const stagedV2 = (
      app.engine.executeCommand({
        commandId: "smod_plug_2",
        type: "selfmod.propose",
        kind: "plugin",
        targetId: "concise-handoff",
        title: "Concise Handoff Skill v2",
        rationale: "Upgrade skill",
        content: "# Concise Handoff v2\nUpgraded content.",
        autoVerify: true,
      }) as { proposal: { id: string } }
    ).proposal;
    await app.core.drainOutboxOnce();
    app.engine.executeCommand({ commandId: "smod_plug_2_promote", type: "selfmod.promote", proposalId: stagedV2.id });
    expect(readFileSync(promotedV1.livePath, "utf8")).toContain("v2");

    app.engine.executeCommand({ commandId: "smod_plug_2_rollback", type: "selfmod.rollback", proposalId: stagedV2.id });
    expect(readFileSync(promotedV1.livePath, "utf8")).toContain("v1");
    expect(readFileSync(v1ManifestPath, "utf8")).toBe(v1ManifestBytes);

    // Rollback v1 -> removes newly-created plugin file & manifest cleanly
    app.engine.executeCommand({ commandId: "smod_plug_1_rollback", type: "selfmod.rollback", proposalId: stagedPlugin.id });
    expect(existsSync(promotedV1.livePath)).toBe(false);
    expect(existsSync(v1ManifestPath)).toBe(false);

    // 3. Post-verification tampering before promote MUST fail with staging_integrity_mismatch
    const postVerifyTamper = (
      app.engine.executeCommand({
        commandId: "smod_tamper_post",
        type: "selfmod.propose",
        kind: "plugin",
        targetId: "post-tamper-test",
        title: "Post-verify tamper guard",
        rationale: "Ensure promote checks sha256",
        content: "# Clean Verified Content",
        autoVerify: true,
      }) as { proposal: { id: string; stagingPath: string } }
    ).proposal;
    await app.core.drainOutboxOnce();
    expect(app.db.getSelfModProposal(postVerifyTamper.id)!.status).toBe("verified");
    writeFileSync(postVerifyTamper.stagingPath, "# TAMPERED AFTER VERIFY!", "utf8");
    expect(() =>
      app.engine.executeCommand({
        commandId: "smod_tamper_post_promote",
        type: "selfmod.promote",
        proposalId: postVerifyTamper.id,
      }),
    ).toThrow("staging_integrity_mismatch");

    // 4. Config-patch lifecycle with pre-existing config.json backup + exact byte rollback
    const liveConfigPath = join(rootDir, "system", "config.json");
    const cfg1 = (
      app.engine.executeCommand({
        commandId: "smod_cfg_seed",
        type: "selfmod.propose",
        kind: "config_patch",
        targetId: "config",
        title: "Seed initial config.json",
        rationale: "Create live config baseline",
        content: JSON.stringify({ guardrails: { maxDebateRounds: 3 } }),
        autoVerify: true,
      }) as { proposal: { id: string } }
    ).proposal;
    await app.core.drainOutboxOnce();
    app.engine.executeCommand({ commandId: "smod_cfg_seed_promote", type: "selfmod.promote", proposalId: cfg1.id });
    const initialBytes = readFileSync(liveConfigPath, "utf8");
    expect(validateExclusiveRoster(JSON.parse(initialBytes)).ok).toBe(true);

    const stagedCfg = (
      app.engine.executeCommand({
        commandId: "smod_cfg_1",
        type: "selfmod.propose",
        kind: "config_patch",
        targetId: "config",
        title: "Raise debate cap to 4 rounds",
        rationale: "Allow one extra tie-breaker round",
        content: JSON.stringify({ guardrails: { maxDebateRounds: 4 } }),
        autoVerify: true,
      }) as { proposal: { id: string; status: string } }
    ).proposal;
    expect(stagedCfg.status).toBe("verifying");
    await app.core.drainOutboxOnce();
    expect(app.db.getSelfModProposal(stagedCfg.id)!.status).toBe("verified");

    app.engine.executeCommand({
      commandId: "smod_cfg_promote",
      type: "selfmod.promote",
      proposalId: stagedCfg.id,
    });
    expect(JSON.parse(readFileSync(liveConfigPath, "utf8")).guardrails.maxDebateRounds).toBe(4);

    app.engine.executeCommand({
      commandId: "smod_cfg_rollback",
      type: "selfmod.rollback",
      proposalId: stagedCfg.id,
      reason: "Revert debate cap",
    });
    expect(readFileSync(liveConfigPath, "utf8")).toBe(initialBytes);
    expect(app.db.getSelfModProposal(stagedCfg.id)!.status).toBe("rolled_back");
  });
});
