import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HubConfig } from "@bot-factory/shared";
import { SecretScrubber } from "../config";
import type {
  AgentRuntime,
  AutonomyLevel,
  NormalizedAgentEvent,
  ReasoningEffort,
  RuntimeSessionHandle,
  RuntimeSessionSpec,
  TurnInput,
} from "./types";

type CliAdapter = "claude" | "codex";

type ExtendedProviderConfig = Omit<HubConfig["providers"][string], "protocol" | "runtime"> & {
  runtime: string;
  adapter?: CliAdapter;
  env?: Record<string, string>;
};

const SAFE_CLI_ENV_KEYS = [
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
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
];

const CLAUDE_AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

const CODEX_AUTH_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "CODEX_HOME",
];

export function buildMinimalCliEnv(opts?: {
  adapter?: CliAdapter;
  apiKeyEnv?: string;
  providerEnv?: Record<string, string>;
  secrets?: Record<string, string>;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SAFE_CLI_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) out[key] = val;
  }

  const authKeys =
    opts?.adapter === "codex"
      ? CODEX_AUTH_ENV_KEYS
      : opts?.adapter === "claude"
        ? CLAUDE_AUTH_ENV_KEYS
        : [...CLAUDE_AUTH_ENV_KEYS, ...CODEX_AUTH_ENV_KEYS];

  for (const key of authKeys) {
    const fromSecrets = opts?.secrets?.[key];
    const fromEnv = process.env[key];
    const val = fromSecrets ?? fromEnv;
    if (val !== undefined) out[key] = val;
  }

  if (opts?.apiKeyEnv && opts.apiKeyEnv !== "BOT_FACTORY_TOKEN") {
    const val = opts.secrets?.[opts.apiKeyEnv] ?? process.env[opts.apiKeyEnv];
    if (val !== undefined) out[opts.apiKeyEnv] = val;
  }

  if (opts?.providerEnv) {
    for (const [k, v] of Object.entries(opts.providerEnv)) {
      if (k === "BOT_FACTORY_TOKEN") continue;
      out[k] = v;
    }
  }

  delete out.BOT_FACTORY_TOKEN;
  return out;
}

function buildSpawnCommand(command: string, args: string[]): { argv: string[]; usesCmdShell: boolean } {
  if (process.platform === "win32") {
    const resolved = Bun.which(command);
    if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
      const sanitizedArgs = args.map((a) => a.replace(/\r?\n/g, " "));
      return { argv: ["cmd.exe", "/c", resolved, ...sanitizedArgs], usesCmdShell: true };
    }
  }
  return { argv: [command, ...args], usesCmdShell: false };
}

function commandExists(command: string): boolean {
  if (!command.trim()) return false;
  if (existsSync(command)) return true;
  return Bun.which(command) !== null;
}

function formatTomlString(value: string): string {
  return JSON.stringify(value);
}

function formatTomlInlineTable(record: Record<string, string>): string {
  const entries = Object.entries(record).map(([k, v]) => `${JSON.stringify(k)} = ${formatTomlString(v)}`);
  return `{ ${entries.join(", ")} }`;
}

function formatCondensedHistory(history: TurnInput["history"]): string {
  if (history.length === 0) return "";
  const recent = history.slice(-12);
  const lines = recent.map((m) => {
    const text = m.content.length > 600 ? `${m.content.slice(0, 600)}…` : m.content;
    return `[${m.role}]: ${text}`;
  });
  return `<conversation_history>\n${lines.join("\n")}\n</conversation_history>`;
}

function extractFilePathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "filePath", "target_file", "filename"]) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) return val;
  }
  return undefined;
}

function extractToolResultText(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const obj = part as { text?: unknown; content?: unknown };
          if (typeof obj.text === "string") return obj.text;
          if (typeof obj.content === "string") return obj.content;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

interface ActiveCliSession {
  spec: RuntimeSessionSpec;
  adapter: CliAdapter;
  command: string;
  baseArgs: string[];
  resolvedModelId: string;
  env: Record<string, string>;
  mcpConfigPath: string | null;
  externalSessionId: string | undefined;
  proc: ReturnType<typeof Bun.spawn> | null;
  turnCount: number;
  turnMutex: Promise<void>;
  eventQueue: NormalizedAgentEvent[];
  eventWaiter: (() => void) | null;
  turnFinished: boolean;
  turnAbortedMode: "pause" | "hard_stop" | null;
  accumulatedText: string;
  sawStreamDeltaInMsg: boolean;
  toolNamesById: Map<string, string>;
  emittedDoneOrError: boolean;
  stderrStarted: boolean;
  stopping: boolean;
  closed: boolean;
}

export class CliStreamRuntime implements AgentRuntime {
  public readonly kind = "cli_stream" as const;
  private readonly sessions = new Map<string, ActiveCliSession>();
  private config: HubConfig;
  private readonly logsDir: string;
  private secrets: Record<string, string>;
  private readonly scrubber: SecretScrubber;
  private readonly opts?: { requestTimeoutMs?: number };

  constructor(config: HubConfig, logsDir: string, scrubber: SecretScrubber, opts?: { requestTimeoutMs?: number });
  constructor(
    config: HubConfig,
    logsDir: string,
    secrets: Record<string, string>,
    scrubber: SecretScrubber,
    opts?: { requestTimeoutMs?: number },
  );
  constructor(
    config: HubConfig,
    logsDir: string,
    secretsOrScrubber: Record<string, string> | SecretScrubber,
    scrubberOrOpts?: SecretScrubber | { requestTimeoutMs?: number },
    opts?: { requestTimeoutMs?: number },
  ) {
    this.config = config;
    this.logsDir = logsDir;
    const isScrubber = Boolean(
      secretsOrScrubber && typeof (secretsOrScrubber as { scrub?: unknown }).scrub === "function",
    );
    if (isScrubber) {
      this.secrets = {};
      this.scrubber = secretsOrScrubber as SecretScrubber;
      this.opts = scrubberOrOpts as { requestTimeoutMs?: number } | undefined;
    } else {
      this.secrets = { ...(secretsOrScrubber as Record<string, string>) };
      this.scrubber = scrubberOrOpts as SecretScrubber;
      this.opts = opts;
    }
  }

  public setConfig(newConfig: HubConfig): void {
    this.config = newConfig;
  }

  public updateSecrets(secrets: Record<string, string>): void {
    this.secrets = { ...secrets };
  }

  public isSessionAlive(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    if (!state || state.stopping || state.closed) return false;
    if (!state.proc) return true;
    // Codex uses per-turn `codex exec` / `codex exec resume` subprocesses;
    // clean exit (code 0) keeps the logical session alive across turns.
    if (state.adapter === "codex" && state.proc.exitCode === 0 && !state.proc.killed) {
      return true;
    }
    return state.proc.exitCode === null && !state.proc.killed;
  }

  public getActiveCount(): number {
    return this.sessions.size;
  }

  private getTurnIdleTimeoutMs(): number {
    if (this.opts?.requestTimeoutMs !== undefined) return this.opts.requestTimeoutMs;
    return Math.max((this.config.guardrails.permissionRequestTimeoutSeconds ?? 120) * 1000, 300_000);
  }

  public async startSession(spec: RuntimeSessionSpec): Promise<RuntimeSessionHandle> {
    const providerCfg = this.config.providers[spec.provider] as ExtendedProviderConfig | undefined;
    if (!providerCfg || (providerCfg.runtime !== "cli_stream" && !providerCfg.adapter) || !providerCfg.command) {
      throw new Error(`Invalid CLI stream provider configuration: ${spec.provider}`);
    }

    if (!commandExists(providerCfg.command)) {
      throw new Error(`CLI executable not found on PATH: ${providerCfg.command}`);
    }

    const adapter: CliAdapter =
      providerCfg.adapter ?? (providerCfg.command.toLowerCase().includes("codex") ? "codex" : "claude");
    const resolvedModelId = providerCfg.models[spec.model]?.id ?? spec.model;
    const baseArgs = [...(providerCfg.args ?? [])];
    const env = buildMinimalCliEnv({
      adapter,
      apiKeyEnv: providerCfg.apiKeyEnv,
      providerEnv: providerCfg.env,
      secrets: this.secrets,
    });

    let mcpConfigPath: string | null = null;
    if (adapter === "claude" && spec.mcpServers && spec.mcpServers.length > 0) {
      const mcpDir = join(this.logsDir, "mcp-configs");
      mkdirSync(mcpDir, { recursive: true });
      mcpConfigPath = join(mcpDir, `${spec.sessionId}.json`);
      const mcpServersObj: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
      for (const srv of spec.mcpServers) {
        mcpServersObj[srv.name] = {
          command: srv.command,
          args: srv.args,
          ...(srv.env ? { env: srv.env } : {}),
        };
      }
      writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: mcpServersObj }, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
    }

    const state: ActiveCliSession = {
      spec,
      adapter,
      command: providerCfg.command,
      baseArgs,
      resolvedModelId,
      env,
      mcpConfigPath,
      externalSessionId: undefined,
      proc: null,
      turnCount: 0,
      turnMutex: Promise.resolve(),
      eventQueue: [],
      eventWaiter: null,
      turnFinished: false,
      turnAbortedMode: null,
      accumulatedText: "",
      sawStreamDeltaInMsg: false,
      toolNamesById: new Map(),
      emittedDoneOrError: false,
      stderrStarted: false,
      stopping: false,
      closed: false,
    };

    if (adapter === "claude") {
      try {
        this.spawnClaudeProcess(state, spec.reasoningEffort, spec.autonomyLevel, false);
      } catch (err) {
        this.cleanupTempFiles(state);
        throw err;
      }
    }

    this.sessions.set(spec.sessionId, state);
    return {
      sessionId: spec.sessionId,
      agentId: spec.agentId,
      runtimeKind: "cli_stream",
      pid: state.proc?.pid ?? null,
      externalSessionId: state.externalSessionId,
    };
  }

  private buildClaudeArgs(
    state: ActiveCliSession,
    reasoningEffort?: ReasoningEffort,
    autonomyLevel?: AutonomyLevel,
    isResume = false,
  ): string[] {
    const args = [...state.baseArgs];
    if (!args.includes("--print") && !args.includes("-p")) args.push("--print");
    if (!args.includes("--input-format")) args.push("--input-format", "stream-json");
    if (!args.includes("--output-format")) args.push("--output-format", "stream-json");
    if (!args.includes("--verbose")) args.push("--verbose");
    if (!args.includes("--include-partial-messages")) args.push("--include-partial-messages");

    if (state.resolvedModelId && !args.includes("--model")) {
      args.push("--model", state.resolvedModelId);
    }
    const effort = reasoningEffort ?? state.spec.reasoningEffort;
    if (effort && !args.includes("--effort")) {
      args.push("--effort", effort);
    }
    if (state.mcpConfigPath && !args.includes("--mcp-config")) {
      args.push("--mcp-config", state.mcpConfigPath);
    }
    if (state.spec.systemPrompt.trim() && !args.includes("--append-system-prompt")) {
      args.push("--append-system-prompt", state.spec.systemPrompt.trim());
    }
    if (isResume && state.externalSessionId && !args.includes("--resume") && !args.includes("-r")) {
      args.push("--resume", state.externalSessionId);
    }

    const level = autonomyLevel ?? state.spec.autonomyLevel ?? "medium";
    if (!args.includes("--permission-mode")) {
      if (level === "spec") {
        args.push("--permission-mode", "plan");
      } else if (level === "low") {
        args.push("--permission-mode", "dontAsk");
      } else if (level === "high") {
        args.push("--permission-mode", "bypassPermissions", "--allow-dangerously-skip-permissions");
      } else {
        args.push("--permission-mode", "acceptEdits");
      }
    }
    return args;
  }

  private buildCodexArgs(
    state: ActiveCliSession,
    reasoningEffort?: ReasoningEffort,
    autonomyLevel?: AutonomyLevel,
    imagePath?: string | null,
  ): string[] {
    const args = [...state.baseArgs];
    const isResume = Boolean(state.externalSessionId);

    if (!args.includes("exec")) {
      args.push("exec");
    }
    if (isResume && state.externalSessionId) {
      args.push("resume", state.externalSessionId);
    }

    if (!args.includes("--json")) args.push("--json");
    if (!isResume && !args.includes("--cd") && !args.includes("-C")) {
      args.push("--cd", state.spec.cwd);
    }

    if (state.resolvedModelId) {
      args.push("-c", `model=${formatTomlString(state.resolvedModelId)}`);
    }

    const effort = reasoningEffort ?? state.spec.reasoningEffort;
    if (effort) {
      const codexEffort = effort === "max" ? "xhigh" : effort;
      args.push("-c", `model_reasoning_effort=${formatTomlString(codexEffort)}`);
    }

    if (!isResume) {
      const level = autonomyLevel ?? state.spec.autonomyLevel ?? "medium";
      if (level === "spec" || level === "low") {
        args.push("--sandbox", "read-only");
      } else {
        args.push("--sandbox", "workspace-write");
      }
    }

    if (state.spec.mcpServers && state.spec.mcpServers.length > 0) {
      for (const srv of state.spec.mcpServers) {
        const keySafe = srv.name.replace(/[^a-zA-Z0-9_-]/g, "_");
        args.push("-c", `mcp_servers.${keySafe}.command=${formatTomlString(srv.command)}`);
        args.push("-c", `mcp_servers.${keySafe}.args=[${srv.args.map(formatTomlString).join(", ")}]`);
        if (srv.env && Object.keys(srv.env).length > 0) {
          args.push("-c", `mcp_servers.${keySafe}.env=${formatTomlInlineTable(srv.env)}`);
        }
      }
    }

    if (imagePath) {
      args.push("-i", imagePath);
    }

    args.push("-");
    return args;
  }

  private spawnClaudeProcess(
    state: ActiveCliSession,
    reasoningEffort?: ReasoningEffort,
    autonomyLevel?: AutonomyLevel,
    isResume = false,
  ): void {
    const cliArgs = this.buildClaudeArgs(state, reasoningEffort, autonomyLevel, isResume);
    const { argv } = buildSpawnCommand(state.command, cliArgs);
    const logFile = join(this.logsDir, `${state.spec.agentId}-cli-stderr.log`);
    mkdirSync(dirname(logFile), { recursive: true });

    const proc = Bun.spawn(argv, {
      cwd: state.spec.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: state.env,
    });

    state.proc = proc;
    state.stderrStarted = true;
    void this.pumpStderr(state, proc, logFile);
    void this.pumpStdout(state, proc);
    void proc.exited.then((code) => {
      if (state.proc !== proc) return;
      if (state.stopping || state.closed) return;
      if (!state.turnFinished && state.turnCount > 0 && !state.emittedDoneOrError) {
        if (state.turnAbortedMode === "pause") {
          this.finishTurn(state, {
            type: "done",
            finalText: this.scrubber.scrub(state.accumulatedText || "[Turn paused by operator]"),
          });
        } else if (code === 0) {
          this.finishTurn(state, { type: "done", finalText: this.scrubber.scrub(state.accumulatedText) });
        } else {
          this.finishTurn(state, {
            type: "error",
            message: this.scrubber.scrub(`cli_stream_exited(${code})`),
          });
        }
      }
    });
  }

  public async *sendTurn(handle: RuntimeSessionHandle, input: TurnInput): AsyncIterable<NormalizedAgentEvent> {
    const state = this.sessions.get(handle.sessionId);
    if (!state || state.stopping || state.closed) {
      yield { type: "error", message: `CLI stream session not active: ${handle.sessionId}` };
      return;
    }

    // Serialize turns on the same session
    const prevTurn = state.turnMutex;
    let releaseTurn!: () => void;
    const currentTurnDone = new Promise<void>((res) => {
      releaseTurn = res;
    });
    state.turnMutex = prevTurn.catch(() => {}).then(() => currentTurnDone);
    await prevTurn.catch(() => {});

    let tempImagePath: string | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    try {
      const current = this.sessions.get(handle.sessionId);
      if (!current || current !== state || state.stopping || state.closed) {
        yield { type: "error", message: `CLI stream session not active: ${handle.sessionId}` };
        return;
      }

      state.turnCount++;
      state.eventQueue.length = 0;
      state.turnFinished = false;
      state.turnAbortedMode = null;
      state.accumulatedText = "";
      state.sawStreamDeltaInMsg = false;
      state.toolNamesById.clear();
      state.emittedDoneOrError = false;

      const idleTimeoutMs = this.getTurnIdleTimeoutMs();
      const armIdleTimer = () => {
        clearIdleTimer();
        idleTimer = setTimeout(() => {
          if (state.turnFinished) return;
          this.terminateProcessTreeSync(state, false);
          this.finishTurn(state, { type: "error", message: `cli_stream_timeout:${idleTimeoutMs}ms` });
        }, idleTimeoutMs);
      };
      armIdleTimer();

      if (state.adapter === "claude") {
        if (!state.proc || state.proc.exitCode !== null || state.proc.killed) {
          this.spawnClaudeProcess(
            state,
            input.reasoningEffort ?? state.spec.reasoningEffort,
            input.autonomyLevel ?? state.spec.autonomyLevel,
            Boolean(state.externalSessionId),
          );
          if (state.proc?.pid) {
            handle.pid = state.proc.pid;
          }
        }

        const promptParts: string[] = [];
        if (state.turnCount === 1 && !state.externalSessionId && input.history.length > 0) {
          promptParts.push(formatCondensedHistory(input.history));
        }
        if (input.ephemeralContext?.trim()) {
          promptParts.push(`<ephemeral_context>\n${input.ephemeralContext.trim()}\n</ephemeral_context>`);
        }
        promptParts.push(input.userText);
        const fullPromptText = promptParts.join("\n\n");

        const imgMatch = input.imageDataUrl ? /^data:([^;]+);base64,(.+)$/.exec(input.imageDataUrl) : null;
        const messageContent = imgMatch
          ? [
              { type: "image", source: { type: "base64", media_type: imgMatch[1], data: imgMatch[2] } },
              { type: "text", text: fullPromptText },
            ]
          : fullPromptText;

        const payload = JSON.stringify({
          type: "user",
          message: { role: "user", content: messageContent },
        });
        if (state.proc?.stdin && typeof state.proc.stdin !== "number") {
          state.proc.stdin.write(`${payload}\n`);
        } else {
          throw new Error("Claude CLI stdin unavailable");
        }
      } else {
        // Codex per-turn exec invocation
        const imgMatch = input.imageDataUrl ? /^data:([^;]+);base64,(.+)$/.exec(input.imageDataUrl) : null;
        if (imgMatch && imgMatch[1] && imgMatch[2]) {
          const ext = imgMatch[1].includes("png") ? "png" : imgMatch[1].includes("webp") ? "webp" : "jpg";
          const imgDir = join(this.logsDir, "tmp-images");
          mkdirSync(imgDir, { recursive: true });
          tempImagePath = join(imgDir, `${state.spec.sessionId}-${Date.now()}.${ext}`);
          writeFileSync(tempImagePath, Buffer.from(imgMatch[2], "base64"));
        }

        const cliArgs = this.buildCodexArgs(
          state,
          input.reasoningEffort ?? state.spec.reasoningEffort,
          input.autonomyLevel ?? state.spec.autonomyLevel,
          tempImagePath,
        );
        const { argv } = buildSpawnCommand(state.command, cliArgs);
        const logFile = join(this.logsDir, `${state.spec.agentId}-cli-stderr.log`);
        mkdirSync(dirname(logFile), { recursive: true });

        const proc = Bun.spawn(argv, {
          cwd: state.spec.cwd,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: state.env,
        });
        state.proc = proc;
        handle.pid = proc.pid ?? null;

        const promptParts: string[] = [];
        if (!state.externalSessionId) {
          if (state.spec.systemPrompt.trim()) {
            promptParts.push(`<system_instructions>\n${state.spec.systemPrompt.trim()}\n</system_instructions>`);
          }
          const condensed = formatCondensedHistory(input.history);
          if (condensed) promptParts.push(condensed);
        }
        if (input.ephemeralContext?.trim()) {
          promptParts.push(`<ephemeral_context>\n${input.ephemeralContext.trim()}\n</ephemeral_context>`);
        }
        promptParts.push(input.userText);

        if (proc.stdin && typeof proc.stdin !== "number") {
          proc.stdin.write(promptParts.join("\n\n"));
          proc.stdin.end();
        }

        void this.pumpStderr(state, proc, logFile);
        const stdoutDone = this.pumpStdout(state, proc);
        void proc.exited.then(async (code) => {
          await Promise.race([stdoutDone, new Promise<void>((r) => setTimeout(r, 150))]);
          if (state.proc !== proc) return;
          if (!state.turnFinished && !state.emittedDoneOrError) {
            if (state.turnAbortedMode === "pause") {
              this.finishTurn(state, {
                type: "done",
                finalText: this.scrubber.scrub(state.accumulatedText || "[Turn paused by operator]"),
              });
            } else if (state.stopping || state.closed) {
              this.finishTurn(state, {
                type: "done",
                finalText: this.scrubber.scrub(state.accumulatedText || "[Turn stopped by operator]"),
              });
            } else if (code === 0) {
              this.finishTurn(state, { type: "done", finalText: this.scrubber.scrub(state.accumulatedText) });
            } else {
              this.finishTurn(state, {
                type: "error",
                message: this.scrubber.scrub(`codex_exec_exited(${code})`),
              });
            }
          }
          if (code === 0 && state.proc === proc) {
            state.proc = null;
          }
        });
      }

      while (!state.turnFinished || state.eventQueue.length > 0) {
        if (state.eventQueue.length === 0) {
          await new Promise<void>((r) => {
            state.eventWaiter = r;
          });
          state.eventWaiter = null;
        }
        while (state.eventQueue.length > 0) {
          const evt = state.eventQueue.shift()!;
          if (evt.type !== "done" && evt.type !== "error") {
            armIdleTimer();
          }
          yield evt;
          if (evt.type === "done" || evt.type === "error") {
            if (state.externalSessionId) {
              handle.externalSessionId = state.externalSessionId;
            }
            return;
          }
        }
      }
    } catch (err) {
      yield { type: "error", message: this.scrubber.scrub(err instanceof Error ? err.message : String(err)) };
    } finally {
      clearIdleTimer();
      state.eventWaiter = null;
      if (tempImagePath) {
        try {
          rmSync(tempImagePath, { force: true });
        } catch {
          // ignore temp cleanup failure
        }
      }
      releaseTurn();
    }
  }

  private pushEvent(state: ActiveCliSession, evt: NormalizedAgentEvent): void {
    state.eventQueue.push(evt);
    if (state.eventWaiter) {
      const wake = state.eventWaiter;
      state.eventWaiter = null;
      wake();
    }
  }

  private finishTurn(state: ActiveCliSession, evt: NormalizedAgentEvent): void {
    if (state.turnFinished) return;
    state.turnFinished = true;
    state.emittedDoneOrError = true;
    this.pushEvent(state, evt);
  }

  private async pumpStderr(
    state: ActiveCliSession,
    proc: ReturnType<typeof Bun.spawn>,
    logFile: string,
  ): Promise<void> {
    if (!proc.stderr || typeof proc.stderr === "number") return;
    const reader = proc.stderr.getReader();
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
    void state;
  }

  private async pumpStdout(state: ActiveCliSession, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (!proc.stdout || typeof proc.stdout === "number") return;
    const reader = proc.stdout.getReader();
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
          if (line) this.handleNdjsonLine(state, line);
          nl = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        this.handleNdjsonLine(state, buffer.trim());
      }
    } catch {
      // ignore stream close
    }
  }

  private handleNdjsonLine(state: ActiveCliSession, line: string): void {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Ignore non-JSON stdout noise safely
    }

    // Unwrap Claude stream_event wrapper if present
    const evt =
      raw.type === "stream_event" && raw.event && typeof raw.event === "object"
        ? (raw.event as Record<string, unknown>)
        : raw;

    const evType = String(evt.type ?? "");

    // Capture external session / thread IDs
    if (typeof evt.session_id === "string" && evt.session_id) {
      state.externalSessionId = evt.session_id;
    }
    if (evType === "thread.started" && typeof evt.thread_id === "string" && evt.thread_id) {
      state.externalSessionId = evt.thread_id;
      return;
    }

    // Claude / Anthropic stream events
    if (evType === "content_block_start") {
      const cb = (evt.content_block ?? {}) as {
        type?: string;
        id?: string;
        name?: string;
        input?: unknown;
      };
      if (cb.type === "tool_use") {
        const id = cb.id ?? `tc_${crypto.randomUUID().slice(0, 8)}`;
        const name = cb.name ?? "tool";
        state.toolNamesById.set(id, name);
        this.pushEvent(state, {
          type: "tool_call",
          toolCallId: id,
          title: this.scrubber.scrub(name),
          status: "in_progress",
          filePath: extractFilePathFromInput(cb.input),
        });
      }
      return;
    }

    if (evType === "content_block_delta") {
      const delta = (evt.delta ?? {}) as { type?: string; text?: string; thinking?: string };
      if (delta.type === "text_delta" && delta.text) {
        const clean = this.scrubber.scrub(delta.text);
        state.sawStreamDeltaInMsg = true;
        state.accumulatedText += clean;
        this.pushEvent(state, { type: "text_delta", text: clean });
      } else if (delta.type === "thinking_delta" && delta.thinking) {
        this.pushEvent(state, { type: "thought", text: this.scrubber.scrub(delta.thinking) });
      }
      return;
    }

    if (evType === "assistant") {
      const message = (evt.message ?? evt) as {
        content?: Array<Record<string, unknown>>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        const bType = String(block.type ?? "");
        if (bType === "thinking" && typeof block.thinking === "string" && block.thinking) {
          this.pushEvent(state, { type: "thought", text: this.scrubber.scrub(block.thinking) });
        } else if (bType === "text" && typeof block.text === "string" && block.text) {
          if (!state.sawStreamDeltaInMsg) {
            const clean = this.scrubber.scrub(block.text);
            state.accumulatedText += clean;
            this.pushEvent(state, { type: "text_delta", text: clean });
          }
        } else if (bType === "tool_use") {
          const id = String(block.id ?? `tc_${crypto.randomUUID().slice(0, 8)}`);
          const name = String(block.name ?? "tool");
          state.toolNamesById.set(id, name);
          this.pushEvent(state, {
            type: "tool_call",
            toolCallId: id,
            title: this.scrubber.scrub(name),
            status: "in_progress",
            filePath: extractFilePathFromInput(block.input),
          });
        }
      }
      state.sawStreamDeltaInMsg = false;
      if (message.usage) {
        const tokenIn = message.usage.input_tokens ?? 0;
        const tokenOut = message.usage.output_tokens ?? 0;
        if (tokenIn > 0 || tokenOut > 0) {
          this.pushEvent(state, { type: "usage", tokenIn, tokenOut });
        }
      }
      return;
    }

    if (evType === "tool_use") {
      const id = String(evt.id ?? evt.toolCallId ?? `tc_${crypto.randomUUID().slice(0, 8)}`);
      const name = String(evt.name ?? evt.title ?? "tool");
      state.toolNamesById.set(id, name);
      this.pushEvent(state, {
        type: "tool_call",
        toolCallId: id,
        title: this.scrubber.scrub(name),
        status: "in_progress",
        filePath: extractFilePathFromInput(evt.input),
      });
      return;
    }

    if (evType === "user") {
      const message = (evt.message ?? {}) as { content?: Array<Record<string, unknown>> };
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        if (block.type === "tool_result") {
          this.emitToolResultBlock(state, block);
        }
      }
      return;
    }

    if (evType === "tool_result") {
      this.emitToolResultBlock(state, evt);
      return;
    }

    if (evType === "result") {
      const usage = evt.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | undefined;
      if (usage) {
        const tokenIn = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        const tokenOut = usage.output_tokens ?? 0;
        if (tokenIn > 0 || tokenOut > 0) {
          this.pushEvent(state, { type: "usage", tokenIn, tokenOut });
        }
      }
      const isErr = Boolean(evt.is_error);
      if (isErr) {
        const errs = Array.isArray(evt.errors) ? evt.errors.map(String).join("; ") : "";
        const errMsg = typeof evt.result === "string" && evt.result ? evt.result : errs || "Claude CLI error";
        this.finishTurn(state, { type: "error", message: this.scrubber.scrub(errMsg) });
        return;
      }
      let finalText = state.accumulatedText;
      if (!finalText && typeof evt.result === "string" && evt.result) {
        const clean = this.scrubber.scrub(evt.result);
        finalText = clean;
        this.pushEvent(state, { type: "text_delta", text: clean });
      }
      this.finishTurn(state, { type: "done", finalText });
      return;
    }

    // Codex exec --json events
    if (evType === "item.started") {
      const item = (evt.item ?? {}) as Record<string, unknown>;
      const itemType = String(item.type ?? "");
      const id = String(item.id ?? `tc_${crypto.randomUUID().slice(0, 8)}`);
      if (itemType === "command_execution") {
        const cmd = String(item.command ?? "shell");
        state.toolNamesById.set(id, cmd);
        this.pushEvent(state, {
          type: "tool_call",
          toolCallId: id,
          title: this.scrubber.scrub(cmd),
          status: "in_progress",
        });
      } else if (itemType === "file_change") {
        const changes = (item.changes as Array<{ path?: string }> | undefined) ?? [];
        this.pushEvent(state, {
          type: "tool_call",
          toolCallId: id,
          title: "file_change",
          status: "in_progress",
          filePath: changes[0]?.path ? this.scrubber.scrub(changes[0].path) : undefined,
        });
      } else if (itemType === "mcp_tool_call") {
        const name = `${String(item.server ?? "mcp")}:${String(item.tool ?? "call")}`;
        state.toolNamesById.set(id, name);
        this.pushEvent(state, {
          type: "tool_call",
          toolCallId: id,
          title: this.scrubber.scrub(name),
          status: "in_progress",
        });
      }
      return;
    }

    if (evType === "item.completed") {
      const item = (evt.item ?? {}) as Record<string, unknown>;
      const itemType = String(item.type ?? "");
      const id = String(item.id ?? `tc_${crypto.randomUUID().slice(0, 8)}`);

      if (itemType === "reasoning" && typeof item.text === "string" && item.text) {
        this.pushEvent(state, { type: "thought", text: this.scrubber.scrub(item.text) });
      } else if (itemType === "agent_message" && typeof item.text === "string" && item.text) {
        const clean = this.scrubber.scrub(item.text);
        if (state.accumulatedText.length > 0 && !state.accumulatedText.endsWith("\n")) {
          state.accumulatedText += "\n\n";
          this.pushEvent(state, { type: "text_delta", text: "\n\n" });
        }
        state.accumulatedText += clean;
        this.pushEvent(state, { type: "text_delta", text: clean });
      } else if (itemType === "command_execution") {
        const cmd = String(item.command ?? state.toolNamesById.get(id) ?? "shell");
        const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
        const isError = item.status === "failed" || (exitCode !== null && exitCode !== 0);
        const output = this.scrubber.scrub(String(item.aggregated_output ?? item.output ?? ""));
        this.pushEvent(state, {
          type: "tool_call",
          toolCallId: id,
          title: this.scrubber.scrub(cmd),
          status: isError ? "failed" : "completed",
          output,
          exitCode,
        });
        this.pushEvent(state, {
          type: "tool_result",
          toolCallId: id,
          name: this.scrubber.scrub(cmd),
          output,
          isError,
        });
      } else if (itemType === "file_change") {
        const changes = (item.changes as Array<{ path?: string; kind?: string }> | undefined) ?? [];
        const summary = changes.map((c) => `${c.kind ?? "edit"} ${c.path ?? ""}`).join(", ") || "file_change";
        const isError = item.status === "failed";
        const cleanSummary = this.scrubber.scrub(summary);
        this.pushEvent(state, {
          type: "tool_call",
          toolCallId: id,
          title: cleanSummary,
          status: isError ? "failed" : "completed",
          filePath: changes[0]?.path ? this.scrubber.scrub(changes[0].path) : undefined,
          output: cleanSummary,
        });
        this.pushEvent(state, {
          type: "tool_result",
          toolCallId: id,
          name: "file_change",
          output: cleanSummary,
          isError,
        });
      } else if (itemType === "mcp_tool_call") {
        const name = `${String(item.server ?? "mcp")}:${String(item.tool ?? "call")}`;
        const isError = Boolean(item.error) || item.status === "failed";
        const rawOut = item.error ?? item.result ?? "";
        const output = this.scrubber.scrub(typeof rawOut === "string" ? rawOut : JSON.stringify(rawOut));
        this.pushEvent(state, {
          type: "tool_call",
          toolCallId: id,
          title: this.scrubber.scrub(name),
          status: isError ? "failed" : "completed",
          output,
        });
        this.pushEvent(state, {
          type: "tool_result",
          toolCallId: id,
          name: this.scrubber.scrub(name),
          output,
          isError,
        });
      } else if (itemType === "todo_list" && Array.isArray(item.items)) {
        const planItems = (item.items as Array<{ text?: string; completed?: boolean }>).map((t) => ({
          title: this.scrubber.scrub(String(t.text ?? "")),
          status: (t.completed ? "completed" : "pending") as "completed" | "pending",
        }));
        this.pushEvent(state, { type: "plan", items: planItems });
      } else if (itemType === "error") {
        this.pushEvent(state, {
          type: "error",
          message: this.scrubber.scrub(String(item.message ?? "Codex item error")),
        });
      }
      return;
    }

    if (evType === "turn.completed") {
      const usage = evt.usage as {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
      } | undefined;
      if (usage) {
        const tokenIn = (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0);
        const tokenOut = usage.output_tokens ?? 0;
        if (tokenIn > 0 || tokenOut > 0) {
          this.pushEvent(state, { type: "usage", tokenIn, tokenOut });
        }
      }
      this.finishTurn(state, { type: "done", finalText: state.accumulatedText });
      return;
    }

    if (evType === "turn.failed" || evType === "error") {
      const errObj = evt.error as { message?: string } | undefined;
      const msg = errObj?.message ?? (typeof evt.message === "string" ? evt.message : "CLI stream error");
      this.finishTurn(state, { type: "error", message: this.scrubber.scrub(msg) });
    }
  }

  private emitToolResultBlock(state: ActiveCliSession, block: Record<string, unknown>): void {
    const toolCallId = String(block.tool_use_id ?? block.toolCallId ?? "unknown");
    const name = String(block.name ?? state.toolNamesById.get(toolCallId) ?? "tool");
    const isError = Boolean(block.is_error ?? block.isError);
    const output = this.scrubber.scrub(extractToolResultText(block.content ?? block.output));
    this.pushEvent(state, {
      type: "tool_call",
      toolCallId,
      title: this.scrubber.scrub(name),
      status: isError ? "failed" : "completed",
      output,
      exitCode: isError ? 1 : 0,
    });
    this.pushEvent(state, {
      type: "tool_result",
      toolCallId,
      name: this.scrubber.scrub(name),
      output,
      isError,
    });
  }

  private cleanupTempFiles(state: ActiveCliSession): void {
    if (state.mcpConfigPath) {
      try {
        rmSync(state.mcpConfigPath, { force: true });
      } catch {
        // ignore cleanup error
      }
      state.mcpConfigPath = null;
    }
  }

  private terminateProcessTreeSync(state: ActiveCliSession, markClosed: boolean): void {
    if (markClosed) state.closed = true;
    const proc = state.proc;
    if (!proc) return;
    const pid = proc.pid;
    try {
      if (proc.stdin && typeof proc.stdin !== "number") {
        proc.stdin.end();
      }
    } catch {
      // ignore
    }

    if (process.platform === "win32" && pid) {
      try {
        Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
      } catch {
        try {
          proc.kill();
        } catch {
          // ignore
        }
      }
    } else {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
    if (markClosed) state.proc = null;
  }

  private async terminateProcessTree(state: ActiveCliSession, markClosed: boolean): Promise<void> {
    if (markClosed) state.closed = true;
    const proc = state.proc;
    if (!proc) return;
    const pid = proc.pid;
    try {
      if (proc.stdin && typeof proc.stdin !== "number") {
        proc.stdin.end();
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
          proc.kill();
        } catch {
          // ignore
        }
      }
    } else {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
    if (markClosed) state.proc = null;
  }

  public async abort(handle: RuntimeSessionHandle, mode: "pause" | "hard_stop"): Promise<void> {
    const state = this.sessions.get(handle.sessionId);
    if (!state) return;

    state.turnAbortedMode = mode;

    if (mode === "pause") {
      await this.terminateProcessTree(state, false);
      state.proc = null;
      this.finishTurn(state, {
        type: "done",
        finalText: this.scrubber.scrub(state.accumulatedText || "[Turn paused by operator]"),
      });
      return;
    }

    state.stopping = true;
    await this.terminateProcessTree(state, true);
    this.cleanupTempFiles(state);
    this.sessions.delete(handle.sessionId);
    this.finishTurn(state, {
      type: "done",
      finalText: this.scrubber.scrub(state.accumulatedText || "[Turn stopped by operator]"),
    });
  }

  public async closeSession(handle: RuntimeSessionHandle): Promise<void> {
    await this.abort(handle, "hard_stop");
  }

  public async shutdownAll(): Promise<void> {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.all(
      entries.map(async ([, state]) => {
        state.stopping = true;
        await this.terminateProcessTree(state, true);
        this.cleanupTempFiles(state);
        this.finishTurn(state, {
          type: "done",
          finalText: this.scrubber.scrub(state.accumulatedText || "[Daemon shutting down]"),
        });
      }),
    );
  }

  public shutdownAllSync(): void {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();
    for (const [, state] of entries) {
      state.stopping = true;
      this.terminateProcessTreeSync(state, true);
      this.cleanupTempFiles(state);
      this.finishTurn(state, {
        type: "done",
        finalText: this.scrubber.scrub(state.accumulatedText || "[Daemon shutting down]"),
      });
    }
  }
}
