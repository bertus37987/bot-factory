import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HubConfigSchema, type HubConfig } from "@bot-factory/shared";

export function expandHome(inputPath: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return join(homedir(), inputPath.slice(2));
  }
  return resolve(inputPath);
}

export interface LoadedRuntimeConfig {
  config: HubConfig;
  rootDir: string;
  systemDir: string;
  configPath: string;
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

export function loadHubConfig(overrides?: {
  configPath?: string;
  rootDir?: string;
  dbPath?: string;
  port?: number;
}): LoadedRuntimeConfig {
  const defaultRoot = expandHome(overrides?.rootDir ?? "~/bot-factory");
  const systemDir = join(defaultRoot, "system");
  const primaryPath = overrides?.configPath ?? join(systemDir, "config.json");
  const examplePath = join(systemDir, "config.example.json");

  let raw: unknown = {};
  if (existsSync(primaryPath)) {
    raw = JSON.parse(readFileSync(primaryPath, "utf8"));
  } else if (existsSync(examplePath)) {
    raw = JSON.parse(readFileSync(examplePath, "utf8"));
  } else {
    raw = {
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

  const parsed = HubConfigSchema.parse(raw);
  if (overrides?.port !== undefined) parsed.hub.port = overrides.port;

  const rootDir = overrides?.rootDir ? expandHome(overrides.rootDir) : expandHome(parsed.hub.rootDir);
  const resolvedSystemDir = join(rootDir, "system");
  const dbPath = overrides?.dbPath
    ? expandHome(overrides.dbPath)
    : overrides?.rootDir
      ? join(resolvedSystemDir, "state.db")
      : expandHome(parsed.hub.dbPath);
  const projectsDir = overrides?.rootDir
    ? join(rootDir, "projects")
    : expandHome(parsed.hub.defaultProjectsDir);
  const memoryDir = join(resolvedSystemDir, "memory");
  const logsDir = join(resolvedSystemDir, "logs");
  const pluginsDir = join(resolvedSystemDir, "plugins");
  const stagingDir = join(resolvedSystemDir, "staging");
  const backupsDir = join(resolvedSystemDir, "backups");
  const resolvedConfigPath = overrides?.configPath ? expandHome(overrides.configPath) : join(resolvedSystemDir, "config.json");

  for (const dir of [resolvedSystemDir, dirname(dbPath), projectsDir, memoryDir, logsDir, pluginsDir, stagingDir, backupsDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const secretsPath = overrides?.rootDir
    ? join(resolvedSystemDir, "secrets.env")
    : expandHome(parsed.hub.secretsEnvPath);
  const fileSecrets = existsSync(secretsPath) ? parseEnvFile(readFileSync(secretsPath, "utf8")) : {};

  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(fileSecrets)) {
    secrets[k] = v;
  }
  for (const provider of Object.values(parsed.providers)) {
    if (provider.apiKeyEnv && !secrets[provider.apiKeyEnv]) {
      const envVal = process.env[provider.apiKeyEnv];
      if (envVal) secrets[provider.apiKeyEnv] = envVal;
    }
  }

  const tokenFile = join(resolvedSystemDir, ".daemon-token");
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
    config: parsed,
    rootDir,
    systemDir: resolvedSystemDir,
    configPath: resolvedConfigPath,
    dbPath,
    projectsDir,
    memoryDir,
    logsDir,
    pluginsDir,
    stagingDir,
    backupsDir,
    secrets,
    sessionToken,
  };
}

export class SecretScrubber {
  private readonly values: string[];

  constructor(secrets: Record<string, string>) {
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
