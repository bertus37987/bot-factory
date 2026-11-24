import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { HubConfig } from "@bot-factory/shared";
import { SecretScrubber } from "../config";
import { isPathStrictlyWithinRoot } from "./nativeHttpRuntime";
import type {
  AgentRuntime,
  AutonomyLevel,
  NormalizedAgentEvent,
  RuntimeSessionHandle,
  RuntimeSessionSpec,
  TurnInput,
} from "./types";

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

export interface AutonomyPermissionEvaluation {
  decision: "allow" | "deny" | "escalate";
  reason: string;
  commandOrPath: string;
}

export interface PendingAcpPermissionRecord {
  permissionId: string;
  agentId: string;
  sessionId: string;
  title: string;
  commandOrPath: string;
  reason: string;
  timeoutMs: number;
  createdAt: number;
  expiresAt: number;
}

type ExtendedProviderConfig = HubConfig["providers"][string] & {
  env?: Record<string, string>;
};

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-[a-z]*[rf][a-z]*\b/i,
  /\b(del|erase|rmdir|rd)\s+\/[sqf]/i,
  /\bremove-item\b.*-recurse/i,
  /\bgit\s+push\s+(-f|--force)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*[fd]/i,
  /\bformat\s+[a-z]:/i,
  /secrets\.env/i,
];

const HARD_DENY_COMMAND_PATTERNS: Array<{ rx: RegExp; reason: string }> = [
  { rx: /secrets\.env/i, reason: "hard_deny_protected_file:secrets.env" },
  { rx: /\.daemon-token/i, reason: "hard_deny_protected_file:.daemon-token" },
  { rx: /\bstate\.db(?:-(?:wal|shm))?\b/i, reason: "hard_deny_protected_file:state.db" },
  { rx: /(?:~|[a-z]:)?[\\/]?bot-factory[\\/]system(?:[\\/]|$)/i, reason: "hard_deny_protected_dir:system" },
  {
    rx: /\brm\s+-[a-z]*[rf][a-z]*\s+(?:\/(?:\s|\*|$)|~(?:\/|\s|$)|[a-z]:\\(?:\s|\*|$))/i,
    reason: "hard_deny_destructive_command:rm_root",
  },
  { rx: /\bgit\s+push\b.*(?:\s-f\b|--force\b)/i, reason: "hard_deny_destructive_command:git_push_force" },
  { rx: /\bformat\s+[a-z]:/i, reason: "hard_deny_destructive_command:format" },
  { rx: /\bmkfs\./i, reason: "hard_deny_destructive_command:mkfs" },
];

const NETWORK_COMMAND_PATTERNS = [
  /\b(curl|wget|ssh|scp|sftp|nc|ncat|telnet|ftp)\b/i,
  /\b(invoke-webrequest|invoke-restmethod|iwr|irm)\b/i,
  /\bgit\s+(push|fetch|pull|clone)\b/i,
  /\b(npm|bun|pnpm|yarn)\s+publish\b/i,
];

const READ_KINDS = new Set(["read", "search", "grep", "glob", "list", "inspect", "think", "view"]);
const WRITE_KINDS = new Set(["edit", "write", "create", "patch", "modify", "rename", "move", "delete"]);
const SHELL_KINDS = new Set(["execute", "bash", "shell", "terminal", "run", "command"]);

const SAFE_READ_BUILD_TEST_PREFIXES = [
  /^(?:run\s+|execute\s+)?bun\s+test\b/i,
  /^(?:run\s+|execute\s+)?bun\s+run\s+(?:test|typecheck|build|build:web|check|lint)\b/i,
  /^(?:run\s+|execute\s+)?bun\s+x\s+tsc\b/i,
  /^(?:run\s+|execute\s+)?(?:npx\s+)?tsc\b/i,
  /^(?:run\s+|execute\s+)?npm\s+(?:test|run\s+(?:test|build|typecheck|check|lint))\b/i,
  /^(?:run\s+|execute\s+)?(?:pnpm|yarn)\s+(?:test|typecheck|build|lint)\b/i,
  /^(?:run\s+|execute\s+)?(?:vitest|jest|pytest|mocha)\b/i,
  /^(?:run\s+|execute\s+)?cargo\s+(?:test|check|build|clippy)\b/i,
  /^(?:run\s+|execute\s+)?go\s+(?:test|vet|build)\b/i,
  /^(?:run\s+|execute\s+)?git\s+(?:status|diff|log|show|branch|rev-parse)\b/i,
  /^(?:run\s+|execute\s+)?(?:ls|dir|pwd|which|where|cat|head|tail|rg|grep|find)\b/i,
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

function classifyToolCategory(kind: string, title: string): "read" | "edit" | "delete" | "shell" | "unknown" {
  const k = kind.trim().toLowerCase();
  if (k === "delete") return "delete";
  if (READ_KINDS.has(k)) return "read";
  if (WRITE_KINDS.has(k)) return "edit";
  if (SHELL_KINDS.has(k)) return "shell";

  const t = title.trim().toLowerCase();
  if (!t) return "unknown";
  if (/^(delete|remove|unlink|rm)\b/.test(t)) return "delete";
  if (/^(read|view|list|search|grep|glob|find|inspect|cat|head|tail|ls|dir)\b/.test(t)) return "read";
  if (/^(edit|write|create|update|patch|modify|rename|mkdir|save)\b/.test(t)) return "edit";
  if (/^(run|exec|execute|bash|sh|powershell|pwsh|cmd|npm|bun|pnpm|yarn|git|cargo|pytest|python|node|curl|wget)\b/.test(t)) {
    return "shell";
  }
  return "unknown";
}

function isTraversalOrUncPath(candidatePath: string): boolean {
  if (!candidatePath || candidatePath.includes("\0") || candidatePath.startsWith("\\\\") || candidatePath.startsWith("//")) {
    return true;
  }
  const parts = candidatePath.split(/[\\/]+/).filter(Boolean);
  return parts.includes("..");
}

function isProtectedPathTarget(locPath: string, worktreePath: string, protectedDirs: string[]): string | null {
  const lower = locPath.toLowerCase();
  if (lower.includes("secrets.env")) return "hard_deny_protected_file:secrets.env";
  if (lower.includes(".daemon-token")) return "hard_deny_protected_file:.daemon-token";
  if (/(?:^|[\\/])state\.db(?:-(?:wal|shm))?$/i.test(locPath)) return "hard_deny_protected_file:state.db";

  const absTarget = isAbsolute(locPath) ? resolve(locPath) : resolve(worktreePath, locPath);
  for (const dir of protectedDirs) {
    if (!dir) continue;
    const absDir = resolve(dir);
    if (isPathStrictlyWithinRoot(absDir, absTarget).ok) {
      return `hard_deny_protected_dir:${absDir}`;
    }
  }
  return null;
}

function isSafeMediumShellCommand(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return false;
  if (/[;|`]|(\$\()|(>>?)/.test(trimmed)) return false;

  const segments = trimmed.split(/\s*&&\s*/).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) => SAFE_READ_BUILD_TEST_PREFIXES.some((rx) => rx.test(seg.trim())));
}

/**
 * Progressive 4-tier autonomy permission evaluator.
 * - Hard-deny always: secrets.env, .daemon-token, state.db, ~/bot-factory/system, rm -rf /, git push --force, traversal/symlink escapes when boundary enforced.
 * - "spec": allow read/search/inspect only; escalate on writes/shell.
 * - "low": escalate on any file write or shell execution.
 * - "medium": allow in-worktree edits & safe read/build/test commands; escalate on destructive/network/out-of-worktree ops.
 * - "high": allow all inside worktree except hard-deny rules; escalate on out-of-worktree.
 */
export function evaluateAutonomyPermission(
  params: AcpPermissionRequestParams,
  worktreePath: string,
  autonomyLevel: AutonomyLevel = "medium",
  extraProtectedDirs: string[] = [],
  enforceWorktreeBoundary = true,
): AutonomyPermissionEvaluation {
  const title = params.toolCall?.title ?? "";
  const kind = (params.toolCall?.kind ?? "").toLowerCase();
  const locations = (params.toolCall?.locations ?? []).map((l) => l.path).filter((p): p is string => Boolean(p));
  const commandOrPath = locations[0] ?? title;

  const defaultSystemDir = join(homedir(), "bot-factory", "system");
  const protectedDirs = [...new Set([defaultSystemDir, ...extraProtectedDirs].map((d) => resolve(d)))];

  // 1. Hard-deny command & protected file patterns in title
  for (const rule of HARD_DENY_COMMAND_PATTERNS) {
    if (rule.rx.test(title)) {
      return { decision: "deny", reason: rule.reason, commandOrPath };
    }
  }
  for (const dir of protectedDirs) {
    const normTitle = title.replace(/\\/g, "/").toLowerCase();
    const normDir = dir.replace(/\\/g, "/").toLowerCase();
    if (normDir && normTitle.includes(normDir)) {
      return { decision: "deny", reason: `hard_deny_protected_dir:${dir}`, commandOrPath };
    }
  }

  // 2. Location checks: protected files/dirs, traversal/symlink escapes, and out-of-worktree
  let outOfWorktreePath: string | null = null;
  for (const locPath of locations) {
    const protectedHit = isProtectedPathTarget(locPath, worktreePath, protectedDirs);
    if (protectedHit) {
      return { decision: "deny", reason: protectedHit, commandOrPath: locPath };
    }

    const check = isPathStrictlyWithinRoot(worktreePath, locPath);
    if (!check.ok) {
      const isTraversal = isTraversalOrUncPath(locPath) || !isAbsolute(locPath);
      if (enforceWorktreeBoundary && isTraversal) {
        return { decision: "deny", reason: `path_outside_worktree:${locPath}`, commandOrPath: locPath };
      }
      outOfWorktreePath = locPath;
    }
  }

  if (outOfWorktreePath !== null) {
    return {
      decision: "escalate",
      reason: `path_outside_worktree:${outOfWorktreePath}`,
      commandOrPath: outOfWorktreePath,
    };
  }

  const category = classifyToolCategory(kind, title);

  // 3. Tier-specific policy inside worktree
  if (autonomyLevel === "spec") {
    if (category === "read" && !/[;|`]|\$\(|>>?/.test(title)) {
      return { decision: "allow", reason: "spec_read_allowed", commandOrPath };
    }
    return { decision: "escalate", reason: `spec_mode_requires_approval:${category}`, commandOrPath };
  }

  if (autonomyLevel === "low") {
    if (category === "read" && !/[;|`]|\$\(|>>?/.test(title)) {
      return { decision: "allow", reason: "low_read_allowed", commandOrPath };
    }
    return { decision: "escalate", reason: `low_autonomy_requires_approval:${category}`, commandOrPath };
  }

  if (autonomyLevel === "high") {
    for (const rx of DESTRUCTIVE_PATTERNS) {
      if (rx.test(title) && /secrets\.env|format\s+[a-z]:/i.test(title)) {
        return { decision: "deny", reason: `destructive_pattern_blocked:${title.slice(0, 80)}`, commandOrPath };
      }
    }
    return { decision: "allow", reason: "high_autonomy_in_worktree", commandOrPath };
  }

  // "medium" (default)
  if (category === "read") {
    return { decision: "allow", reason: "auto_approved_in_worktree", commandOrPath };
  }
  if (category === "edit") {
    return { decision: "allow", reason: "auto_approved_in_worktree", commandOrPath };
  }
  if (category === "delete") {
    return { decision: "escalate", reason: "delete_requires_human_approval", commandOrPath };
  }
  if (category === "shell") {
    for (const rx of DESTRUCTIVE_PATTERNS) {
      if (rx.test(title)) {
        return { decision: "escalate", reason: `destructive_pattern_blocked:${title.slice(0, 80)}`, commandOrPath };
      }
    }
    for (const rx of NETWORK_COMMAND_PATTERNS) {
      if (rx.test(title)) {
        return { decision: "escalate", reason: `network_command_requires_approval:${title.slice(0, 80)}`, commandOrPath };
      }
    }
    if (isSafeMediumShellCommand(title)) {
      return { decision: "allow", reason: "safe_shell_command_in_worktree", commandOrPath };
    }
    return { decision: "escalate", reason: `shell_command_requires_approval:${title.slice(0, 80)}`, commandOrPath };
  }

  return { decision: "escalate", reason: `unknown_tool_requires_approval:${title.slice(0, 80)}`, commandOrPath };
}

export function resolveAcpPermissionWithAutonomy(
  params: AcpPermissionRequestParams,
  worktreeCwd: string,
  autonomyLevel: AutonomyLevel = "medium",
  opts?: { enforceWorktreeBoundary?: boolean; extraProtectedDirs?: string[] },
): AcpPermissionResolution & AutonomyPermissionEvaluation {
  const options = params.options ?? [];
  const allowOpt = options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
  const commandOrPath = params.toolCall?.locations?.[0]?.path ?? params.toolCall?.title ?? "";
  if (!allowOpt) {
    return {
      outcome: { outcome: "cancelled" },
      escalated: false,
      decision: "deny",
      reason: "no_allow_option_offered",
      commandOrPath,
    };
  }

  const evalRes = evaluateAutonomyPermission(
    params,
    worktreeCwd,
    autonomyLevel,
    opts?.extraProtectedDirs ?? [],
    opts?.enforceWorktreeBoundary ?? true,
  );
  if (evalRes.decision === "allow") {
    return {
      outcome: { outcome: "selected", optionId: allowOpt.optionId },
      escalated: false,
      ...evalRes,
    };
  }
  return {
    outcome: { outcome: "cancelled" },
    escalated: true,
    ...evalRes,
  };
}

/**
 * Pure deterministic ACP permission resolver (backward-compatible medium policy):
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

interface PendingPermissionWaiter {
  record: PendingAcpPermissionRecord;
  timer: ReturnType<typeof setTimeout>;
  resolve: (decision: "allow_once" | "allow_session" | "deny", reason?: string) => void;
}

interface ActiveAcpProcess {
  spec: RuntimeSessionSpec;
  proc: ReturnType<typeof Bun.spawn>;
  externalSessionId: string;
  nextClientReqId: number;
  pendingClientRequests: Map<number, PendingRpc>;
  pendingServerPermissionIds: Set<number | string>;
  sessionAllowedKinds: Set<string>;
  activeTurnAutonomyLevel?: AutonomyLevel;
  systemContextInjected: boolean;
  eventQueue: NormalizedAgentEvent[];
  eventWaiter: (() => void) | null;
  activeTurnTimeoutReset: (() => void) | null;
  activeTurnTimeoutClear: (() => void) | null;
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

function isDevinCommand(command: string): boolean {
  const normalized = command.trim().replace(/\\/g, "/").toLowerCase();
  const base = normalized.split("/").pop() ?? normalized;
  return base === "devin" || base === "devin.exe" || base === "devin.cmd" || base === "devin.bat";
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

function extractTextFromUpdateContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const obj = item as { text?: unknown; content?: { text?: unknown } };
          if (typeof obj.text === "string") return obj.text;
          if (typeof obj.content?.text === "string") return obj.content.text;
        }
        return "";
      })
      .join("");
  }
  if (typeof content === "object") {
    const obj = content as { text?: unknown };
    if (typeof obj.text === "string") return obj.text;
  }
  return "";
}

export class AcpSubprocessRuntime implements AgentRuntime {
  public readonly kind = "acp_stdio" as const;
  private readonly active = new Map<string, ActiveAcpProcess>();
  private readonly pendingPermissions = new Map<string, PendingPermissionWaiter>();
  private readonly requestTimeoutMsOverride?: number;
  private onSessionExit?: (sessionId: string) => void;
  private onPermissionRequest?: (request: PendingAcpPermissionRecord) => void;

  constructor(
    private config: HubConfig,
    private readonly logsDir: string,
    private readonly scrubber: SecretScrubber,
    opts?: {
      requestTimeoutMs?: number;
      onSessionExit?: (sessionId: string) => void;
      onPermissionRequest?: (request: PendingAcpPermissionRecord) => void;
    },
  ) {
    this.requestTimeoutMsOverride = opts?.requestTimeoutMs;
    this.onSessionExit = opts?.onSessionExit;
    this.onPermissionRequest = opts?.onPermissionRequest;
  }

  private getEffectiveTimeoutMs(): number {
    return this.requestTimeoutMsOverride ?? (this.config.guardrails.permissionRequestTimeoutSeconds ?? 120) * 1000;
  }

  public setConfig(newConfig: HubConfig): void {
    this.config = newConfig;
  }

  public setOnSessionExit(handler: ((sessionId: string) => void) | undefined): void {
    this.onSessionExit = handler;
  }

  public setOnPermissionRequest(handler: ((request: PendingAcpPermissionRecord) => void) | undefined): void {
    this.onPermissionRequest = handler;
  }

  public listPendingPermissions(): PendingAcpPermissionRecord[] {
    return [...this.pendingPermissions.values()].map((p) => ({ ...p.record }));
  }

  public resolvePermission(permissionId: string, decision: "allow_once" | "allow_session" | "deny"): boolean {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) return false;
    this.pendingPermissions.delete(permissionId);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    return true;
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
    const providerCfg = this.config.providers[spec.provider] as ExtendedProviderConfig | undefined;
    if (!providerCfg || providerCfg.runtime !== "acp_stdio" || !providerCfg.command) {
      throw new Error(`Invalid ACP provider configuration: ${spec.provider}`);
    }

    const resolvedModelId = providerCfg.models[spec.model]?.id ?? spec.model;
    const baseArgs = [...(providerCfg.args ?? [])];
    const childEnv = buildMinimalAcpEnv();
    if (providerCfg.env) {
      for (const [k, v] of Object.entries(providerCfg.env)) {
        if (k === "BOT_FACTORY_TOKEN") continue;
        childEnv[k] = v;
      }
    }

    if (isDevinCommand(providerCfg.command) && resolvedModelId) {
      if (!childEnv.DEVIN_MODEL) {
        childEnv.DEVIN_MODEL = resolvedModelId;
      }
      if (!baseArgs.includes("--model") && !baseArgs.includes("-m")) {
        baseArgs.push("--model", resolvedModelId);
      }
    }

    const logFile = `${this.logsDir}/${spec.agentId}-acp-stderr.log`;
    mkdirSync(dirname(logFile), { recursive: true });

    const proc = Bun.spawn(buildSpawnCommand(providerCfg.command, baseArgs), {
      cwd: spec.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv,
    });

    const state: ActiveAcpProcess = {
      spec,
      proc,
      externalSessionId: "",
      nextClientReqId: 1,
      pendingClientRequests: new Map(),
      pendingServerPermissionIds: new Set(),
      sessionAllowedKinds: new Set(),
      activeTurnAutonomyLevel: spec.autonomyLevel,
      systemContextInjected: false,
      eventQueue: [],
      eventWaiter: null,
      activeTurnTimeoutReset: null,
      activeTurnTimeoutClear: null,
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

    const handshakeTimeoutMs = Math.min(30_000, this.getEffectiveTimeoutMs());
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
      state.activeTurnAutonomyLevel = input.autonomyLevel ?? state.spec.autonomyLevel ?? "medium";

      const promptParts: string[] = [];
      if (!state.systemContextInjected) {
        state.systemContextInjected = true;
        if (state.spec.systemPrompt.trim()) {
          promptParts.push(`<system_instructions>\n${state.spec.systemPrompt.trim()}\n</system_instructions>`);
        }
        const condensedHistory = formatCondensedHistory(input.history);
        if (condensedHistory) {
          promptParts.push(condensedHistory);
        }
      }
      if (input.ephemeralContext?.trim()) {
        promptParts.push(`<ephemeral_context>\n${input.ephemeralContext.trim()}\n</ephemeral_context>`);
      }
      promptParts.push(input.userText);
      const promptText = promptParts.join("\n\n");

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
        state.activeTurnTimeoutReset = null;
        state.activeTurnTimeoutClear = null;
        this.pushEvent(state, evt);
      };

      const turnTimeoutMs = this.getEffectiveTimeoutMs();
      const armTurnTimer = () => {
        clearTurnTimer();
        if (this.hasPendingPermissionsForSession(state.spec.sessionId)) {
          return;
        }
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
            pending.reject(new Error(`acp_turn_timeout:${turnTimeoutMs}ms`));
          } else {
            finishWithEvent({ type: "error", message: `acp_turn_timeout:${turnTimeoutMs}ms` });
          }
        }, turnTimeoutMs);
      };

      state.activeTurnTimeoutReset = armTurnTimer;
      state.activeTurnTimeoutClear = clearTurnTimer;
      armTurnTimer();

      promptPromise
        .then((res) => {
          const r = (res ?? {}) as {
            usage?: { inputTokens?: number; outputTokens?: number; prompt_tokens?: number; completion_tokens?: number };
          };
          if (r.usage) {
            const tokenIn = r.usage.inputTokens ?? r.usage.prompt_tokens ?? 0;
            const tokenOut = r.usage.outputTokens ?? r.usage.completion_tokens ?? 0;
            if (tokenIn > 0 || tokenOut > 0) {
              this.pushEvent(state, { type: "usage", tokenIn, tokenOut });
            }
          }
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
      state.activeTurnTimeoutReset = null;
      state.activeTurnTimeoutClear = null;
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

  private hasPendingPermissionsForSession(sessionId: string): boolean {
    for (const waiter of this.pendingPermissions.values()) {
      if (waiter.record.sessionId === sessionId) return true;
    }
    return false;
  }

  private cancelPendingWaitersForSession(sessionId: string): void {
    for (const [permId, waiter] of this.pendingPermissions.entries()) {
      if (waiter.record.sessionId === sessionId) {
        this.pendingPermissions.delete(permId);
        clearTimeout(waiter.timer);
        waiter.resolve("deny", "session_cancelled");
      }
    }
  }

  private flushPendingPermissionsCancelled(state: ActiveAcpProcess): void {
    this.cancelPendingWaitersForSession(state.spec.sessionId);
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
    if (evt.type !== "done" && evt.type !== "error" && evt.type !== "permission_requested") {
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
    this.cancelPendingWaitersForSession(state.spec.sessionId);
    state.pendingServerPermissionIds.clear();
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

  private async pauseForInteractivePermission(
    state: ActiveAcpProcess,
    reqId: number | string,
    params: AcpPermissionRequestParams,
    evalRes: AutonomyPermissionEvaluation,
    allowOnceOptionId: string,
    allowAlwaysOptionId: string,
  ): Promise<void> {
    const permissionId = `perm_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const timeoutMs = this.getEffectiveTimeoutMs();
    const now = Date.now();
    const title = this.scrubber.scrub(String(params.toolCall?.title ?? evalRes.commandOrPath ?? "Permission request"));
    const commandOrPath = this.scrubber.scrub(evalRes.commandOrPath);
    const reason = this.scrubber.scrub(evalRes.reason);
    const kind = (params.toolCall?.kind ?? "").toLowerCase();
    const permClassKey = kind || title.split(/\s+/)[0]?.toLowerCase() || "tool";

    const record: PendingAcpPermissionRecord = {
      permissionId,
      agentId: state.spec.agentId,
      sessionId: state.spec.sessionId,
      title,
      commandOrPath,
      reason,
      timeoutMs,
      createdAt: now,
      expiresAt: now + timeoutMs,
    };

    const result = await new Promise<{ decision: "allow_once" | "allow_session" | "deny"; reasonOverride?: string }>(
      (resolveWait) => {
        const timer = setTimeout(() => {
          this.pendingPermissions.delete(permissionId);
          resolveWait({ decision: "deny", reasonOverride: `permission_timeout:${reason}` });
        }, timeoutMs);

        this.pendingPermissions.set(permissionId, {
          record,
          timer,
          resolve: (decision, reasonOverride) => resolveWait({ decision, reasonOverride }),
        });

        state.activeTurnTimeoutClear?.();

        this.pushEvent(state, {
          type: "permission_requested",
          permissionId,
          agentId: state.spec.agentId,
          sessionId: state.spec.sessionId,
          title,
          commandOrPath,
          reason,
          timeoutMs,
        });

        try {
          this.onPermissionRequest?.({ ...record });
        } catch {
          // ignore listener errors
        }
      },
    );

    if (!this.hasPendingPermissionsForSession(state.spec.sessionId) && !state.stopping && !state.closed) {
      state.activeTurnTimeoutReset?.();
    }

    if (!state.pendingServerPermissionIds.delete(reqId)) {
      return;
    }

    if (state.stopping || state.closed) {
      try {
        this.writeJsonLine(state, { jsonrpc: "2.0", id: reqId, result: { outcome: { outcome: "cancelled" } } });
      } catch {
        // ignore if stdin closed
      }
      return;
    }

    if (result.decision === "allow_once") {
      this.writeJsonLine(state, {
        jsonrpc: "2.0",
        id: reqId,
        result: { outcome: { outcome: "selected", optionId: allowOnceOptionId } },
      });
      return;
    }

    if (result.decision === "allow_session") {
      state.sessionAllowedKinds.add(permClassKey);
      this.writeJsonLine(state, {
        jsonrpc: "2.0",
        id: reqId,
        result: { outcome: { outcome: "selected", optionId: allowAlwaysOptionId } },
      });
      return;
    }

    if (result.reasonOverride && result.reasonOverride !== "session_cancelled") {
      this.pushEvent(state, {
        type: "permission_escalated",
        requestId: permissionId,
        reason: result.reasonOverride,
      });
    }
    this.writeJsonLine(state, { jsonrpc: "2.0", id: reqId, result: { outcome: { outcome: "cancelled" } } });
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
      const permParams = params as AcpPermissionRequestParams;
      const options = permParams.options ?? [];
      const allowOnceOpt = options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
      const allowAlwaysOpt = options.find((o) => o.kind === "allow_always") ?? allowOnceOpt;

      if (!allowOnceOpt) {
        this.writeJsonLine(state, { jsonrpc: "2.0", id: reqId, result: { outcome: { outcome: "cancelled" } } });
        return;
      }

      const autonomyLevel = state.activeTurnAutonomyLevel ?? state.spec.autonomyLevel ?? "medium";
      const systemDir = join(resolve(this.config.hub.rootDir.startsWith("~") ? join(homedir(), this.config.hub.rootDir.slice(2)) : this.config.hub.rootDir), "system");
      const evalRes = evaluateAutonomyPermission(
        permParams,
        state.spec.cwd,
        autonomyLevel,
        [systemDir],
        this.config.guardrails.acpWorktreeBoundaryEnforced,
      );

      if (evalRes.decision === "deny") {
        this.pushEvent(state, {
          type: "permission_escalated",
          requestId: String(reqId),
          reason: this.scrubber.scrub(evalRes.reason),
        });
        this.writeJsonLine(state, { jsonrpc: "2.0", id: reqId, result: { outcome: { outcome: "cancelled" } } });
        return;
      }

      const kind = (permParams.toolCall?.kind ?? "").toLowerCase();
      const title = String(permParams.toolCall?.title ?? "");
      const permClassKey = kind || title.split(/\s+/)[0]?.toLowerCase() || "tool";

      if (evalRes.decision === "allow" || state.sessionAllowedKinds.has(permClassKey)) {
        this.writeJsonLine(state, {
          jsonrpc: "2.0",
          id: reqId,
          result: { outcome: { outcome: "selected", optionId: allowOnceOpt.optionId } },
        });
        return;
      }

      state.pendingServerPermissionIds.add(reqId);
      void this.pauseForInteractivePermission(
        state,
        reqId,
        permParams,
        evalRes,
        allowOnceOpt.optionId,
        allowAlwaysOpt?.optionId ?? allowOnceOpt.optionId,
      );
      return;
    }

    // Streaming notifications
    if (method === "session/update") {
      const update = (params.update ?? params) as Record<string, unknown>;
      const kind = String(update.sessionUpdate ?? update.type ?? "");
      if (kind === "agent_message_chunk") {
        const text = extractTextFromUpdateContent(update.content);
        if (text) this.pushEvent(state, { type: "text_delta", text: this.scrubber.scrub(text) });
      } else if (kind === "agent_thought_chunk") {
        const text = extractTextFromUpdateContent(update.content);
        if (text) this.pushEvent(state, { type: "thought", text: this.scrubber.scrub(text) });
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        const toolCallId = String(update.toolCallId ?? "unknown");
        const rawStatus = String(update.status ?? "in_progress");
        const status =
          rawStatus === "completed" || rawStatus === "failed" || rawStatus === "pending" ? rawStatus : "in_progress";
        const locations = (update.locations as Array<{ path?: string }> | undefined) ?? [];

        let filePath = locations[0]?.path ? this.scrubber.scrub(locations[0].path) : undefined;
        let diffPreview: string | undefined;
        let output: string | undefined;

        if (Array.isArray(update.content)) {
          const textParts: string[] = [];
          for (const entry of update.content as Array<Record<string, unknown>>) {
            if (entry.type === "diff") {
              if (!filePath && typeof entry.path === "string") {
                filePath = this.scrubber.scrub(entry.path);
              }
              if (typeof entry.newText === "string") {
                diffPreview = this.scrubber.scrub(entry.newText.slice(0, 1200));
              }
            } else {
              const t = extractTextFromUpdateContent(entry.content ?? entry);
              if (t) textParts.push(t);
            }
          }
          if (textParts.length > 0) {
            output = this.scrubber.scrub(textParts.join("\n"));
          }
        }
        if (!output && update.rawOutput !== undefined) {
          const rawStr = typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput);
          output = this.scrubber.scrub(rawStr);
        }

        const rawInput = update.rawInput as { command?: string } | undefined;
        const fallbackTitle = rawInput?.command ? String(rawInput.command) : toolCallId;

        this.pushEvent(state, {
          type: "tool_call",
          toolCallId,
          title: this.scrubber.scrub(String(update.title ?? fallbackTitle)),
          status,
          filePath,
          diffPreview,
          output,
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
      } else if (kind === "usage_update") {
        const usage = (update.usage ?? update) as {
          inputTokens?: number;
          outputTokens?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
        };
        const tokenIn = usage.inputTokens ?? usage.prompt_tokens ?? 0;
        const tokenOut = usage.outputTokens ?? usage.completion_tokens ?? 0;
        if (tokenIn > 0 || tokenOut > 0) {
          this.pushEvent(state, { type: "usage", tokenIn, tokenOut });
        }
      }
    }
  }
}
