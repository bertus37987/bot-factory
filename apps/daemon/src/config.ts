import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { HubConfigSchema, type HubConfig } from "@bot-factory/shared";

export function expandHome(inputPath: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return join(homedir(), inputPath.slice(2));
  }
  return resolve(inputPath);
}

export type ConfigSourceKind = "primary" | "system_example" | "inline_defaults";
export type SecretSource = "secrets_env" | "process_env" | "none";

export interface SecretPresence {
  key: string;
  present: boolean;
  source: SecretSource;
}

export interface LoadedRuntimeConfig {
  config: HubConfig;
  rootDir: string;
  systemDir: string;
  configPath: string;
  secretsPath: string;
  dbPath: string;
  projectsDir: string;
  memoryDir: string;
  logsDir: string;
  pluginsDir: string;
  stagingDir: string;
  backupsDir: string;
  secrets: Record<string, string>;
  sessionToken: string;
}

export interface ResolvedHubConfigInspection {
  config: HubConfig;
  configSource: ConfigSourceKind;
  configSourcePath: string | null;
  rootDir: string;
  systemDir: string;
  configPath: string;
  secretsPath: string;
  dbPath: string;
  projectsDir: string;
  memoryDir: string;
  logsDir: string;
  pluginsDir: string;
  stagingDir: string;
  backupsDir: string;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function renameSyncWithRetry(src: string, dst: string, maxRetries = 4, backoffMs = 50): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(src, dst);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if ((code === "EPERM" || code === "EBUSY") && attempt < maxRetries) {
        Atomics.wait(sab, 0, 0, backoffMs);
        continue;
      }
      throw err;
    }
  }
}

function atomicWriteEnvFile(targetPath: string, content: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    renameSyncWithRetry(tmp, targetPath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

function formatEnvValue(value: string): string {
  const needsQuotes = value !== value.trim() || value.startsWith('"') || value.startsWith("'");
  if (!needsQuotes) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw new Error("invalid_secret_value");
}

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && val) out[key] = val;
  }
  return out;
}

export function writeSecretToEnvFile(
  secretsPath: string,
  key: string,
  value: string,
  loadedSecrets?: Record<string, string>,
): void {
  if (!ENV_KEY_RE.test(key)) {
    throw new Error("invalid_secret_key");
  }
  if (typeof value !== "string" || /[\r\n\0]/.test(value) || value.trim().length === 0) {
    throw new Error("invalid_secret_value");
  }

  const formatted = `${key}=${formatEnvValue(value)}`;
  const existingLines = existsSync(secretsPath)
    ? readFileSync(secretsPath, "utf8").split(/\r?\n/)
    : [];
  if (existingLines.length > 0 && existingLines[existingLines.length - 1] === "") {
    existingLines.pop();
  }

  const nextLines: string[] = [];
  let replaced = false;
  for (const line of existingLines) {
    const match = ENV_LINE_RE.exec(line);
    if (match?.[1] === key) {
      if (!replaced) {
        nextLines.push(formatted);
        replaced = true;
      }
      continue;
    }
    nextLines.push(line);
  }
  if (!replaced) {
    nextLines.push(formatted);
  }

  atomicWriteEnvFile(secretsPath, `${nextLines.join("\n")}\n`);
  if (loadedSecrets) {
    loadedSecrets[key] = value;
  }
}

export function deleteSecretFromEnvFile(
  secretsPath: string,
  key: string,
  loadedSecrets?: Record<string, string>,
): boolean {
  if (!ENV_KEY_RE.test(key)) {
    throw new Error("invalid_secret_key");
  }

  let removed = false;
  if (existsSync(secretsPath)) {
    const existingLines = readFileSync(secretsPath, "utf8").split(/\r?\n/);
    if (existingLines.length > 0 && existingLines[existingLines.length - 1] === "") {
      existingLines.pop();
    }
    const nextLines: string[] = [];
    for (const line of existingLines) {
      const match = ENV_LINE_RE.exec(line);
      if (match?.[1] === key) {
        removed = true;
        continue;
      }
      nextLines.push(line);
    }
    if (removed) {
      atomicWriteEnvFile(secretsPath, nextLines.length > 0 ? `${nextLines.join("\n")}\n` : "");
    }
  }

  if (loadedSecrets) {
    const envVal = process.env[key];
    if (envVal) loadedSecrets[key] = envVal;
    else delete loadedSecrets[key];
  }
  return removed;
}

export function listSecretPresence(secretsPath: string, config: HubConfig): SecretPresence[] {
  const fileSecrets = existsSync(secretsPath) ? parseEnvFile(readFileSync(secretsPath, "utf8")) : {};
  const keys = new Set<string>();
  for (const provider of Object.values(config.providers)) {
    if (provider.apiKeyEnv) keys.add(provider.apiKeyEnv);
  }
  for (const k of Object.keys(fileSecrets)) {
    keys.add(k);
  }

  const out: SecretPresence[] = [];
  for (const key of keys) {
    const fromFile = Boolean(fileSecrets[key]);
    const fromEnv = Boolean(process.env[key]);
    const source: SecretSource = fromFile ? "secrets_env" : fromEnv ? "process_env" : "none";
    out.push({
      key,
      present: fromFile || fromEnv,
      source,
    });
  }
  return out;
}

function buildInlineDefaultHubConfig(
  defaultRoot: string,
  systemDir: string,
  overrides?: { dbPath?: string; port?: number },
): Record<string, unknown> {
  return {
    version: "1.0",
    hub: {
      rootDir: defaultRoot,
      host: "127.0.0.1",
      port: overrides?.port ?? 4310,
      dbPath: overrides?.dbPath ?? join(systemDir, "state.db"),
      secretsEnvPath: join(systemDir, "secrets.env"),
      defaultProjectsDir: join(defaultRoot, "projects"),
    },
    providers: {
      "mistral-hosted": {
        runtime: "native_http",
        protocol: "openai_compatible",
        baseUrl: "https://api.mistral.ai/v1",
        apiKeyEnv: "MISTRAL_API_KEY",
        models: {
          "mistral-large-4": { id: "mistral-large-4", capabilities: ["reasoning", "planning", "review", "coding"], tier: "flagship" },
          "glm-5.3": { id: "glm-5.3", capabilities: ["coding", "docs", "general"], tier: "balanced" },
          "glm-5.3-flash": { id: "glm-5.3-flash", capabilities: ["fast", "sidekick", "dreaming", "search", "triage"], tier: "fast" },
        },
      },
      "google-antigravity": {
        runtime: "native_http",
        protocol: "google_gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKeyEnv: "GEMINI_API_KEY",
        models: {
          "gemini-4-hydrogen": { id: "gemini-4-hydrogen", capabilities: ["multimodal", "vision", "review", "long_context", "coding"], tier: "flagship" },
          "gemini-4-neon": { id: "gemini-4-neon", capabilities: ["multimodal", "vision", "reasoning", "architecture", "review"], tier: "flagship" },
        },
      },
      "devin-acp": {
        runtime: "acp_stdio",
        command: "devin",
        args: ["acp"],
        models: {
          "swe-2-max": { id: "swe-2-max", capabilities: ["coding_deep", "refactor", "debug", "autonomous_slice"], tier: "flagship" },
        },
      },
    },
    routing: {
      policy: "task_adaptive",
      allowPerProjectOverride: true,
      allowPerTaskOverride: true,
      defaultsByIntent: {
        meta_orchestrator: { provider: "mistral-hosted", model: "mistral-large-4" },
        project_manager: { provider: "mistral-hosted", model: "mistral-large-4" },
        coding_deep: { provider: "devin-acp", model: "swe-2-max" },
        coding_parallel: { provider: "mistral-hosted", model: "glm-5.3" },
        multimodal_review: { provider: "google-antigravity", model: "gemini-4-neon" },
        vision_fix: { provider: "google-antigravity", model: "gemini-4-hydrogen" },
        sidekick: { provider: "mistral-hosted", model: "glm-5.3-flash" },
        memory_dreaming: { provider: "mistral-hosted", model: "glm-5.3-flash" },
        verifier_default: { provider: "google-antigravity", model: "gemini-4-hydrogen" },
      },
      crossFamilyVerification: true,
    },
    memory: {
      provider: "local_sqlite_superhermes",
      l1Files: {
        globalUser: { file: "USER.md", maxChars: 2000 },
        globalMemory: { file: "GLOBAL_MEMORY.md", maxChars: 3000 },
        projectMemory: { file: "MEMORY.md", maxChars: 3000 },
      },
      pluginPromptCaps: { maxCharsPerBlock: 4000, maxCharsTotal: 8000 },
      dreaming: { mode: "dynamic", debounceSeconds: 20, maxBatchDocs: 8, modelIntent: "memory_dreaming" },
      graphMaxHops: 3,
      defaultDecaySweepIntervalMinutes: 30,
    },
    guardrails: {
      maxConcurrentBotsPerProject: 4,
      maxDebateRounds: 3,
      maxAnnotationFixRetries: 2,
      permissionRequestTimeoutSeconds: 120,
      acpWorktreeBoundaryEnforced: true,
      redactSecretsInLogsAndMemory: true,
      selfModRequiresStagingAndVerifier: true,
    },
  };
}

/** Read-only resolution of root, config source, and runtime paths (safe for CLI diagnostics). */
export function resolveHubConfigInspection(overrides?: {
  configPath?: string;
  rootDir?: string;
  dbPath?: string;
  port?: number;
}): ResolvedHubConfigInspection {
  const envRoot = process.env.BOT_FACTORY_ROOT?.trim() || undefined;
  const explicitRoot = overrides?.rootDir?.trim() || envRoot;
  const defaultRoot = expandHome(explicitRoot ?? "~/bot-factory");
  const systemDir = join(defaultRoot, "system");
  const primaryPath = overrides?.configPath ? expandHome(overrides.configPath) : join(systemDir, "config.json");
  const systemExamplePath = join(systemDir, "config.example.json");

  let raw: unknown = {};
  let configSource: ConfigSourceKind;
  let configSourcePath: string | null;
  if (existsSync(primaryPath)) {
    raw = JSON.parse(readFileSync(primaryPath, "utf8"));
    configSource = "primary";
    configSourcePath = primaryPath;
  } else if (existsSync(systemExamplePath)) {
    raw = JSON.parse(readFileSync(systemExamplePath, "utf8"));
    configSource = "system_example";
    configSourcePath = systemExamplePath;
  } else {
    // Phase 2 will wire bundled repo config.example.json once EXCLUSIVE_MODEL_ROSTER is unlocked.
    raw = buildInlineDefaultHubConfig(defaultRoot, systemDir, overrides);
    configSource = "inline_defaults";
    configSourcePath = null;
  }

  const parsed = HubConfigSchema.parse(raw);
  if (overrides?.port !== undefined) parsed.hub.port = overrides.port;

  const rootDir = explicitRoot ? expandHome(explicitRoot) : expandHome(parsed.hub.rootDir);
  const resolvedSystemDir = join(rootDir, "system");
  const dbPath = overrides?.dbPath
    ? expandHome(overrides.dbPath)
    : explicitRoot
      ? join(resolvedSystemDir, "state.db")
      : expandHome(parsed.hub.dbPath);
  const projectsDir = explicitRoot
    ? join(rootDir, "projects")
    : expandHome(parsed.hub.defaultProjectsDir);
  const secretsPath = explicitRoot
    ? join(resolvedSystemDir, "secrets.env")
    : expandHome(parsed.hub.secretsEnvPath);

  return {
    config: parsed,
    configSource,
    configSourcePath,
    rootDir,
    systemDir: resolvedSystemDir,
    configPath: primaryPath,
    secretsPath,
    dbPath,
    projectsDir,
    memoryDir: join(resolvedSystemDir, "memory"),
    logsDir: join(resolvedSystemDir, "logs"),
    pluginsDir: join(resolvedSystemDir, "plugins"),
    stagingDir: join(resolvedSystemDir, "staging"),
    backupsDir: join(resolvedSystemDir, "backups"),
  };
}

export function loadHubConfig(overrides?: {
  configPath?: string;
  rootDir?: string;
  dbPath?: string;
  port?: number;
}): LoadedRuntimeConfig {
  const resolved = resolveHubConfigInspection(overrides);

  for (const dir of [
    resolved.systemDir,
    dirname(resolved.dbPath),
    resolved.projectsDir,
    resolved.memoryDir,
    resolved.logsDir,
    resolved.pluginsDir,
    resolved.stagingDir,
    resolved.backupsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const fileSecrets = existsSync(resolved.secretsPath)
    ? parseEnvFile(readFileSync(resolved.secretsPath, "utf8"))
    : {};

  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(fileSecrets)) {
    secrets[k] = v;
  }
  for (const provider of Object.values(resolved.config.providers)) {
    if (provider.apiKeyEnv && !secrets[provider.apiKeyEnv]) {
      const envVal = process.env[provider.apiKeyEnv];
      if (envVal) secrets[provider.apiKeyEnv] = envVal;
    }
  }

  const tokenFile = join(resolved.systemDir, ".daemon-token");
  let sessionToken = process.env.BOT_FACTORY_TOKEN ?? "";
  if (!sessionToken) {
    if (existsSync(tokenFile)) {
      sessionToken = readFileSync(tokenFile, "utf8").trim();
    }
    if (!sessionToken) {
      sessionToken = `bf_${crypto.randomUUID().replace(/-/g, "")}`;
      writeFileSync(tokenFile, sessionToken, { encoding: "utf8", mode: 0o600 });
    }
  }
  secrets.BOT_FACTORY_TOKEN = sessionToken;

  return {
    config: resolved.config,
    rootDir: resolved.rootDir,
    systemDir: resolved.systemDir,
    configPath: resolved.configPath,
    secretsPath: resolved.secretsPath,
    dbPath: resolved.dbPath,
    projectsDir: resolved.projectsDir,
    memoryDir: resolved.memoryDir,
    logsDir: resolved.logsDir,
    pluginsDir: resolved.pluginsDir,
    stagingDir: resolved.stagingDir,
    backupsDir: resolved.backupsDir,
    secrets,
    sessionToken,
  };
}

export class SecretScrubber {
  private values: string[] = [];

  constructor(secrets: Record<string, string>) {
    this.updateSecrets(secrets);
  }

  public updateSecrets(secrets: Record<string, string>): void {
    this.values = Object.values(secrets)
      .filter((v) => v && v.length >= 8)
      .sort((a, b) => b.length - a.length);
  }

  scrub(text: string): string {
    if (!text) return text;
    let out = text;
    for (const secret of this.values) {
      if (out.includes(secret)) {
        out = out.split(secret).join("[REDACTED_SECRET]");
      }
    }
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-]{16,}/gi, "$1[REDACTED_TOKEN]");
    out = out.replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*["']?)[A-Za-z0-9._\-]{16,}/gi, "$1[REDACTED]");
    return out;
  }
}
