import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBotFactoryDaemon, type BotFactoryApp } from "../apps/daemon/src/index";
import { captureCheckpoint, createBotWorktree, restoreCheckpoint } from "../apps/daemon/src/git/worktrees";
import { resolveSafeProjectFile } from "../apps/daemon/src/rpc/server";
import { buildMinimalAcpEnv, resolveAcpPermission } from "../apps/daemon/src/runtimes/acpSubprocessRuntime";
import { resolveSafeWorktreePath } from "../apps/daemon/src/runtimes/nativeHttpRuntime";

const tempDirs: string[] = [];
const runningApps: BotFactoryApp[] = [];
let prevOfflineMock: string | undefined;

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "bf-test-"));
  tempDirs.push(dir);
  return dir;
}

function openAuthedWs(url: string, token: string): WebSocket {
  // @types/bun 1.2.15 DOM lib signature omits Bun's runtime { headers } WebSocket init option.
  return new WebSocket(url, { headers: { "x-bf-token": token } } as unknown as string[]);
}

let wsPingSeq = 1;

function waitForWsEvent(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("ws_wait_timeout"));
    }, timeoutMs);
    const handler = (ev: MessageEvent) => {
      const parsed = JSON.parse(String(ev.data)) as Record<string, unknown>;
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
  const ts = Date.now() * 1000 + (wsPingSeq++ % 1000);
  const pong = waitForWsEvent(ws, (m) => m.kind === "pong" && m.ts === ts);
  ws.send(JSON.stringify({ kind: "ping", ts }));
  await pong;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 8000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitUntil_timeout:${label}`);
}

beforeEach(() => {
  prevOfflineMock = process.env.BOT_FACTORY_OFFLINE_MOCK;
});

afterEach(() => {
  try {
    while (runningApps.length > 0) {
      runningApps.pop()?.stop();
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
  } finally {
    if (prevOfflineMock === undefined) delete process.env.BOT_FACTORY_OFFLINE_MOCK;
    else process.env.BOT_FACTORY_OFFLINE_MOCK = prevOfflineMock;
    prevOfflineMock = undefined;
  }
});

describe("Bot-Factory Phase 1 + Phase 2 Core E2E", () => {
  it("provisions project with seeded doc/svg/glb previews, enforces workspace-scoped checkpoints, and prevents path traversal", async () => {
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";
    const rootDir = makeTempRoot();
    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    const created = app.engine.executeCommand({
      commandId: "cmd_create_1",
      type: "project.create",
      name: "Alpha Studio",
      seedDemoArtifacts: true,
    }) as { project: { id: string; slug: string; rootPath: string; repoPath: string } };

    // Idempotent command receipt check (T3 invariant)
    const duplicate = app.engine.executeCommand({
      commandId: "cmd_create_1",
      type: "project.create",
      name: "Alpha Studio",
      seedDemoArtifacts: true,
    }) as { project: { id: string } };
    expect(duplicate.project.id).toBe(created.project.id);

    // Verify seeded preview artifacts exist and GLB has valid glTF 2.0 binary magic header ('glTF')
    const previews = app.engine.getProjectPreviewsSnapshot(created.project.id);
    const kinds = new Set(previews.artifacts.map((a) => a.kind));
    expect(kinds.has("doc")).toBe(true);
    expect(kinds.has("image")).toBe(true);
    expect(kinds.has("model_3d")).toBe(true);

    const glbEntry = previews.artifacts.find((a) => a.kind === "model_3d")!;
    const glbBytes = readFileSync(join(created.project.rootPath, glbEntry.relativePath));
    expect(glbBytes.subarray(0, 4).toString("ascii")).toBe("glTF");

    // Path traversal, Windows UNC escape, and artifact top-dir scope guard checks
    expect(() => resolveSafeProjectFile(created.project.rootPath, "../../system/secrets.env")).toThrow("path_traversal_blocked");
    expect(() => resolveSafeProjectFile(created.project.rootPath, "\\\\localhost\\c$\\Users\\secret.txt")).toThrow("path_traversal_blocked");
    expect(() => resolveSafeProjectFile(created.project.rootPath, "repo/.git/config")).toThrow("artifact_scope_restricted");
    expect(() => resolveSafeWorktreePath(created.project.repoPath, "\\\\localhost\\c$\\secret.txt")).toThrow("worktree_boundary_violation");
    const uncPerm = resolveAcpPermission(
      {
        toolCall: { title: "read UNC", kind: "read", locations: [{ path: "\\\\localhost\\c$\\secret.txt" }] },
        options: [{ optionId: "ok", kind: "allow_once" }],
      },
      created.project.repoPath,
      true,
    );
    expect(uncPerm.outcome.outcome).toBe("cancelled");
    expect(uncPerm.escalated).toBe(true);

    // Cross-origin request guard & minimal ACP child env isolation
    const evilRes = await fetch(`${app.url}/api/health`, { headers: { Origin: "https://evil.example" } });
    expect(evilRes.status).toBe(403);
    const loopbackProxyRes = await fetch(`${app.url}/api/health`, { headers: { Origin: "http://127.0.0.1:59263" } });
    expect(loopbackProxyRes.status).toBe(200);
    const prevKey = process.env.MISTRAL_API_KEY;
    process.env.MISTRAL_API_KEY = "sk-should-never-leak-to-acp";
    try {
      const childEnv = buildMinimalAcpEnv();
      expect(childEnv.MISTRAL_API_KEY).toBeUndefined();
      expect(childEnv.GEMINI_API_KEY).toBeUndefined();
      expect(childEnv.BOT_FACTORY_TOKEN).toBeUndefined();
    } finally {
      if (prevKey === undefined) delete process.env.MISTRAL_API_KEY;
      else process.env.MISTRAL_API_KEY = prevKey;
    }

    // Two parallel worktrees + workspace-scoped hidden checkpoint safety check
    const wtA = createBotWorktree({
      projectRoot: created.project.rootPath,
      repoPath: created.project.repoPath,
      agentId: "bot_a",
      taskId: "tsk_a",
    });
    const wtB = createBotWorktree({
      projectRoot: created.project.rootPath,
      repoPath: created.project.repoPath,
      agentId: "bot_a",
      taskId: "tsk_b",
    });

    writeFileSync(join(wtA.worktreePath, "untracked-note.txt"), "hello from worktree A", "utf8");
    const cp = await captureCheckpoint(app.db, { agentId: "bot_a", cwd: wtA.worktreePath, turnNum: 1 });
    expect(cp.refName).toContain("refs/bot-factory/checkpoints/");
    expect(cp.commitSha.length).toBeGreaterThanOrEqual(7);

    const cpRow = app.db.db.query("SELECT id FROM checkpoints WHERE ref_name = ?").get(cp.refName) as { id: string };
    // Cross-worktree restore MUST be refused!
    await expect(
      restoreCheckpoint(app.db, { agentId: "bot_a", currentCwd: wtB.worktreePath, checkpointId: cpRow.id }),
    ).rejects.toThrow("cross_worktree_restore_refused");
  });

  it("isolates Chat-Tab from bot tool-log spam via Scoped WebSocket Subscriptions and runs Annotation-to-Fix loop", async () => {
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";
    const rootDir = makeTempRoot();
    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    const token = readFileSync(join(rootDir, "system", ".daemon-token"), "utf8").trim();
    const wsUrl = app.url.replace("http://", "ws://") + "/ws";
    const chatClient = openAuthedWs(wsUrl, token);
    const botClient = openAuthedWs(wsUrl, token);

    const chatReceived: Array<{ topic: string; eventType?: string; kind: string }> = [];
    const botReceived: Array<{ topic: string; eventType?: string; kind: string; data?: any }> = [];

    await Promise.all([
      new Promise<void>((res) => (chatClient.onopen = () => res())),
      new Promise<void>((res) => (botClient.onopen = () => res())),
    ]);

    chatClient.onmessage = (ev) => chatReceived.push(JSON.parse(String(ev.data)));
    botClient.onmessage = (ev) => botReceived.push(JSON.parse(String(ev.data)));

    chatClient.send(JSON.stringify({ kind: "subscribe", topic: "chat:meta" }));
    await syncWs(chatClient);

    const projRes = app.engine.executeCommand({
      commandId: "cmd_proj_ws",
      type: "project.create",
      name: "Preview Loop Project",
      seedDemoArtifacts: true,
    }) as { project: { id: string; rootPath: string } };

    // Trigger a 3D annotation with requestFixNow=true -> auto-spawns Fix-Bot + Fix-Task!
    const annRes = app.engine.executeCommand({
      commandId: "cmd_ann_3d",
      type: "annotation.create",
      projectId: projRes.project.id,
      anchor: {
        kind: "model_3d",
        filePath: "artifacts/hero-monolith.glb",
        meshName: "Monolith",
        point: [0.2, 1.1, 0.3],
        normal: [0, 1, 0],
        camera: { pos: [2.5, 2.0, 3.0], target: [0, 0.5, 0], fov: 45 },
      },
      comment: "Bevel the top edge and darken metallic roughness",
      requestFixNow: true,
    }) as { annotation: { id: string; linkedTaskId: string }; fixTask: { id: string; assignedAgentId: string } };

    expect(annRes.fixTask.id).toBeTruthy();
    botClient.send(JSON.stringify({ kind: "subscribe", topic: `bot:${annRes.fixTask.assignedAgentId}:timeline` }));
    await syncWs(botClient);

    await app.core.drainOutboxOnce();
    await waitUntil(
      () => {
        const outboxRows = app.db.db.query("SELECT status FROM outbox_effects").all() as Array<{ status: string }>;
        const task = app.db.getTask(annRes.fixTask.id);
        return (
          outboxRows.length > 0 &&
          outboxRows.every((r) => r.status === "done") &&
          task?.status === "in_review"
        );
      },
      8000,
      "fixTask_in_review",
    );
    await syncWs(chatClient);
    await syncWs(botClient);

    // Verify Fix-Task moved to in_review, Handoff file created, Annotation moved to resolved_pending_review
    const outbox = app.db.db.query("SELECT effect_type, status, last_error FROM outbox_effects").all();
    expect(outbox).toEqual([{ effect_type: "task.run", status: "done", last_error: null }]);
    const updatedTask = app.db.getTask(annRes.fixTask.id)!;
    expect(updatedTask.status).toBe("in_review");
    expect(updatedTask.handoffPath).toBeTruthy();
    expect(existsSync(join(projRes.project.rootPath, updatedTask.handoffPath!))).toBe(true);

    const updatedAnn = app.db.getAnnotation(annRes.annotation.id)!;
    expect(updatedAnn.status).toBe("resolved_pending_review");

    // Verify ZERO tool_call events ever leaked onto chat:meta!
    const leakedToolEvents = chatReceived.filter(
      (m) => m.topic === "chat:meta" && m.kind === "event" && m.eventType === "timeline.item",
    );
    expect(leakedToolEvents.length).toBe(0);

    // Verify Steer goes to PM and records L2 memory
    const steerRes = app.engine.executeCommand({
      commandId: "cmd_steer_1",
      type: "steer.submit",
      projectId: projRes.project.id,
      message: "Decision: prioritize 3D silhouette readability over micro-details",
    }) as { pmAgentId: string };
    expect(steerRes.pmAgentId).toBeTruthy();
    await app.core.drainOutboxOnce();
    await syncWs(chatClient);
    await syncWs(botClient);

    chatClient.close();
    botClient.close();
  });

  it("handles crash recovery (retires previous-epoch effects, marks started admissions unknown) and FTS5 detach fallback", () => {
    const rootDir = makeTempRoot();
    const app1 = startBotFactoryDaemon({ rootDir, port: 0 });
    const meta = app1.db.getAgent(app1.engine.metaAgentId)!;
    const adm = app1.db.runAtomicWrite(() => app1.db.enqueueAdmission(meta.activeSessionId!, "in-flight turn"));
    app1.db.runAtomicWrite(() => app1.db.updateAdmissionStatus(adm.id, "started"));
    app1.db.runAtomicWrite(() => app1.db.enqueueOutboxEffect("meta.chat.turn", { text: "orphaned" }));
    const dbPath = join(rootDir, "system", "state.db");
    app1.stop();

    // Restart daemon -> epoch increments, orphaned effect retired, started admission becomes 'unknown'
    const app2 = startBotFactoryDaemon({ rootDir, dbPath, port: 0 });
    runningApps.push(app2);
    expect(app2.db.epoch).toBeGreaterThan(1);

    const admRow = app2.db.db.query("SELECT status, execution_generation FROM session_admissions WHERE id = ?").get(adm.id) as {
      status: string;
      execution_generation: number;
    };
    expect(admRow.status).toBe("unknown");

    // New admission MUST be blocked until unknown admission is explicitly resolved!
    expect(() => app2.db.enqueueAdmission(meta.activeSessionId!, "follower")).toThrow("session_blocked_by_unknown_admission");

    // Wrong generation fails with stale_generation; matching generation resolves cleanly via production RPC command
    expect(() =>
      app2.engine.executeCommand({
        commandId: "cmd_resolve_bad",
        type: "session.resolve_unknown",
        admissionId: adm.id,
        expectedGeneration: admRow.execution_generation + 99,
      }),
    ).toThrow("stale_generation");
    app2.engine.executeCommand({
      commandId: "cmd_resolve_ok",
      type: "session.resolve_unknown",
      admissionId: adm.id,
      expectedGeneration: admRow.execution_generation,
    });
    expect(() => app2.db.enqueueAdmission(meta.activeSessionId!, "follower")).not.toThrow();

    // Detach FTS5 triggers -> search gracefully falls back to LIKE without crashing
    app2.db.detachFtsTriggers();
    expect(app2.db.isFtsStale()).toBe(true);
    const hits = app2.db.searchMessages("ready");
    expect(Array.isArray(hits)).toBe(true);
  });

  it("blocks annotation path traversal, enforces exclusive writer lock, validates task.dispatch, clears pid on stop, and cleans up WS subscribers", async () => {
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";
    const rootDir = makeTempRoot();
    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    // 1. Exclusive writer lock prevents a second daemon from poisoning epoch of instance #1
    const dbPath = join(rootDir, "system", "state.db");
    expect(() => startBotFactoryDaemon({ rootDir, dbPath, port: 0 })).toThrow("database_writer_lock_held");
    const projA = app.engine.executeCommand({
      commandId: "cmd_sec_proj_a",
      type: "project.create",
      name: "Security Alpha",
      seedDemoArtifacts: true,
    }) as { project: { id: string; rootPath: string } };
    const projB = app.engine.executeCommand({
      commandId: "cmd_sec_proj_b",
      type: "project.create",
      name: "Security Beta",
      seedDemoArtifacts: false,
    }) as { project: { id: string; rootPath: string } };

    // Meta snapshot preserves persisted artifact cards across reconnects
    const metaSnap = app.engine.getMetaChatSnapshot();
    expect(metaSnap.cards.length).toBeGreaterThanOrEqual(2);

    // 2. Critical #1: annotation.create rejects path traversal & out-of-scope paths and never writes outside project
    const outsideVictim = join(rootDir, "victim-outside.md");
    writeFileSync(outsideVictim, "ORIGINAL_SAFE_CONTENT", "utf8");
    expect(() =>
      app.engine.executeCommand({
        commandId: "cmd_evil_ann_1",
        type: "annotation.create",
        projectId: projA.project.id,
        anchor: {
          kind: "doc",
          filePath: "../../victim-outside.md",
          blockId: "blk-0",
          contentHash: "abc",
          quote: "ORIGINAL",
        },
        comment: "INJECTED_PAYLOAD",
        requestFixNow: true,
      }),
    ).toThrow("path_traversal_blocked");

    expect(() =>
      app.engine.executeCommand({
        commandId: "cmd_evil_ann_2",
        type: "annotation.create",
        projectId: projA.project.id,
        anchor: {
          kind: "doc",
          filePath: "repo/README.md",
          blockId: "blk-0",
          contentHash: "abc",
          quote: "README",
        },
        comment: "INJECTED_INTO_REPO",
        requestFixNow: true,
      }),
    ).toThrow("artifact_scope_restricted");
    expect(readFileSync(outsideVictim, "utf8")).toBe("ORIGINAL_SAFE_CONTENT");

    // 3. Major #5: task.dispatch validates project membership, agent scope/status, and non-claimed state
    const taskA = (
      app.engine.executeCommand({
        commandId: "cmd_tsk_a",
        type: "task.create",
        projectId: projA.project.id,
        title: "Scoped Task A",
        specMd: "Do A",
        priority: 1,
      }) as { task: { id: string } }
    ).task;

    const peerA = (
      app.engine.executeCommand({
        commandId: "cmd_peer_a",
        type: "bot.spawn",
        projectId: projA.project.id,
        name: "Peer-A",
        scope: "peer",
      }) as { agent: { id: string } }
    ).agent;

    const peerB = (
      app.engine.executeCommand({
        commandId: "cmd_peer_b",
        type: "bot.spawn",
        projectId: projB.project.id,
        name: "Peer-B",
        scope: "peer",
      }) as { agent: { id: string } }
    ).agent;

    // Cross-project task dispatch rejected
    expect(() =>
      app.engine.executeCommand({
        commandId: "cmd_disp_bad_proj",
        type: "task.dispatch",
        projectId: projB.project.id,
        taskId: taskA.id,
      }),
    ).toThrow("task_project_mismatch");

    // Cross-project agent dispatch rejected
    expect(() =>
      app.engine.executeCommand({
        commandId: "cmd_disp_bad_agent",
        type: "task.dispatch",
        projectId: projA.project.id,
        taskId: taskA.id,
        agentId: peerB.id,
      }),
    ).toThrow("agent_project_mismatch");

    // Set a PID on peerB, then hard-stop -> PID must be cleared to null and dispatch refused
    app.db.runAtomicWrite(() => app.db.updateAgentStatus(peerB.id, "working", { pid: 42424 }));
    expect(app.db.getAgent(peerB.id)!.pid).toBe(42424);
    app.engine.executeCommand({ commandId: "cmd_stop_b", type: "bot.stop", agentId: peerB.id });
    expect(app.db.getAgent(peerB.id)!.status).toBe("stopped");
    expect(app.db.getAgent(peerB.id)!.pid).toBeNull();

    const taskB = (
      app.engine.executeCommand({
        commandId: "cmd_tsk_b",
        type: "task.create",
        projectId: projB.project.id,
        title: "Scoped Task B",
        specMd: "Do B",
        priority: 2,
      }) as { task: { id: string } }
    ).task;

    expect(() =>
      app.engine.executeCommand({
        commandId: "cmd_disp_stopped",
        type: "task.dispatch",
        projectId: projB.project.id,
        taskId: taskB.id,
        agentId: peerB.id,
      }),
    ).toThrow("agent_unavailable:stopped");

    // Valid dispatch succeeds, and re-dispatching the already-claimed task is rejected
    app.engine.executeCommand({
      commandId: "cmd_disp_ok",
      type: "task.dispatch",
      projectId: projA.project.id,
      taskId: taskA.id,
      agentId: peerA.id,
    });
    expect(() =>
      app.engine.executeCommand({
        commandId: "cmd_disp_double",
        type: "task.dispatch",
        projectId: projA.project.id,
        taskId: taskA.id,
      }),
    ).toThrow("task_not_dispatchable:claimed");

    // 4. MCP bf_task_claim works without taskId (picks highest-priority ready task) and rejects unknown agents cleanly
    const unknownAgentRes = (await app.engine.handleMcpToolCall("bf_task_claim", {
      projectId: projB.project.id,
      agentId: "agent_nonexistent",
      args: {},
    })) as { error?: string };
    expect(unknownAgentRes.error).toBe("agent_not_found");

    const peerB2 = (
      app.engine.executeCommand({
        commandId: "cmd_peer_b2",
        type: "bot.spawn",
        projectId: projB.project.id,
        name: "Peer-B2",
        scope: "peer",
      }) as { agent: { id: string } }
    ).agent;
    const claimed = (await app.engine.handleMcpToolCall("bf_task_claim", {
      projectId: projB.project.id,
      agentId: peerB2.id,
      args: {},
    })) as { task?: { id: string; status: string } };
    expect(claimed.task?.id).toBe(taskB.id);
    expect(claimed.task?.status).toBe("claimed");

    // 5. Bound port propagated to engine URL & IPv6 loopback origin allowed
    const token = readFileSync(join(rootDir, "system", ".daemon-token"), "utf8").trim();
    expect(app.engine.getDaemonUrl()).toBe(`http://127.0.0.1:${app.port}`);
    const ipv6Ok = await fetch(`${app.url}/api/health`, {
      headers: { Origin: `http://[::1]:${app.port}`, "x-bf-token": token },
    });
    expect(ipv6Ok.status).toBe(200);

    // 6. WS close cleans up topic subscriber count
    const ws = openAuthedWs(`${app.url.replace("http://", "ws://")}/ws`, token);
    await new Promise<void>((res) => (ws.onopen = () => res()));
    ws.send(JSON.stringify({ kind: "subscribe", topic: "chat:meta" }));
    await syncWs(ws);
    await waitUntil(() => app.server.getSubscriberCount("chat:meta") === 1, 5000, "ws_subscriber_added");
    expect(app.server.getSubscriberCount("chat:meta")).toBe(1);
    const wsClosed = new Promise<void>((res) => (ws.onclose = () => res()));
    ws.close();
    await wsClosed;
    await waitUntil(() => app.server.getSubscriberCount("chat:meta") === 0, 5000, "ws_subscriber_cleaned_up");
    expect(app.server.getSubscriberCount("chat:meta")).toBe(0);

    // 7. Stale lock recovery: after clean stop, writing a dead PID lock file still lets a new daemon boot
    runningApps.pop()!.stop();
    writeFileSync(`${dbPath}.writer.lock`, JSON.stringify({ pid: 999999, startedAt: Date.now() }), "utf8");
    const appRecovered = startBotFactoryDaemon({ rootDir, dbPath, port: 0 });
    runningApps.push(appRecovered);
    expect(appRecovered.db.epoch).toBeGreaterThan(1);
  });
});
