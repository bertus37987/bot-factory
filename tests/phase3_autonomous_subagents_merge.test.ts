import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubConfig } from "@bot-factory/shared";
import { loadHubConfig, saveHubConfig, SecretScrubber } from "../apps/daemon/src/config";
import { startBotFactoryDaemon, type BotFactoryApp } from "../apps/daemon/src/index";
import { mergeBotWorktree, createBotWorktree } from "../apps/daemon/src/git/worktrees";
import { runProjectVerifyChecks } from "../apps/daemon/src/phase3/verifier";

const tempDirs: string[] = [];
const runningApps: BotFactoryApp[] = [];
const mockServers: Array<ReturnType<typeof Bun.serve>> = [];
const savedEnv = new Map<string, string | undefined>();

function rememberEnv(key: string): void {
  if (!savedEnv.has(key)) {
    savedEnv.set(key, process.env[key]);
  }
}

function makeTempRoot(prefix = "bf-p3-auto-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function gitSync(args: string[], cwd: string, allowFail = false): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", "-c", "core.longpaths=true", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const res = {
    code: proc.exitCode,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
  };
  if (res.code !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed (${res.code}): ${res.stderr || res.stdout}`);
  }
  return res;
}

function initTempGitRepo(repoDir: string, files: Record<string, string>): string {
  const initRes = gitSync(["init", "-b", "main"], repoDir, true);
  if (initRes.code !== 0) {
    gitSync(["init"], repoDir);
    gitSync(["symbolic-ref", "HEAD", "refs/heads/main"], repoDir);
  }
  gitSync(["config", "core.longpaths", "true"], repoDir);
  gitSync(["config", "core.autocrlf", "false"], repoDir);
  gitSync(["config", "user.name", "Bot Factory Test"], repoDir);
  gitSync(["config", "user.email", "test@bot-factory.local"], repoDir);
  gitSync(["config", "commit.gpgsign", "false"], repoDir);

  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repoDir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  gitSync(["add", "-A"], repoDir);
  gitSync(["commit", "-m", "chore: initial repo"], repoDir);
  return gitSync(["rev-parse", "HEAD"], repoDir).stdout;
}

function openAuthedWs(url: string, token: string): WebSocket {
  return new WebSocket(url, { headers: { "x-bf-token": token } } as unknown as string[]);
}

function waitForWsEvent(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 8000): Promise<any> {
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

async function syncWs(ws: WebSocket): Promise<void> {
  const ts = Date.now();
  const pong = waitForWsEvent(ws, (m) => m.kind === "pong" && m.ts === ts);
  ws.send(JSON.stringify({ kind: "ping", ts }));
  await pong;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 20_000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`waitUntil_timeout:${label}`);
}

function makeBaseTestConfig(rootDir: string, extraProviders?: HubConfig["providers"]): HubConfig {
  const loaded = loadHubConfig({ rootDir, port: 0 });
  const cfg = structuredClone(loaded.config);
  if (extraProviders) {
    Object.assign(cfg.providers, extraProviders);
  }
  return cfg;
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
  chunks.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 20 } })}\n\n`);
  chunks.push("data: [DONE]\n\n");
  return new TextEncoder().encode(chunks.join(""));
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

describe("Phase 3 — Autonomous 3-Tier DAG, Depth-1 Subagents, Real Verifier Retry & Worktree Merge", () => {
  it(
    "runs full 3-tier autonomous DAG + mcpBridge subagents + real verifyChecks FAIL->retry->PASS + calm team_report + squash merge",
    async () => {
      rememberEnv("BOT_FACTORY_OFFLINE_MOCK");
      delete process.env.BOT_FACTORY_OFFLINE_MOCK;

      const rootDir = makeTempRoot("bf-p3-full-");
      const repoDir = makeTempRoot("bf-p3-ext-repo-");

      initTempGitRepo(repoDir, {
        "README.md": "# Phase 3 Autonomous Repo\n",
        "verify.ts": `import { existsSync } from "node:fs";
const hasA = existsSync("src/task_a.ts");
const hasB = existsSync("src/task_b.ts");
if (!hasA && !hasB) {
  console.error("Neither src/task_a.ts nor src/task_b.ts exists");
  process.exit(1);
}
if (hasA) {
  const modA = await import("./src/task_a.ts");
  if (modA.add(2, 3) !== 5) {
    console.error("Task A failed: add(2,3)=" + String(modA.add(2, 3)));
    process.exit(1);
  }
}
if (hasB) {
  const modB = await import("./src/task_b.ts");
  if (modB.multiply(3, 4) !== 12) {
    console.error("Task B failed: multiply(3,4)=" + String(modB.multiply(3, 4)));
    process.exit(1);
  }
}
console.log("PROJECT_CHECKS_OK");
`,
      });

      const acpMockPath = join(rootDir, "mock-acp-subagent.ts");
      writeFileSync(
        acpMockPath,
        `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface McpClient {
  request(method: string, params?: unknown): Promise<any>;
  callTool(name: string, args: Record<string, unknown>): Promise<any>;
  close(): void;
}

function startMcpClient(command: string, args: string[], cwd: string, extraEnv?: Record<string, string>): McpClient {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(extraEnv ?? {}) },
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  const pump = async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.id !== undefined && pending.has(msg.id)) {
            const p = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          }
        }
      }
    } catch {
      // ignore stream teardown
    }
  };
  void pump();

  const request = (method: string, params?: unknown): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
    });
  };

  const callTool = async (name: string, toolArgs: Record<string, unknown>): Promise<any> => {
    const res = await request("tools/call", { name, arguments: toolArgs });
    const txt = res?.content?.[0]?.text ?? "{}";
    try {
      return JSON.parse(txt);
    } catch {
      return { raw: txt, isError: res?.isError };
    }
  };

  const close = () => {
    try { proc.stdin.end(); } catch {}
    try { proc.kill(); } catch {}
  };

  return { request, callTool, close };
}

let sessionCwd = process.cwd();
let mcpClient: McpClient | null = null;
let buf = "";

function emitUpdate(update: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update } }) + "\\n");
}

function sendResult(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

function sendError(id: unknown, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\\n");
}

process.stdin.setEncoding("utf8");
process.stdin.on("end", () => {
  mcpClient?.close();
});
process.on("SIGTERM", () => {
  mcpClient?.close();
  process.exit(0);
});

async function handleMessage(msg: any): Promise<void> {
  if (msg.method === "initialize") {
    sendResult(msg.id, { protocolVersion: 1 });
    return;
  }
  if (msg.method === "session/new") {
    sessionCwd = msg.params?.cwd || process.cwd();
    const srv = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers[0] : null;
    if (srv && !mcpClient) {
      mcpClient = startMcpClient(srv.command, srv.args ?? [], sessionCwd, srv.env ?? {});
      await mcpClient.request("initialize", {});
    }
    sendResult(msg.id, { sessionId: "acp_ext_" + Math.random().toString(36).slice(2, 8) });
    return;
  }
  if (msg.method === "session/prompt") {
    try {
      const promptText = String(msg.params?.prompt?.[0]?.text ?? "");

      if (promptText.includes("depth-1 readonly sidekick subagent")) {
        if (!mcpClient) throw new Error("missing_mcp_client_in_readonly_subagent");
        const depthRes = await mcpClient.callTool("bf_subagent_spawn", {
          name: "Depth2-Blocked",
          mode: "readonly",
          prompt: "Must reject depth 2",
        });
        const readme = existsSync(join(sessionCwd, "README.md"))
          ? readFileSync(join(sessionCwd, "README.md"), "utf8").trim()
          : "";
        emitUpdate({
          sessionUpdate: "agent_message_chunk",
          content: [{ type: "text", text: "Readonly audit ok (" + readme.slice(0, 30) + "); depth2=" + String(depthRes.error ?? "unexpected_ok") }],
        });
        sendResult(msg.id, { stopReason: "end_turn" });
        return;
      }

      if (promptText.includes("depth-1 code sidekick subagent")) {
        if (!mcpClient) throw new Error("missing_mcp_client_in_code_subagent");
        const depthRes = await mcpClient.callTool("bf_subagent_spawn", {
          name: "Depth2-Code-Blocked",
          mode: "code",
          prompt: "Must reject depth 2",
        });
        mkdirSync(join(sessionCwd, "src"), { recursive: true });
        writeFileSync(
          join(sessionCwd, "src", "task_a.ts"),
          "export function add(a: number, b: number): number {\\n  return a - b;\\n}\\n",
          "utf8",
        );
        emitUpdate({
          sessionUpdate: "agent_message_chunk",
          content: [{ type: "text", text: "Code subagent wrote initial src/task_a.ts; depth2=" + String(depthRes.error ?? "ok") }],
        });
        sendResult(msg.id, { stopReason: "end_turn" });
        return;
      }

      const taskMatch = /Execute task ([^\\s:]+):/.exec(promptText);
      const taskId = taskMatch?.[1] ?? "";

      if (promptText.includes("Task A")) {
        if (!mcpClient) throw new Error("missing_mcp_client_in_peer");
        if (promptText.includes("Verifier Retry Feedback")) {
          mkdirSync(join(sessionCwd, "src"), { recursive: true });
          writeFileSync(
            join(sessionCwd, "src", "task_a.ts"),
            "export function add(a: number, b: number): number {\\n  return a + b;\\n}\\n",
            "utf8",
          );
          emitUpdate({
            sessionUpdate: "tool_call",
            toolCallId: "tc_fix_a",
            title: "Fix add() in src/task_a.ts",
            kind: "edit",
            status: "completed",
            locations: [{ path: "src/task_a.ts" }],
          });
          await mcpClient.callTool("bf_handoff_write", {
            taskId,
            title: "Task A Fixed",
            summary: "Fixed add(a, b) to return a + b after verifier retry feedback.",
            changedFiles: ["src/task_a.ts"],
            testsRun: ["bun verify.ts (pass)"],
          });
          emitUpdate({
            sessionUpdate: "agent_message_chunk",
            content: [{ type: "text", text: "Task A fixed after verifier feedback." }],
          });
          sendResult(msg.id, { stopReason: "end_turn" });
          return;
        }

        // Attempt 1: list 14 MCP tools, spawn readonly + code subagents, wait, check status, kill readonly, apply code patch
        const listRes = await mcpClient.request("tools/list", {});
        const toolCount = Array.isArray(listRes?.tools) ? listRes.tools.length : 0;
        if (toolCount !== 14) {
          throw new Error("expected_14_mcp_tools_got_" + toolCount);
        }

        const roSpawn = await mcpClient.callTool("bf_subagent_spawn", {
          name: "Scout-RO",
          role: "researcher",
          mode: "readonly",
          prompt: "Inspect repo and test depth-1 cap",
        });
        if (!roSpawn?.subagent?.id) throw new Error("ro_spawn_failed:" + JSON.stringify(roSpawn));

        const codeSpawn = await mcpClient.callTool("bf_subagent_spawn", {
          name: "Coder-Sub",
          role: "implementer",
          mode: "code",
          prompt: "Write src/task_a.ts in isolated child worktree",
        });
        if (!codeSpawn?.subagent?.id) throw new Error("code_spawn_failed:" + JSON.stringify(codeSpawn));

        const roWait = await mcpClient.callTool("bf_subagent_wait", { subagentId: roSpawn.subagent.id, timeoutMs: 25000 });
        const codeWait = await mcpClient.callTool("bf_subagent_wait", { subagentId: codeSpawn.subagent.id, timeoutMs: 25000 });
        if (roWait.timedOut || codeWait.timedOut) {
          throw new Error("subagent_wait_timed_out");
        }

        const roStatus = await mcpClient.callTool("bf_subagent_status", { subagentId: roSpawn.subagent.id });
        if (!String(roStatus.latestOutput ?? "").includes("subagent_max_depth_exceeded")) {
          throw new Error("missing_depth_cap_proof:" + String(roStatus.latestOutput));
        }

        await mcpClient.callTool("bf_subagent_kill", { subagentId: roSpawn.subagent.id });

        const applyRes = await mcpClient.callTool("bf_subagent_apply_patch", { subagentId: codeSpawn.subagent.id });
        if (!applyRes?.ok || !Array.isArray(applyRes.changedFiles) || !applyRes.changedFiles.includes("src/task_a.ts")) {
          throw new Error("apply_patch_failed:" + JSON.stringify(applyRes));
        }

        emitUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tc_peer_a_1",
          title: "Terminal check & apply subagent patch",
          kind: "execute",
          status: "completed",
          rawOutput: "INTERNAL_TERMINAL_LOG_MUST_NOT_LEAK_TO_CHAT_META",
        });
        emitUpdate({
          sessionUpdate: "agent_message_chunk",
          content: [{ type: "text", text: "Applied initial Task A patch from Coder-Sub." }],
        });
        sendResult(msg.id, { stopReason: "end_turn" });
        return;
      }

      if (promptText.includes("Task B")) {
        if (!mcpClient) throw new Error("missing_mcp_client_in_peer_b");
        mkdirSync(join(sessionCwd, "src"), { recursive: true });
        writeFileSync(
          join(sessionCwd, "src", "task_b.ts"),
          "export function multiply(a: number, b: number): number {\\n  return a * b;\\n}\\n",
          "utf8",
        );
        emitUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tc_peer_b_1",
          title: "Write src/task_b.ts",
          kind: "edit",
          status: "completed",
          rawOutput: "INTERNAL_TERMINAL_LOG_TASK_B_MUST_NOT_LEAK",
        });
        await mcpClient.callTool("bf_handoff_write", {
          taskId,
          title: "Task B Complete",
          summary: "Implemented multiply(a, b) in src/task_b.ts.",
          changedFiles: ["src/task_b.ts"],
          testsRun: ["bun verify.ts (pass)"],
        });
        emitUpdate({
          sessionUpdate: "agent_message_chunk",
          content: [{ type: "text", text: "Implemented Task B multiply()." }],
        });
        sendResult(msg.id, { stopReason: "end_turn" });
        return;
      }

      emitUpdate({
        sessionUpdate: "agent_message_chunk",
        content: [{ type: "text", text: "ACP noop turn." }],
      });
      sendResult(msg.id, { stopReason: "end_turn" });
    } catch (err) {
      sendError(msg.id, err instanceof Error ? err.message : String(err));
    }
  }
}

let queue = Promise.resolve();
process.stdin.on("data", (chunk) => {
  buf += String(chunk);
  let nl: number;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    queue = queue.then(() => handleMessage(msg));
  }
});
`,
        "utf8",
      );

      const verifierPrompts: Array<{ sys: string; usr: string }> = [];
      let delegatedProjectId = "";

      const mockHttpServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (req) => {
          const url = new URL(req.url);
          if (url.pathname !== "/v1/chat/completions") {
            return new Response("Not Found", { status: 404 });
          }
          const body = (await req.json()) as {
            model: string;
            messages: Array<{ role: string; content: string | null; tool_call_id?: string }>;
          };
          const sys = body.messages.find((m) => m.role === "system")?.content ?? "";
          if (sys.includes("Supermemory Consolidation Engine")) {
            return new Response(
              encodeOpenAiSse({ text: JSON.stringify({ newFacts: [] }) }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          let lastUserIdx = -1;
          for (let i = body.messages.length - 1; i >= 0; i -= 1) {
            if (body.messages[i]?.role === "user") {
              lastUserIdx = i;
              break;
            }
          }
          const lastUser = String(body.messages[lastUserIdx]?.content ?? "");
          const toolOutputsAfterUser = body.messages
            .slice(lastUserIdx + 1)
            .filter((m) => m.role === "tool")
            .map((m) => String(m.content ?? ""));

          if (body.model === "mock-mgr-smart") {
            if (lastUser.includes("Team Lead Report received")) {
              return new Response(
                encodeOpenAiSse({
                  text: "Calm Executive Briefing: Task A and Task B both passed independent verification and are ready for your review & squash merge.",
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }
            if (toolOutputsAfterUser.length === 0) {
              const pidMatch = /<active_project_context id="([^"]+)"/.exec(lastUser);
              const pid = pidMatch?.[1] || delegatedProjectId;
              return new Response(
                encodeOpenAiSse({
                  toolCalls: [
                    {
                      id: "call_mgr_delegate",
                      name: "bf_team_delegate",
                      args: {
                        projectId: pid,
                        goal: "Implement Task A and Task B cleanly using subagents and verify both.",
                        autonomyLevel: "high",
                        reasoningEffort: "medium",
                      },
                    },
                  ],
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }
            return new Response(
              encodeOpenAiSse({
                text: "Delegated the engineering goal to the Team Lead.",
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }

          if (body.model === "mock-pm-smart") {
            if (lastUser.includes("Autonomous Goal Check")) {
              if (toolOutputsAfterUser.length === 0) {
                const verifiedIds = [...lastUser.matchAll(/- \[verified\] .*?\((tsk_[^)]+)\)/g)].map((m) => m[1]!);
                return new Response(
                  encodeOpenAiSse({
                    toolCalls: [
                      {
                        id: "call_pm_report",
                        name: "bf_report_to_manager",
                        args: {
                          status: "completed",
                          summary: "Task A passed after retry and Task B passed on first run.",
                          verifiedTaskIds: verifiedIds,
                        },
                      },
                    ],
                  }),
                  { headers: { "content-type": "text/event-stream" } },
                );
              }
              return new Response(
                encodeOpenAiSse({ text: "Reported verified completion back to Main Manager." }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }

            if (toolOutputsAfterUser.length === 0) {
              return new Response(
                encodeOpenAiSse({
                  toolCalls: [
                    {
                      id: "call_pm_batch",
                      name: "bf_task_create_batch",
                      args: {
                        tasks: [
                          {
                            key: "taskA",
                            title: "Task A: Implement add()",
                            specMd: "Create src/task_a.ts exporting add(a, b) = a + b using depth-1 subagents.",
                            priority: 1,
                          },
                          {
                            key: "taskB",
                            title: "Task B: Implement multiply()",
                            specMd: "Create src/task_b.ts exporting multiply(a, b) = a * b.",
                            priority: 2,
                            dependsOnKeys: ["taskA"],
                          },
                        ],
                      },
                    },
                    {
                      id: "call_pm_spawn",
                      name: "bf_bot_spawn",
                      args: {
                        name: "Peer-Lead-Coder",
                        role: "coder",
                        autonomyLevel: "high",
                      },
                    },
                  ],
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }

            if (toolOutputsAfterUser.length === 2) {
              const batchOut = JSON.parse(toolOutputsAfterUser[0]!) as { keyToTaskId: Record<string, string> };
              const spawnOut = JSON.parse(toolOutputsAfterUser[1]!) as { agent: { id: string } };
              return new Response(
                encodeOpenAiSse({
                  toolCalls: [
                    {
                      id: "call_pm_dispatch",
                      name: "bf_task_dispatch",
                      args: {
                        taskId: batchOut.keyToTaskId.taskA,
                        agentId: spawnOut.agent.id,
                        autonomous: true,
                      },
                    },
                  ],
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }

            return new Response(
              encodeOpenAiSse({ text: "Created 2-task DAG and dispatched Task A autonomously." }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }

          if (body.model === "mock-ver-flagship") {
            verifierPrompts.push({ sys, usr: lastUser });
            if (lastUser.includes("One or more objective checks already failed")) {
              return new Response(
                encodeOpenAiSse({
                  text: "- FINDING: Objective check cmd:unit-check failed.\nVERDICT: FAIL",
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }
            return new Response(
              encodeOpenAiSse({
                text: "Independent review confirmed diff and passing unit checks.\nVERDICT: PASS",
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }

          return new Response(encodeOpenAiSse({ text: "Unexpected model: " + body.model }), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      mockServers.push(mockHttpServer);

      const httpBase = `http://127.0.0.1:${mockHttpServer.port}/v1`;
      const cfg = makeBaseTestConfig(rootDir, {
        "mock-http": {
          runtime: "native_http",
          protocol: "openai_compatible",
          baseUrl: httpBase,
          models: {
            "mgr-smart": { id: "mock-mgr-smart", capabilities: ["reasoning", "planning"], tier: "flagship" },
            "pm-smart": { id: "mock-pm-smart", capabilities: ["reasoning", "planning"], tier: "flagship" },
          },
        },
        "mock-acp": {
          runtime: "acp_stdio",
          command: "bun",
          args: ["run", acpMockPath],
          models: {
            "acp-coder": { id: "acp-coder", capabilities: ["coding_deep", "coding", "sidekick"], tier: "flagship" },
          },
        },
        "mock-verifier": {
          runtime: "native_http",
          protocol: "openai_compatible",
          baseUrl: httpBase,
          models: {
            "ver-flagship": { id: "mock-ver-flagship", capabilities: ["review", "reasoning"], tier: "flagship" },
          },
        },
      });
      cfg.routing.defaultsByIntent.meta_orchestrator = { provider: "mock-http", model: "mgr-smart" };
      cfg.routing.defaultsByIntent.project_manager = { provider: "mock-http", model: "pm-smart" };
      cfg.routing.defaultsByIntent.coding_parallel = { provider: "mock-acp", model: "acp-coder" };
      cfg.routing.defaultsByIntent.coding_deep = { provider: "mock-acp", model: "acp-coder" };
      cfg.routing.defaultsByIntent.sidekick = { provider: "mock-acp", model: "acp-coder" };
      cfg.routing.defaultsByIntent.verifier_default = { provider: "mock-verifier", model: "ver-flagship" };
      cfg.routing.defaultsByIntent.memory_dreaming = { provider: "mock-http", model: "mgr-smart" };
      cfg.memory.dreaming.mode = "dynamic";
      cfg.memory.dreaming.debounceSeconds = 120;
      cfg.guardrails.maxTaskAutoRetries = 2;
      saveHubConfig(join(rootDir, "system", "config.json"), cfg);

      const app = startBotFactoryDaemon({ rootDir, port: 0 });
      runningApps.push(app);

      const token = readFileSync(join(rootDir, "system", ".daemon-token"), "utf8").trim();
      const ws = openAuthedWs(app.url.replace("http://", "ws://") + "/ws", token);
      await new Promise<void>((res) => (ws.onopen = () => res()));

      const chatEvents: Array<{ topic: string; eventType?: string; data?: any }> = [];
      ws.addEventListener("message", (ev) => {
        const parsed = JSON.parse(String(ev.data));
        if (parsed.kind === "event" && parsed.topic === "chat:meta") {
          chatEvents.push(parsed);
        }
      });

      const chatSnapP = waitForWsEvent(ws, (m) => m.kind === "snapshot" && m.topic === "chat:meta");
      ws.send(JSON.stringify({ kind: "subscribe", topic: "chat:meta" }));
      await chatSnapP;

      const { project } = app.engine.executeCommand({
        commandId: "p3_auto_proj",
        type: "project.create",
        name: "Autonomous Lab",
        externalRepoPath: repoDir,
        seedDemoArtifacts: false,
        verifyChecks: [{ name: "unit-check", cmd: "bun verify.ts", timeoutMs: 15_000 }],
      }) as { project: { id: string; repoPath: string; rootPath: string } };
      delegatedProjectId = project.id;

      // Kick off 3-tier autonomous execution via Main Manager chat.send
      app.engine.executeCommand({
        commandId: "p3_auto_chat_1",
        type: "chat.send",
        projectId: project.id,
        text: "Please delegate implementing Task A and Task B to the team.",
      });

      await waitUntil(() => {
        const goals = app.engine.getAutonomyLoop().listGoals(project.id);
        const goalDone = goals.length > 0 && goals[0]!.status === "completed";
        const hasExecutiveSummary = chatEvents.some(
          (e) =>
            e.eventType === "chat.message" &&
            typeof e.data?.content === "string" &&
            e.data.content.includes("Calm Executive Briefing"),
        );
        return goalDone && hasExecutiveSummary;
      }, 25_000, "autonomous_dag_completion_and_meta_report");
      await app.core.drainOutboxOnce();
      await syncWs(ws);

      // 1. Verify DAG tasks & auto-retry behavior
      const tasks = app.db.listTasks(project.id);
      const taskA = tasks.find((t) => t.title.includes("Task A"))!;
      const taskB = tasks.find((t) => t.title.includes("Task B"))!;
      expect(taskA).toBeTruthy();
      expect(taskB).toBeTruthy();
      expect(taskB.dependsOn).toEqual([taskA.id]);
      expect(taskA.status).toBe("verified");
      expect(taskA.autoRetryCount).toBe(1);
      expect(taskB.status).toBe("verified");
      expect(taskB.autoRetryCount).toBe(0);

      // Verify real ACP peer execution did NOT create .bf-task-*.md
      const peerA = app.db.getAgent(taskA.assignedAgentId!)!;
      const peerB = app.db.getAgent(taskB.assignedAgentId!)!;
      expect(peerA.worktreePath).toBeTruthy();
      expect(peerB.worktreePath).toBeTruthy();
      expect(existsSync(join(peerA.worktreePath!, `.bf-task-${taskA.id}.md`))).toBe(false);
      expect(existsSync(join(peerB.worktreePath!, `.bf-task-${taskB.id}.md`))).toBe(false);

      // 2. Verify depth-1 subagents & patch apply
      const allAgents = app.db.listAgents(project.id);
      const roSub = allAgents.find((a) => a.scope === "sidekick" && a.name === "Scout-RO")!;
      const codeSub = allAgents.find((a) => a.scope === "sidekick" && a.name === "Coder-Sub")!;
      expect(roSub).toBeTruthy();
      expect(codeSub).toBeTruthy();
      expect(roSub.depth).toBe(1);
      expect(roSub.subagentMode).toBe("readonly");
      expect(codeSub.depth).toBe(1);
      expect(codeSub.subagentMode).toBe("code");
      expect(codeSub.status).toBe("stopped");
      expect(codeSub.worktreePath).toBeNull();

      const roTimeline = app.db.listAgentTimeline(roSub.id);
      expect(roTimeline.some((m) => m.content.includes("subagent_max_depth_exceeded"))).toBe(true);
      const peerATimeline = app.db.listAgentTimeline(peerA.id);
      expect(peerATimeline.some((m) => m.title?.includes("Applied subagent patch (Coder-Sub)"))).toBe(true);

      // 3. Verify IndependentVerifier ran real verifyChecks + inspected real git diff
      const verificationsA = app.db.listVerifications({ targetKind: "task", targetId: taskA.id });
      expect(verificationsA.length).toBe(2);
      const sortedA = [...verificationsA].sort((a, b) => a.createdAt - b.createdAt);
      expect(sortedA[0]!.verdict).toBe("fail");
      expect(sortedA[0]!.checks.find((c) => c.name === "cmd:unit-check")?.passed).toBe(false);
      expect(sortedA[1]!.verdict).toBe("pass");
      expect(sortedA[1]!.checks.find((c) => c.name === "cmd:unit-check")?.passed).toBe(true);
      expect(sortedA[1]!.crossFamily).toBe(true);

      const verificationsB = app.db.listVerifications({ targetKind: "task", targetId: taskB.id });
      expect(verificationsB.length).toBe(1);
      expect(verificationsB[0]!.verdict).toBe("pass");
      expect(verificationsB[0]!.checks.find((c) => c.name === "cmd:unit-check")?.passed).toBe(true);

      expect(verifierPrompts.some((p) => p.usr.includes("## Worktree Git Diff") && p.usr.includes("return a - b"))).toBe(true);
      expect(verifierPrompts.some((p) => p.usr.includes("## Worktree Git Diff") && p.usr.includes("return a + b"))).toBe(true);
      expect(verifierPrompts.some((p) => p.usr.includes("## Worktree Git Diff") && p.usr.includes("return a * b"))).toBe(true);

      // 4. Verify calm chat:meta report + ZERO tool/terminal log leakage
      expect(chatEvents.some((e) => e.eventType === "chat.artifact_card" && e.data?.kind === "delegation")).toBe(true);
      expect(chatEvents.some((e) => e.eventType === "chat.artifact_card" && e.data?.kind === "review_merge")).toBe(true);
      expect(
        chatEvents.some(
          (e) => e.eventType === "chat.message" && String(e.data?.content ?? "").includes("Calm Executive Briefing"),
        ),
      ).toBe(true);

      const forbiddenChatEvents = chatEvents.filter(
        (e) =>
          e.eventType === "timeline.item" ||
          e.eventType === "tool.result" ||
          e.eventType === "verification.completed" ||
          e.eventType?.startsWith("debate.") ||
          String(e.data?.content ?? "").includes("INTERNAL_TERMINAL_LOG"),
      );
      expect(forbiddenChatEvents).toHaveLength(0);
      expect(app.engine.getMetaChatSnapshot().messages.every((m) => m.kind === "message")).toBe(true);

      // 5. Human executes task.merge (squash) on taskA -> verify commit on main, cleanup & preMergeRef
      const peerAWtPath = peerA.worktreePath!;
      const peerABranch = peerA.worktreeBranch!;
      const baseHeadBefore = gitSync(["rev-parse", "HEAD"], repoDir).stdout;

      app.engine.executeCommand({
        commandId: "p3_auto_merge_a",
        type: "task.merge",
        projectId: project.id,
        taskId: taskA.id,
        strategy: "squash",
        commitMessage: "feat: squash taskA into main",
      });
      await app.core.drainOutboxOnce();

      expect(app.db.getTask(taskA.id)!.status).toBe("merged");
      expect(app.db.getTask(taskA.id)!.worktreeBranch).toBeNull();
      expect(app.db.getAgent(peerA.id)!.worktreePath).toBeNull();
      expect(app.db.getAgent(peerA.id)!.worktreeBranch).toBeNull();
      expect(existsSync(peerAWtPath)).toBe(false);
      expect(gitSync(["show-ref", "--verify", "--quiet", `refs/heads/${peerABranch}`], repoDir, true).code).not.toBe(0);

      const preMergeRefs = gitSync(
        ["for-each-ref", "--format=%(refname) %(objectname)", "refs/bot-factory/pre-merge/"],
        repoDir,
      ).stdout;
      expect(preMergeRefs).toContain("refs/bot-factory/pre-merge/");
      expect(preMergeRefs).toContain(baseHeadBefore);

      expect(gitSync(["log", "-1", "--format=%s"], repoDir).stdout).toBe("feat: squash taskA into main");
      expect(readFileSync(join(repoDir, "src", "task_a.ts"), "utf8")).toContain("return a + b;");
      const checkMain = Bun.spawnSync(["bun", "verify.ts"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
      expect(checkMain.exitCode).toBe(0);

      ws.close();
    },
    35_000,
  );

  it("enforces mergeBotWorktree edge cases: base_repo_dirty, merge_commit, and merge_conflict clean abort", async () => {
    const projectRoot = makeTempRoot("bf-p3-merge-root-");
    const repoDir = join(projectRoot, "repo");
    mkdirSync(repoDir, { recursive: true });
    initTempGitRepo(repoDir, {
      "README.md": "# Merge Edge Cases\n",
      "shared.txt": "line 1 base\n",
    });

    // 1. base_repo_dirty refusal + merge_commit success
    const wt1 = createBotWorktree({
      projectRoot,
      repoPath: repoDir,
      agentId: "bot_m1",
      taskId: "tsk_m1",
    });
    writeFileSync(join(wt1.worktreePath, "feature.txt"), "implemented via merge_commit\n", "utf8");

    const dirtyMarker = join(repoDir, "uncommitted.txt");
    writeFileSync(dirtyMarker, "dirty base repo", "utf8");
    const dirtyRes = await mergeBotWorktree({
      repoPath: repoDir,
      worktreePath: wt1.worktreePath,
      branch: wt1.branch,
      strategy: "squash",
      commitMessage: "Should refuse dirty base",
    });
    expect(dirtyRes.ok).toBe(false);
    expect(dirtyRes.error).toBe("base_repo_dirty");
    expect(dirtyRes.cleanedWorktree).toBe(false);
    expect(existsSync(wt1.worktreePath)).toBe(true);

    rmSync(dirtyMarker);
    const mcRes = await mergeBotWorktree({
      repoPath: repoDir,
      worktreePath: wt1.worktreePath,
      branch: wt1.branch,
      strategy: "merge_commit",
      commitMessage: "merge: bring feature.txt with no-ff",
    });
    expect(mcRes.ok).toBe(true);
    expect(mcRes.cleanedWorktree).toBe(true);
    expect(mcRes.preMergeRef).toMatch(/^refs\/bot-factory\/pre-merge\//);
    expect(mcRes.mergeCommitSha).toBeTruthy();
    expect(existsSync(wt1.worktreePath)).toBe(false);
    expect(existsSync(join(repoDir, "feature.txt"))).toBe(true);
    expect(gitSync(["show-ref", "--verify", "--quiet", `refs/heads/${wt1.branch}`], repoDir, true).code).not.toBe(0);

    // Confirm --no-ff merge commit actually has 2 parents
    const parentsLine = gitSync(["rev-list", "--parents", "-n", "1", "HEAD"], repoDir).stdout;
    expect(parentsLine.split(/\s+/)).toHaveLength(3);
    expect(gitSync(["log", "-1", "--format=%s"], repoDir).stdout).toBe("merge: bring feature.txt with no-ff");

    // 2. merge_conflict clean abort (for both merge_commit and squash)
    const wtConflict = createBotWorktree({
      projectRoot,
      repoPath: repoDir,
      agentId: "bot_m2",
      taskId: "tsk_m2",
    });
    writeFileSync(join(wtConflict.worktreePath, "shared.txt"), "bot branch change\n", "utf8");

    writeFileSync(join(repoDir, "shared.txt"), "main branch conflicting change\n", "utf8");
    gitSync(["add", "shared.txt"], repoDir);
    gitSync(["commit", "-m", "main: conflicting edit"], repoDir);
    const headBeforeConflict = gitSync(["rev-parse", "HEAD"], repoDir).stdout;

    for (const strategy of ["merge_commit", "squash"] as const) {
      const conflictRes = await mergeBotWorktree({
        repoPath: repoDir,
        worktreePath: wtConflict.worktreePath,
        branch: wtConflict.branch,
        strategy,
        commitMessage: `Conflict attempt (${strategy})`,
      });
      expect(conflictRes.ok).toBe(false);
      expect(conflictRes.error).toBe("merge_conflict");
      expect(conflictRes.conflicts).toContain("shared.txt");
      expect(conflictRes.cleanedWorktree).toBe(false);
      expect(conflictRes.preMergeRef).toMatch(/^refs\/bot-factory\/pre-merge\//);
      expect(gitSync(["rev-parse", "HEAD"], repoDir).stdout).toBe(headBeforeConflict);
      expect(gitSync(["status", "--porcelain"], repoDir).stdout).toBe("");
      expect(readFileSync(join(repoDir, "shared.txt"), "utf8")).toBe("main branch conflicting change\n");
    }
    expect(existsSync(wtConflict.worktreePath)).toBe(true);
  });

  it("handles checkpoint.rollback happy path (restores turn-1 tracked file and removes post-checkpoint untracked files) and bot.resume", async () => {
    rememberEnv("BOT_FACTORY_OFFLINE_MOCK");
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";

    const rootDir = makeTempRoot("bf-p3-cp-");
    const repoDir = makeTempRoot("bf-p3-cp-repo-");
    initTempGitRepo(repoDir, {
      "src/app.txt": "v0-initial\n",
    });

    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    const { project } = app.engine.executeCommand({
      commandId: "cp_proj",
      type: "project.create",
      name: "Checkpoint Lab",
      externalRepoPath: repoDir,
      seedDemoArtifacts: false,
    }) as { project: { id: string } };

    const peer = (
      app.engine.executeCommand({
        commandId: "cp_bot",
        type: "bot.spawn",
        projectId: project.id,
        name: "Rollback-Bot",
        scope: "peer",
      }) as { agent: { id: string; activeSessionId: string; worktreePath: string } }
    ).agent;

    // Simulate tracked edit made during Turn 1 before checkpoint capture
    writeFileSync(join(peer.worktreePath, "src/app.txt"), "v1-turn1-tracked\n", "utf8");

    const task1 = (
      app.engine.executeCommand({
        commandId: "cp_t1",
        type: "task.create",
        projectId: project.id,
        title: "Turn 1 tracked mutation",
        specMd: "Complete turn 1",
        priority: 1,
      }) as { task: { id: string } }
    ).task;

    app.engine.executeCommand({
      commandId: "cp_d1",
      type: "task.dispatch",
      projectId: project.id,
      taskId: task1.id,
      agentId: peer.id,
    });
    await app.core.drainOutboxOnce();

    const cpList = app.engine.executeCommand({
      commandId: "cp_list",
      type: "checkpoint.list",
      projectId: project.id,
      agentId: peer.id,
    }) as { checkpoints: Array<{ id: string; turnNum: number }> };
    expect(cpList.checkpoints).toHaveLength(1);
    expect(cpList.checkpoints[0]!.turnNum).toBe(1);

    // Post-checkpoint mutations: overwrite tracked file + create untracked file
    writeFileSync(join(peer.worktreePath, "src/app.txt"), "v2-post-checkpoint-corrupted\n", "utf8");
    const postUntracked = join(peer.worktreePath, "post-checkpoint-untracked.txt");
    const postNestedUntracked = join(peer.worktreePath, "scratch", "extra.txt");
    mkdirSync(join(peer.worktreePath, "scratch"), { recursive: true });
    writeFileSync(postUntracked, "should be deleted\n", "utf8");
    writeFileSync(postNestedUntracked, "nested should be deleted\n", "utf8");

    app.engine.executeCommand({
      commandId: "cp_rb",
      type: "checkpoint.rollback",
      projectId: project.id,
      checkpointId: cpList.checkpoints[0]!.id,
    });
    await app.core.drainOutboxOnce();

    expect(readFileSync(join(peer.worktreePath, "src/app.txt"), "utf8")).toBe("v1-turn1-tracked\n");
    expect(existsSync(postUntracked)).toBe(false);
    expect(existsSync(postNestedUntracked)).toBe(false);

    // bot.resume from paused and stopped states
    app.engine.executeCommand({ commandId: "cp_pause", type: "bot.pause", agentId: peer.id });
    await app.core.drainOutboxOnce();
    expect(app.db.getAgent(peer.id)!.status).toBe("paused");

    const resumedFromPause = app.engine.executeCommand({
      commandId: "cp_res_pause",
      type: "bot.resume",
      agentId: peer.id,
    }) as { status: string; sessionId: string };
    expect(resumedFromPause.status).toBe("idle");
    expect(app.db.getAgent(peer.id)!.status).toBe("idle");

    app.engine.executeCommand({ commandId: "cp_stop", type: "bot.stop", agentId: peer.id });
    await app.core.drainOutboxOnce();
    expect(app.db.getAgent(peer.id)!.status).toBe("stopped");

    const resumedFromStop = app.engine.executeCommand({
      commandId: "cp_res_stop",
      type: "bot.resume",
      agentId: peer.id,
    }) as { status: string; sessionId: string };
    expect(resumedFromStop.status).toBe("idle");
    expect(resumedFromStop.sessionId).not.toBe(peer.activeSessionId);

    // Confirm resumed bot can execute another task cleanly
    const task2 = (
      app.engine.executeCommand({
        commandId: "cp_t2",
        type: "task.create",
        projectId: project.id,
        title: "Post-resume task",
        specMd: "Execute after bot.resume",
        priority: 2,
      }) as { task: { id: string } }
    ).task;
    app.engine.executeCommand({
      commandId: "cp_d2",
      type: "task.dispatch",
      projectId: project.id,
      taskId: task2.id,
      agentId: peer.id,
    });
    await app.core.drainOutboxOnce();
    expect(app.db.getTask(task2.id)!.status).toBe("in_review");
  });

  it("enforces IndependentVerifier empty-diff fail-closed gate, check timeout tree kill, and secret scrubbing", async () => {
    rememberEnv("BOT_FACTORY_OFFLINE_MOCK");
    rememberEnv("BOT_FACTORY_TOKEN");
    delete process.env.BOT_FACTORY_OFFLINE_MOCK;
    process.env.BOT_FACTORY_TOKEN = "parent_daemon_token_must_not_leak";

    const rootDir = makeTempRoot("bf-p3-ver-");
    const repoDir = makeTempRoot("bf-p3-ver-repo-");
    const leakedSecret = "sk-test-verify-secret-value-987654";

    initTempGitRepo(repoDir, {
      "README.md": "# Verifier Edge Cases\n",
      "check-secret.ts": `console.log("CHECK_OUT secret=${leakedSecret} token=" + (process.env.BOT_FACTORY_TOKEN ?? "ABSENT"));
console.error("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.verifyPayload1234");
`,
      "sleep-child.ts": `setInterval(() => {}, 1000);\n`,
      "check-hang.ts": `Bun.spawn([process.execPath, "sleep-child.ts"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
setInterval(() => {}, 1000);
`,
    });

    // 1. Direct runProjectVerifyChecks: secret scrubbing + BOT_FACTORY_TOKEN isolation + timeout kill
    const scrubber = new SecretScrubber({ TEST_VERIFY_KEY: leakedSecret });
    const checkResults = await runProjectVerifyChecks(
      [
        { name: "scrub-and-env", cmd: "bun check-secret.ts", timeoutMs: 10_000 },
        { name: "hang-timeout", cmd: "bun check-hang.ts", timeoutMs: 250 },
      ],
      repoDir,
      scrubber,
    );
    expect(checkResults).toHaveLength(2);
    expect(checkResults[0]!.name).toBe("cmd:scrub-and-env");
    expect(checkResults[0]!.passed).toBe(true);
    expect(checkResults[0]!.detail).toContain("token=ABSENT");
    expect(checkResults[0]!.detail).not.toContain(leakedSecret);
    expect(checkResults[0]!.detail).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(checkResults[0]!.detail).toContain("[REDACTED_SECRET]");
    expect(checkResults[0]!.detail).toContain("Bearer [REDACTED_TOKEN]");

    expect(checkResults[1]!.name).toBe("cmd:hang-timeout");
    expect(checkResults[1]!.passed).toBe(false);
    expect(checkResults[1]!.detail).toContain("timed out after 250ms");

    // 2. Empty-diff fail-closed gate via real IndependentVerifier + daemon
    const acpNoopPath = join(rootDir, "mock-acp-noop.ts");
    writeFileSync(
      acpNoopPath,
      `let buf = "";
process.stdin.setEncoding("utf8");
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
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "ext_noop" } }) + "\\n");
    } else if (msg.method === "session/prompt") {
      // Intentionally makes ZERO file changes inside worktree
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "Done without edits." }] } } }) + "\\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }) + "\\n");
    }
  }
});`,
      "utf8",
    );

    const mockVerifierServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        // Even if the LLM optimistically outputs VERDICT: PASS, objective check failures MUST force fail!
        return new Response(
          encodeOpenAiSse({
            text: `Echo secret ${leakedSecret}\n- FINDING: No real code diff present.\nVERDICT: PASS`,
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    mockServers.push(mockVerifierServer);

    const cfg = makeBaseTestConfig(rootDir, {
      "mock-acp-noop": {
        runtime: "acp_stdio",
        command: "bun",
        args: ["run", acpNoopPath],
        models: { "noop-1": { id: "noop-1", capabilities: ["coding"], tier: "fast" } },
      },
      "mock-ver": {
        runtime: "native_http",
        protocol: "openai_compatible",
        baseUrl: `http://127.0.0.1:${mockVerifierServer.port}/v1`,
        models: { "ver-1": { id: "ver-1", capabilities: ["review"], tier: "flagship" } },
      },
    });
    cfg.routing.defaultsByIntent.coding_parallel = { provider: "mock-acp-noop", model: "noop-1" };
    cfg.routing.defaultsByIntent.verifier_default = { provider: "mock-ver", model: "ver-1" };
    cfg.routing.defaultsByIntent.memory_dreaming = { provider: "mock-ver", model: "ver-1" };
    cfg.memory.dreaming.mode = "dynamic";
    cfg.memory.dreaming.debounceSeconds = 120;
    saveHubConfig(join(rootDir, "system", "config.json"), cfg);
    writeFileSync(join(rootDir, "system", "secrets.env"), `VERIFY_LEAK_TEST=${leakedSecret}\n`, "utf8");

    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    const { project } = app.engine.executeCommand({
      commandId: "ver_empty_proj",
      type: "project.create",
      name: "Verifier Gate Lab",
      externalRepoPath: repoDir,
      seedDemoArtifacts: false,
      verifyChecks: [{ name: "scrub-ok", cmd: "bun check-secret.ts", timeoutMs: 10_000 }],
    }) as { project: { id: string } };

    const peer = (
      app.engine.executeCommand({
        commandId: "ver_empty_bot",
        type: "bot.spawn",
        projectId: project.id,
        name: "Noop-Peer",
        scope: "peer",
        provider: "mock-acp-noop",
        model: "noop-1",
      }) as { agent: { id: string } }
    ).agent;

    const emptyTask = (
      app.engine.executeCommand({
        commandId: "ver_empty_task",
        type: "task.create",
        projectId: project.id,
        title: "Implement auth middleware",
        specMd: "Must edit src/auth.ts in worktree; empty diff must fail verification.",
        priority: 1,
      }) as { task: { id: string } }
    ).task;

    app.engine.executeCommand({
      commandId: "ver_empty_disp",
      type: "task.dispatch",
      projectId: project.id,
      taskId: emptyTask.id,
      agentId: peer.id,
    });
    await app.core.drainOutboxOnce();
    expect(app.db.getTask(emptyTask.id)!.status).toBe("in_review");

    app.engine.executeCommand({
      commandId: "ver_empty_verify",
      type: "task.verify",
      projectId: project.id,
      taskId: emptyTask.id,
    });
    await app.core.drainOutboxOnce();

    expect(app.db.getTask(emptyTask.id)!.status).toBe("blocked");
    const reports = app.db.listVerifications({ targetKind: "task", targetId: emptyTask.id });
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report.verdict).toBe("fail");
    const wtEvidence = report.checks.find((c) => c.name === "worktree_evidence");
    expect(wtEvidence?.passed).toBe(false);
    expect(wtEvidence?.detail).toContain("worktree has zero changed files (fail-closed)");

    const cmdCheck = report.checks.find((c) => c.name === "cmd:scrub-ok");
    expect(cmdCheck?.passed).toBe(true);
    expect(cmdCheck?.detail).not.toContain(leakedSecret);
    expect(report.summary).not.toContain(leakedSecret);
    expect(report.findings.join("\n")).not.toContain(leakedSecret);
  });
});
