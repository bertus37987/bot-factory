import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { HubConfig } from "@bot-factory/shared";
import { SecretScrubber } from "../config";
import { isPathStrictlyWithinRoot } from "./nativeHttpRuntime";
import type { AgentRuntime, NormalizedAgentEvent, RuntimeSessionHandle, RuntimeSessionSpec, TurnInput } from "./types";

export interface AcpPermissionOption {
  optionId: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  name?: string;
}

export interface AcpPermissionRequestParams {
  toolCall?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    locations?: Array<{ path?: string }>;
  };
  options?: AcpPermissionOption[];
}

export interface AcpPermissionResolution {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
  escalated: boolean;
  reason: string;
}

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-[a-z]*[rf][a-z]*\b/i,
  /\b(del|erase|rmdir|rd)\s+\/[sqf]/i,
  /\bremove-item\b.*-recurse/i,
  /\bgit\s+push\s+(-f|--force)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bformat\s+[a-z]:/i,
  /secrets\.env/i,
];

const SAFE_CHILD_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "COMSPEC",
  "ComSpec",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "LANG",
  "TERM",
];

export function buildMinimalAcpEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) out[key] = val;
  }
  return out;
}

/**
 * Pure deterministic ACP permission resolver (research/devin-ux.md):
 * - Empty options or no allow option -> always cancelled.
 * - Destructive commands or paths escaping assigned worktree cwd (including UNC paths on Windows) -> escalated / cancelled.
 * - Safe in-worktree read/edit/search -> auto-selects first allow_once/allow_always option.
 */
export function resolveAcpPermission(
  params: AcpPermissionRequestParams,
  worktreeCwd: string,
  enforceWorktreeBoundary = true,
): AcpPermissionResolution {
  const options = params.options ?? [];
  const allowOpt = options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
  if (!allowOpt) {
    return { outcome: { outcome: "cancelled" }, escalated: false, reason: "no_allow_option_offered" };
  }

  const title = params.toolCall?.title ?? "";
  const kind = (params.toolCall?.kind ?? "").toLowerCase();
  for (const rx of DESTRUCTIVE_PATTERNS) {
    if (rx.test(title)) {
      return { outcome: { outcome: "cancelled" }, escalated: true, reason: `destructive_pattern_blocked:${title.slice(0, 80)}` };
    }
  }

  if (enforceWorktreeBoundary && params.toolCall?.locations) {
    for (const loc of params.toolCall.locations) {
      if (!loc.path) continue;
      const check = isPathStrictlyWithinRoot(worktreeCwd, loc.path);
      if (!check.ok) {
        return {
          outcome: { outcome: "cancelled" },
          escalated: true,
          reason: `path_outside_worktree:${loc.path}`,
        };
      }
    }
  }

  if (kind === "delete") {
    return { outcome: { outcome: "cancelled" }, escalated: true, reason: "delete_requires_human_approval" };
  }

  return { outcome: { outcome: "selected", optionId: allowOpt.optionId }, escalated: false, reason: "auto_approved_in_worktree" };
}

interface PendingRpc {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface ActiveAcpProcess {
  spec: RuntimeSessionSpec;
  proc: ReturnType<typeof Bun.spawn>;
  externalSessionId: string;
  nextClientReqId: number;
  pendingClientRequests: Map<number, PendingRpc>;
  pendingServerPermissionIds: Set<number | string>;
  eventQueue: NormalizedAgentEvent[];
  eventWaiter: (() => void) | null;
  activeTurnTimeoutReset: (() => void) | null;
  turnMutex: Promise<void>;
  handshakeComplete: boolean;
  stopping: boolean;
  closed: boolean;
}

function buildSpawnCommand(command: string, args: string[]): string[] {
  if (process.platform === "win32") {
    const resolved = Bun.which(command);
    if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
      return ["cmd.exe", "/c", resolved, ...args];
    }
  }
  return [command, ...args];
}

export class AcpSubprocessRuntime implements AgentRuntime {
  public readonly kind = "acp_stdio" as const;
  private readonly active = new Map<string, ActiveAcpProcess>();
  private readonly requestTimeoutMs: number;
  private onSessionExit?: (sessionId: string) => void;

  constructor(
    private readonly config: HubConfig,
    private readonly logsDir: string,
    private readonly scrubber: SecretScrubber,
    opts?: { requestTimeoutMs?: number; onSessionExit?: (sessionId: string) => void },
  ) {
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? (config.guardrails.permissionRequestTimeoutSeconds ?? 120) * 1000;
    this.onSessionExit = opts?.onSessionExit;
  }

  public setOnSessionExit(handler: ((sessionId: string) => void) | undefined): void {
    this.onSessionExit = handler;
  }

  public isSessionAlive(sessionId: string): boolean {
    const state = this.active.get(sessionId);
    if (!state || state.stopping || state.closed) return false;
    return state.proc.exitCode === null && !state.proc.killed;
  }

  public getActiveCount(): number {
    return this.active.size;
  }

  public async startSession(spec: RuntimeSessionSpec): Promise<RuntimeSessionHandle> {
    const providerCfg = this.config.providers[spec.provider];
    if (!providerCfg || providerCfg.runtime !== "acp_stdio" || !providerCfg.command) {
      throw new Error(`Invalid ACP provider configuration: ${spec.provider}`);
    }

    const logFile = `${this.logsDir}/${spec.agentId}-acp-stderr.log`;
    mkdirSync(dirname(logFile), { recursive: true });

    const proc = Bun.spawn(buildSpawnCommand(providerCfg.command, providerCfg.args ?? []), {
      cwd: spec.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: buildMinimalAcpEnv(),
    });

    const state: ActiveAcpProcess = {
      spec,
      proc,
      externalSessionId: "",
      nextClientReqId: 1,
      pendingClientRequests: new Map(),
      pendingServerPermissionIds: new Set(),
      eventQueue: [],
      eventWaiter: null,
      activeTurnTimeoutReset: null,
      turnMutex: Promise.resolve(),
      handshakeComplete: false,
      stopping: false,
      closed: false,
    };

    this.active.set(spec.sessionId, state);
    void this.pumpStderr(state, logFile);
    const stdoutDone = this.pumpStdout(state);

    void proc.exited.then(async () => {
      const removed = this.removeActiveOnUnexpectedExit(state);
      if (state.stopping) return;
      if (removed && state.handshakeComplete) {
        try {
          this.onSessionExit?.(spec.sessionId);
        } catch {
          // ignore listener errors
        }
      }
      await Promise.race([stdoutDone, new Promise<void>((r) => setTimeout(r, 100))]);
      if (!state.closed && !state.stopping) {
        state.closed = true;
        this.failPendingOnUnexpectedExit(state);
      }
    });

    const handshakeTimeoutMs = Math.min(30_000, this.requestTimeoutMs);
    try {
      await this.sendClientRequest(
        state,
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "bot-factory-harness", version: "0.1.0" },
        },
        handshakeTimeoutMs,
      );

      const newSessionRes = (await this.sendClientRequest(
        state,
        "session/new",
        {
          cwd: spec.cwd,
          mcpServers: spec.mcpServers ?? [],
        },
        handshakeTimeoutMs,
      )) as { sessionId?: string };

      state.externalSessionId = newSessionRes?.sessionId ?? spec.sessionId;
      state.handshakeComplete = true;
    } catch (err) {
      state.stopping = true;
      await this.terminateProcessTree(state);
      this.active.delete(spec.sessionId);
      throw err;
    }

    return {
      sessionId: spec.sessionId,
      agentId: spec.agentId,
      runtimeKind: "acp_stdio",
      pid: proc.pid ?? null,
      externalSessionId: state.externalSessionId,
    };
  }

  public async *sendTurn(handle: RuntimeSessionHandle, input: TurnInput): AsyncIterable<NormalizedAgentEvent> {
    const state = this.active.get(handle.sessionId);
    if (!state) {
      yield { type: "error", message: `ACP session not active: ${handle.sessionId}` };
      return;
    }

    // Serialize turns on the same ACP subprocess so JSON-RPC requests/notifications never interleave.
    const prevTurn = state.turnMutex;
    let releaseTurn!: () => void;
    const currentTurnDone = new Promise<void>((res) => {
      releaseTurn = res;
    });
    state.turnMutex = prevTurn.catch(() => {}).then(() => currentTurnDone);

    await prevTurn.catch(() => {});

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearTurnTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      state.activeTurnTimeoutReset = null;
    };

    let finished = false;
    let promptPromise: Promise<unknown> | null = null;

    try {
      const current = this.active.get(handle.sessionId);
      if (!current || current !== state || state.stopping || state.closed || state.proc.exitCode !== null) {
        yield { type: "error", message: `ACP session not active: ${handle.sessionId}` };
        return;
      }

      state.eventQueue.length = 0;

      const promptText = input.ephemeralContext ? `${input.ephemeralContext}\n\n${input.userText}` : input.userText;
      const reqId = state.nextClientReqId;
      promptPromise = this.sendClientRequest(state, "session/prompt", {
        sessionId: state.externalSessionId,
        prompt: [{ type: "text", text: promptText }],
      });

      let accumulated = "";

      const finishWithEvent = (evt: NormalizedAgentEvent) => {
        if (finished) return;
        finished = true;
        clearTurnTimer();
        this.pushEvent(state, evt);
      };

      const armTurnTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (finished) return;
          this.flushPendingPermissionsCancelled(state);
          try {
            this.writeJsonLine(state, {
              jsonrpc: "2.0",
              method: "session/cancel",
              params: { sessionId: state.externalSessionId },
            });
          } catch {
            // ignore if stdin closed
          }
          const pending = state.pendingClientRequests.get(reqId);
          if (pending) {
            if (pending.timer) clearTimeout(pending.timer);
            state.pendingClientRequests.delete(reqId);
            pending.reject(new Error(`acp_turn_timeout:${this.requestTimeoutMs}ms`));
          } else {
            finishWithEvent({ type: "error", message: `acp_turn_timeout:${this.requestTimeoutMs}ms` });
          }
        }, this.requestTimeoutMs);
      };

      state.activeTurnTimeoutReset = armTurnTimer;
      armTurnTimer();

      promptPromise
        .then(() => {
          finishWithEvent({ type: "done", finalText: accumulated });
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "acp_turn_paused") {
            finishWithEvent({ type: "done", finalText: accumulated || "[Turn paused by operator]" });
          } else {
            finishWithEvent({ type: "error", message: this.scrubber.scrub(msg) });
          }
        });

      while (!finished || state.eventQueue.length > 0) {
        if (state.eventQueue.length === 0) {
          await new Promise<void>((r) => {
            state.eventWaiter = r;
          });
          state.eventWaiter = null;
        }
        while (state.eventQueue.length > 0) {
          const evt = state.eventQueue.shift()!;
          if (evt.type === "text_delta") accumulated += evt.text;
          yield evt;
          if (evt.type === "done" || evt.type === "error") return;
        }
      }
    } finally {
      clearTurnTimer();
      state.eventWaiter = null;
      if (!finished && promptPromise) {
        finished = true;
        this.flushPendingPermissionsCancelled(state);
        try {
          this.writeJsonLine(state, {
            jsonrpc: "2.0",
            method: "session/cancel",
            params: { sessionId: state.externalSessionId },
          });
        } catch {
          // ignore if stdin closed
        }
        await Promise.race([promptPromise.catch(() => {}), new Promise<void>((r) => setTimeout(r, 1000))]);
      }
      releaseTurn();
    }
  }

  private flushPendingPermissionsCancelled(state: ActiveAcpProcess): void {
    for (const reqId of state.pendingServerPermissionIds) {
      try {
        this.writeJsonLine(state, { jsonrpc: "2.0", id: reqId, result: { outcome: { outcome: "cancelled" } } });
      } catch {
        // ignore if stdin already closed
      }
    }
    state.pendingServerPermissionIds.clear();
  }

  public async abort(handle: RuntimeSessionHandle, mode: "pause" | "hard_stop"): Promise<void> {
    const state = this.active.get(handle.sessionId);
    if (!state) return;

    // ACP spec requirement: flush pending permission requests with 'cancelled' before cancelling/closing.
    this.flushPendingPermissionsCancelled(state);

    if (mode === "pause") {
      try {
        this.writeJsonLine(state, {
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId: state.externalSessionId },
        });
      } catch {
        // ignore if stdin closed
      }
      // Resolve any in-flight session/prompt cleanly so paused turns don't leak into the queue later
      for (const [id, pending] of state.pendingClientRequests.entries()) {
        if (pending.method === "session/prompt") {
          if (pending.timer) clearTimeout(pending.timer);
          state.pendingClientRequests.delete(id);
          pending.reject(new Error("acp_turn_paused"));
        }
      }
      return;
    }

    state.stopping = true;
    await this.terminateProcessTree(state);
    this.active.delete(handle.sessionId);
  }

  public async closeSession(handle: RuntimeSessionHandle): Promise<void> {
    await this.abort(handle, "hard_stop");
  }

  public async shutdownAll(): Promise<void> {
    const entries = [...this.active.entries()];
    this.active.clear();
    await Promise.all(
      entries.map(async ([, state]) => {
        state.stopping = true;
        this.flushPendingPermissionsCancelled(state);
        await this.terminateProcessTree(state);
      }),
    );
  }

  public shutdownAllSync(): void {
    const entries = [...this.active.entries()];
    this.active.clear();
    for (const [, state] of entries) {
      state.stopping = true;
      this.flushPendingPermissionsCancelled(state);
      this.terminateProcessTreeSync(state);
    }
  }

  private terminateProcessTreeSync(state: ActiveAcpProcess): void {
    state.closed = true;
    const pid = state.proc.pid;
    try {
      if (state.proc.stdin && typeof state.proc.stdin !== "number") {
        state.proc.stdin.end();
      }
    } catch {
      // ignore
    }

    if (process.platform === "win32" && pid) {
      try {
        Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
      } catch {
        try {
          state.proc.kill();
        } catch {
          // ignore
        }
      }
    } else {
      try {
        state.proc.kill();
      } catch {
        // ignore
      }
    }

    for (const pending of state.pendingClientRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("acp_process_terminated"));
    }
    state.pendingClientRequests.clear();
  }

  private async terminateProcessTree(state: ActiveAcpProcess): Promise<void> {
    state.closed = true;
    const pid = state.proc.pid;
    try {
      if (state.proc.stdin && typeof state.proc.stdin !== "number") {
        state.proc.stdin.end();
      }
    } catch {
      // ignore
    }

    if (process.platform === "win32" && pid) {
      try {
        const killer = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
        await killer.exited;
      } catch {
        try {
          state.proc.kill();
        } catch {
          // ignore
        }
      }
    } else {
      try {
        state.proc.kill();
      } catch {
        // ignore
      }
    }

    for (const pending of state.pendingClientRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("acp_process_terminated"));
    }
    state.pendingClientRequests.clear();
  }

  private writeJsonLine(state: ActiveAcpProcess, msg: Record<string, unknown>): void {
    const line = `${JSON.stringify(msg).replace(/\r?\n/g, " ")}\n`;
    if (state.proc.stdin && typeof state.proc.stdin !== "number") {
      state.proc.stdin.write(line);
    }
  }

  private sendClientRequest(
    state: ActiveAcpProcess,
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const id = state.nextClientReqId++;
    return new Promise((resolveFn, rejectFn) => {
      const entry: PendingRpc = { method, resolve: resolveFn, reject: rejectFn };
      if (timeoutMs && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (state.pendingClientRequests.delete(id)) {
            rejectFn(new Error(`acp_request_timeout:${method}`));
          }
        }, timeoutMs);
      }
      state.pendingClientRequests.set(id, entry);
      try {
        this.writeJsonLine(state, { jsonrpc: "2.0", id, method, params });
      } catch (err) {
        if (entry.timer) clearTimeout(entry.timer);
        state.pendingClientRequests.delete(id);
        rejectFn(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private pushEvent(state: ActiveAcpProcess, evt: NormalizedAgentEvent): void {
    if (evt.type !== "done" && evt.type !== "error") {
      state.activeTurnTimeoutReset?.();
    }
    state.eventQueue.push(evt);
    if (state.eventWaiter) {
      const wake = state.eventWaiter;
      state.eventWaiter = null;
      wake();
    }
  }

  private async pumpStderr(state: ActiveAcpProcess, logFile: string): Promise<void> {
    if (!state.proc.stderr || typeof state.proc.stderr === "number") return;
    const reader = state.proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = this.scrubber.scrub(decoder.decode(value, { stream: true }));
        appendFileSync(logFile, text, "utf8");
      }
    } catch {
      // ignore on shutdown
    }
  }

  private removeActiveOnUnexpectedExit(state: ActiveAcpProcess): boolean {
    if (this.active.get(state.spec.sessionId) === state) {
      this.active.delete(state.spec.sessionId);
      return true;
    }
    return false;
  }

  private failPendingOnUnexpectedExit(state: ActiveAcpProcess): void {
    for (const pending of state.pendingClientRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("acp_subprocess_exited_unexpectedly"));
    }
    state.pendingClientRequests.clear();
    this.pushEvent(state, { type: "error", message: "acp_subprocess_exited_unexpectedly" });
  }

  private async pumpStdout(state: ActiveAcpProcess): Promise<void> {
    if (!state.proc.stdout || typeof state.proc.stdout === "number") return;
    const reader = state.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) this.handleInboundLine(state, line);
          nl = buffer.indexOf("\n");
        }
      }
    } catch {
      // ignore stream close
    } finally {
      if (!state.closed) {
        state.closed = true;
        if (!state.stopping) {
          this.failPendingOnUnexpectedExit(state);
        }
      }
      if (!state.stopping) {
        const removed = this.removeActiveOnUnexpectedExit(state);
        if (removed && state.handshakeComplete) {
          try {
            this.onSessionExit?.(state.spec.sessionId);
          } catch {
            // ignore listener errors
          }
        }
      }
    }
  }

  private handleInboundLine(state: ActiveAcpProcess, line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Ignore non-JSON noise safely
    }

    // Response to our client->agent request
    if (msg.id !== undefined && msg.method === undefined) {
      const idNum = Number(msg.id);
      const pending = state.pendingClientRequests.get(idNum);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        state.pendingClientRequests.delete(idNum);
        if (msg.error) {
          pending.reject(new Error(JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    const method = String(msg.method ?? "");
    const params = (msg.params ?? {}) as Record<string, unknown>;

    // Bidirectional agent->client permission request
    if (method === "session/request_permission" && msg.id !== undefined) {
      const reqId = msg.id as number | string;
      state.pendingServerPermissionIds.add(reqId);
      const resolution = resolveAcpPermission(
        params as AcpPermissionRequestParams,
        state.spec.cwd,
        this.config.guardrails.acpWorktreeBoundaryEnforced,
      );
      if (resolution.escalated) {
        this.pushEvent(state, {
          type: "permission_escalated",
          requestId: String(reqId),
          reason: this.scrubber.scrub(resolution.reason),
        });
      }
      state.pendingServerPermissionIds.delete(reqId);
      this.writeJsonLine(state, { jsonrpc: "2.0", id: reqId, result: { outcome: resolution.outcome } });
      return;
    }

    // Streaming notifications
    if (method === "session/update") {
      const update = (params.update ?? params) as Record<string, unknown>;
      const kind = String(update.sessionUpdate ?? update.type ?? "");
      if (kind === "agent_message_chunk") {
        const content = update.content as { text?: string } | undefined;
        if (content?.text) this.pushEvent(state, { type: "text_delta", text: this.scrubber.scrub(content.text) });
      } else if (kind === "agent_thought_chunk") {
        const content = update.content as { text?: string } | undefined;
        if (content?.text) this.pushEvent(state, { type: "thought", text: this.scrubber.scrub(content.text) });
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        const toolCallId = String(update.toolCallId ?? "unknown");
        const rawStatus = String(update.status ?? "in_progress");
        const status =
          rawStatus === "completed" || rawStatus === "failed" || rawStatus === "pending" ? rawStatus : "in_progress";
        const locations = (update.locations as Array<{ path?: string }> | undefined) ?? [];
        this.pushEvent(state, {
          type: "tool_call",
          toolCallId,
          title: this.scrubber.scrub(String(update.title ?? toolCallId)),
          status,
          filePath: locations[0]?.path ? this.scrubber.scrub(locations[0].path) : undefined,
        });
      } else if (kind === "plan" || kind === "plan_update") {
        const entries = (update.entries as Array<{ content?: string; status?: string }> | undefined) ?? [];
        this.pushEvent(state, {
          type: "plan",
          items: entries.map((e) => ({
            title: this.scrubber.scrub(String(e.content ?? "")),
            status: (e.status as "pending" | "in_progress" | "completed" | "cancelled") ?? "pending",
          })),
        });
      }
    }
  }
}
