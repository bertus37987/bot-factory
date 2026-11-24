import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  HubConfigSchema,
  type HubConfig,
  type SelfModKind,
  type SelfModProposalRecord,
  type VerificationCheckResult,
} from "@bot-factory/shared";

import type { LoadedRuntimeConfig, SecretScrubber } from "../config";
import { isPathStrictlyWithinRoot } from "../runtimes/nativeHttpRuntime";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_FIELD_NAME_RE =
  /^(?:api[_-]?key|secret|token|password|private[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token)$/i;
const PLAINTEXT_SECRET_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: "sk- token", regex: /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{16,}/ },
  { label: "Google AIza key", regex: /\bAIza[0-9A-Za-z_-]{20,}/ },
  { label: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: "GitHub PAT", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { label: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{16,}/ },
  { label: "Bearer token", regex: /Bearer\s+[A-Za-z0-9._\-]{16,}/i },
  { label: "private key PEM", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const IMMUTABLE_HUB_KEYS = ["rootDir", "dbPath", "secretsEnvPath", "defaultProjectsDir"] as const;

function scanForEmbeddedSecrets(
  value: unknown,
  path: string,
  errors: string[],
  seen = new WeakSet<object>(),
  depth = 0,
): void {
  if (depth > 20 || value === null || value === undefined) return;
  if (typeof value === "string") {
    for (const pat of PLAINTEXT_SECRET_PATTERNS) {
      if (pat.regex.test(value)) {
        errors.push(`embedded plaintext ${pat.label} detected at "${path}"`);
      }
    }
    return;
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanForEmbeddedSecrets(value[i], `${path}[${i}]`, errors, seen, depth + 1);
    }
    return;
  }

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${k}` : k;
    if (SECRET_FIELD_NAME_RE.test(k) && typeof v === "string" && v.trim().length > 0) {
      errors.push(`plaintext secret field "${childPath}" is forbidden (use apiKeyEnv and secrets.env)`);
      continue;
    }
    scanForEmbeddedSecrets(v, childPath, errors, seen, depth + 1);
  }
}

function isAllowedNativeHttpBaseUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "https:") return parsed.hostname.length > 0;
    if (parsed.protocol === "http:") return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
    return false;
  } catch {
    return false;
  }
}

/**
 * Validate a candidate HubConfig against Open BYOS schema, network boundary,
 * plaintext-secret exclusion, routing completeness, and guardrail monotonicity.
 */
export function validateOpenByosConfigPatch(
  candidateConfig: unknown,
  currentConfig?: HubConfig,
): { ok: boolean; errors: string[]; config?: HubConfig } {
  const errors: string[] = [];
  scanForEmbeddedSecrets(candidateConfig, "", errors);

  const parsed = HubConfigSchema.safeParse(candidateConfig);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const loc = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      errors.push(`${loc}: ${issue.message}`);
    }
    return { ok: false, errors };
  }

  const config = parsed.data;
  if (config.hub.host !== "127.0.0.1") {
    errors.push(`hub.host must be "127.0.0.1" (got ${JSON.stringify(config.hub.host)})`);
  }

  if (currentConfig) {
    for (const key of IMMUTABLE_HUB_KEYS) {
      if (config.hub[key] !== currentConfig.hub[key]) {
        errors.push(`hub.${key} is immutable`);
      }
    }
    if (currentConfig.guardrails.selfModRequiresStagingAndVerifier && !config.guardrails.selfModRequiresStagingAndVerifier) {
      errors.push("guardrails.selfModRequiresStagingAndVerifier must remain true");
    }
    if (currentConfig.guardrails.acpWorktreeBoundaryEnforced && !config.guardrails.acpWorktreeBoundaryEnforced) {
      errors.push("guardrails.acpWorktreeBoundaryEnforced must remain true");
    }
    if (currentConfig.guardrails.redactSecretsInLogsAndMemory && !config.guardrails.redactSecretsInLogsAndMemory) {
      errors.push("guardrails.redactSecretsInLogsAndMemory must remain true");
    }
  }

  if (!config.guardrails.selfModRequiresStagingAndVerifier) {
    errors.push("guardrails.selfModRequiresStagingAndVerifier must remain true");
  }
  if (!config.guardrails.acpWorktreeBoundaryEnforced) {
    errors.push("guardrails.acpWorktreeBoundaryEnforced must remain true");
  }
  if (!config.guardrails.redactSecretsInLogsAndMemory) {
    errors.push("guardrails.redactSecretsInLogsAndMemory must remain true");
  }
  if (config.guardrails.permissionRequestTimeoutSeconds < 15) {
    errors.push("guardrails.permissionRequestTimeoutSeconds must be >= 15");
  }

  const providerEntries = Object.entries(config.providers);
  if (providerEntries.length === 0) {
    errors.push("providers must define at least one provider");
  }

  for (const [providerId, provider] of providerEntries) {
    if (Object.keys(provider.models).length === 0) {
      errors.push(`provider "${providerId}" must define at least one model`);
    }
    if (provider.apiKeyEnv !== undefined && !ENV_VAR_NAME_RE.test(provider.apiKeyEnv)) {
      errors.push(`provider "${providerId}" apiKeyEnv must be an env var name (got ${JSON.stringify(provider.apiKeyEnv)})`);
    }
    if (provider.env) {
      for (const envKey of Object.keys(provider.env)) {
        if (!ENV_VAR_NAME_RE.test(envKey)) {
          errors.push(`provider "${providerId}" env key "${envKey}" is not a valid env var name`);
        }
      }
    }
    if (provider.runtime === "native_http") {
      if (!provider.baseUrl) {
        errors.push(`provider "${providerId}" (native_http) must define baseUrl`);
      } else if (!isAllowedNativeHttpBaseUrl(provider.baseUrl)) {
        errors.push(
          `provider "${providerId}" baseUrl must use https:// or loopback http:// (127.0.0.1, localhost, [::1])`,
        );
      }
    } else if (provider.runtime === "acp_stdio" || provider.runtime === "cli_stream") {
      if (!provider.command || provider.command.trim().length === 0) {
        errors.push(`provider "${providerId}" (${provider.runtime}) must define command`);
      }
      if (provider.runtime === "cli_stream" && !provider.adapter) {
        errors.push(`provider "${providerId}" (cli_stream) must define adapter ("claude" or "codex")`);
      }
    }
  }

  for (const [intent, target] of Object.entries(config.routing.defaultsByIntent)) {
    const prov = config.providers[target.provider];
    if (!prov) {
      errors.push(`routing intent "${intent}" targets unknown provider "${target.provider}"`);
    } else if (!prov.models[target.model]) {
      errors.push(`routing intent "${intent}" targets unknown model "${target.provider}/${target.model}"`);
    }
  }

  if (config.memory.embeddings) {
    const embProv = config.providers[config.memory.embeddings.provider];
    if (!embProv) {
      errors.push(`memory.embeddings targets unknown provider "${config.memory.embeddings.provider}"`);
    } else if (
      !embProv.models[config.memory.embeddings.model] &&
      embProv.embeddingModel !== config.memory.embeddings.model
    ) {
      errors.push(
        `memory.embeddings targets unknown model "${config.memory.embeddings.provider}/${config.memory.embeddings.model}"`,
      );
    }
  }

  // Deduplicate repeated guardrail messages when currentConfig is also present
  const deduped = Array.from(new Set(errors));
  return deduped.length === 0 ? { ok: true, errors: [], config } : { ok: false, errors: deduped };
}

const PLUGIN_TARGET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const FORBIDDEN_MERGE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(patch)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(base)) {
      if (!FORBIDDEN_MERGE_KEYS.has(k)) out[k] = v;
    }
    for (const [key, value] of Object.entries(patch)) {
      if (FORBIDDEN_MERGE_KEYS.has(key) || value === undefined) continue;
      if (value === null) {
        delete out[key];
        continue;
      }
      const hasOwn = Object.prototype.hasOwnProperty.call(out, key);
      out[key] = hasOwn ? deepMerge(out[key], value) : deepMerge(undefined, value);
    }
    return out;
  }
  if (isPlainObject(patch)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (FORBIDDEN_MERGE_KEYS.has(key) || value === undefined || value === null) continue;
      out[key] = deepMerge(undefined, value);
    }
    return out;
  }
  return patch;
}

/** Merge a JSON patch object onto a base HubConfig and validate against Open BYOS guardrails. */
export function mergeOpenByosConfigPatch(
  baseConfig: HubConfig,
  patch: Record<string, unknown>,
  currentConfig: HubConfig = baseConfig,
): HubConfig {
  if (isPlainObject(patch.hub)) {
    for (const lockedKey of IMMUTABLE_HUB_KEYS) {
      if (lockedKey in patch.hub) {
        throw new Error(`config_patch_rejected: hub.${lockedKey} is immutable`);
      }
    }
  }
  const merged = deepMerge(baseConfig, patch);
  const check = validateOpenByosConfigPatch(merged, currentConfig);
  if (!check.ok || !check.config) {
    throw new Error(`config_patch_rejected: ${check.errors.join("; ")}`);
  }
  return check.config;
}

/**
 * Safely read active promoted `<id>/plugin.md` blocks inside `system/plugins/`
 * for Tier-3 frozen system prompt injection.
 */
export function loadActivePluginBlocks(pluginsDir: string): Array<{ id: string; content: string }> {
  if (!existsSync(pluginsDir)) return [];
  try {
    const rootStat = lstatSync(pluginsDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
  } catch {
    return [];
  }

  const entries = readdirSync(pluginsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const blocks: Array<{ id: string; content: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!PLUGIN_TARGET_ID_RE.test(entry.name)) continue;

    const pluginPath = join(pluginsDir, entry.name, "plugin.md");
    if (!existsSync(pluginPath)) continue;

    const pathCheck = isPathStrictlyWithinRoot(pluginsDir, pluginPath);
    if (!pathCheck.ok) continue;

    try {
      const fileStat = lstatSync(pathCheck.absTarget);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) continue;
      const content = readFileSync(pathCheck.absTarget, "utf8").trim();
      if (content.length > 0) {
        blocks.push({ id: entry.name, content });
      }
    } catch {
      // Skip unreadable or concurrently removed plugin files
    }
  }
  return blocks;
}

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

export class SelfModManager {
  constructor(
    private readonly runtimeCfg: LoadedRuntimeConfig,
    private readonly scrubber: SecretScrubber,
  ) {}

  public stageProposal(params: {
    id: string;
    kind: SelfModKind;
    targetId: string;
    title: string;
    rationale: string;
    content: string;
    authorAgentId?: string | null;
    now?: number;
  }): SelfModProposalRecord {
    const now = params.now ?? Date.now();
    const { id, kind } = params;

    if (kind === "plugin") {
      if (!PLUGIN_TARGET_ID_RE.test(params.targetId)) throw new Error("invalid_selfmod_target_id");
    } else if (kind === "config_patch") {
      if (params.targetId !== "config" && params.targetId !== "hub-config") {
        throw new Error("invalid_selfmod_target_id");
      }
    } else {
      throw new Error("invalid_selfmod_kind");
    }
    if (this.scrubber.scrub(params.content) !== params.content) {
      throw new Error("secret_detected_in_selfmod");
    }

    let liveRoot: string;
    let livePath: string;
    let stagingFileName: string;
    let stagedContent: string;
    if (kind === "plugin") {
      const cap = this.runtimeCfg.config.memory.pluginPromptCaps.maxCharsPerBlock;
      if (params.content.length > cap) throw new Error("plugin_prompt_cap_exceeded");
      liveRoot = this.runtimeCfg.pluginsDir;
      livePath = join(liveRoot, params.targetId, "plugin.md");
      stagingFileName = "plugin.md";
      stagedContent = params.content;
    } else {
      let patch: unknown;
      try {
        patch = JSON.parse(params.content);
      } catch {
        throw new Error("invalid_config_patch_json");
      }
      if (!isPlainObject(patch)) throw new Error("invalid_config_patch_json");
      const merged = this.resolveMergedConfig(patch);
      liveRoot = this.runtimeCfg.rootDir;
      livePath = this.runtimeCfg.configPath;
      stagingFileName = "config.json";
      stagedContent = `${JSON.stringify(merged, null, 2)}\n`;
    }

    const stagingDir = join(this.runtimeCfg.stagingDir, id);
    const stagingPath = join(stagingDir, stagingFileName);
    if (!isPathStrictlyWithinRoot(this.runtimeCfg.stagingDir, stagingPath).ok) {
      throw new Error("staging_boundary_violation");
    }
    if (!isPathStrictlyWithinRoot(liveRoot, livePath).ok) {
      throw new Error("live_path_boundary_violation");
    }

    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(stagingPath, stagedContent, "utf8");
    if (kind === "plugin") {
      const manifest = { id, kind, targetId: params.targetId, title: params.title, authorAgentId: params.authorAgentId ?? null, createdAt: now };
      writeFileSync(join(stagingDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }

    const contentSha256 = createHash("sha256").update(readFileSync(stagingPath)).digest("hex");
    return {
      id,
      kind,
      targetId: params.targetId,
      title: params.title,
      rationale: params.rationale,
      authorAgentId: params.authorAgentId ?? null,
      stagingPath,
      livePath,
      backupPath: null,
      contentSha256,
      status: "staged",
      verificationId: null,
      verificationSummary: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  public readStagedContent(proposal: SelfModProposalRecord): string {
    const check = isPathStrictlyWithinRoot(this.runtimeCfg.stagingDir, proposal.stagingPath);
    if (!check.ok) throw new Error("staging_boundary_violation");
    return readFileSync(check.absTarget, "utf8");
  }

  public runSandboxStaticChecks(proposal: SelfModProposalRecord): {
    passed: boolean;
    checks: VerificationCheckResult[];
    findings: string[];
    stagedBytes?: Buffer;
  } {
    const checks: VerificationCheckResult[] = [];
    const findings: string[] = [];
    const add = (name: string, passed: boolean, detail: string): void => {
      checks.push({ name, passed, detail });
      if (!passed) findings.push(`${name}: ${detail}`);
    };

    const liveRoot = proposal.kind === "plugin" ? this.runtimeCfg.pluginsDir : this.runtimeCfg.rootDir;
    const stageOk = isPathStrictlyWithinRoot(this.runtimeCfg.stagingDir, proposal.stagingPath).ok;
    const liveOk = isPathStrictlyWithinRoot(liveRoot, proposal.livePath).ok;
    add("staging_boundary", stageOk && liveOk, `stagingWithin=${stageOk} liveWithin=${liveOk}`);

    let stagedBytes: Buffer | undefined;
    let content = "";
    let hashOk = false;
    if (stageOk && existsSync(proposal.stagingPath)) {
      stagedBytes = readFileSync(proposal.stagingPath);
      content = stagedBytes.toString("utf8");
      hashOk = createHash("sha256").update(stagedBytes).digest("hex") === proposal.contentSha256;
    }
    add("sha256_integrity", hashOk, hashOk ? "staged bytes match contentSha256" : "staged file missing or hash mismatch");
    add("secret_scan", content !== "" && this.scrubber.scrub(content) === content, content !== "" ? "no raw secrets in staged content" : "staged content unavailable or raw secret detected");

    if (proposal.kind === "plugin") {
      const cap = this.runtimeCfg.config.memory.pluginPromptCaps.maxCharsPerBlock;
      add("plugin_prompt_cap", content.length <= cap, `len=${content.length} cap=${cap}`);
    } else {
      let detail = "staged config passes HubConfigSchema and Open BYOS validation";
      let ok = true;
      try {
        const parsed: unknown = JSON.parse(content);
        if (!isPlainObject(parsed)) throw new Error("staged config is not a plain JSON object");
        const validation = validateOpenByosConfigPatch(parsed, this.runtimeCfg.config);
        if (!validation.ok) throw new Error(`config_patch_rejected: ${validation.errors.join("; ")}`);
      } catch (err) {
        ok = false;
        detail = err instanceof Error ? err.message : String(err);
      }
      add("config_schema_and_policy", ok, detail);
    }

    return { passed: findings.length === 0, checks, findings, stagedBytes };
  }

  public promoteProposal(proposal: SelfModProposalRecord): { backupPath: string } {
    if (this.runtimeCfg.config.guardrails.selfModRequiresStagingAndVerifier && proposal.status !== "verified") {
      throw new Error("selfmod_verifier_required");
    }
    const result = this.runSandboxStaticChecks(proposal);
    if (!result.passed || !result.stagedBytes) {
      const integrityFailed = result.checks.some((c) => c.name === "sha256_integrity" && !c.passed);
      throw new Error(integrityFailed ? "staging_integrity_mismatch" : "sandbox_check_failed");
    }

    // Read and validate ALL staged files BEFORE mutating any live file (eliminates TOCTOU and half-promoted state)
    const stagedBytes = result.stagedBytes;
    let stagedManifestBytes: Buffer | null = null;
    if (proposal.kind === "plugin") {
      const stagedManifest = join(dirname(proposal.stagingPath), "manifest.json");
      if (!isPathStrictlyWithinRoot(this.runtimeCfg.stagingDir, stagedManifest).ok || !existsSync(stagedManifest)) {
        throw new Error("staging_integrity_mismatch");
      }
      stagedManifestBytes = readFileSync(stagedManifest);
    }

    const backupPath = join(this.runtimeCfg.backupsDir, proposal.id);
    if (!isPathStrictlyWithinRoot(this.runtimeCfg.backupsDir, backupPath).ok) {
      throw new Error("backup_boundary_violation");
    }
    mkdirSync(backupPath, { recursive: true });
    const liveExisted = existsSync(proposal.livePath);
    if (liveExisted) copyFileSync(proposal.livePath, join(backupPath, "snapshot.bak"));

    let manifestExisted = false;
    if (proposal.kind === "plugin") {
      const liveManifestPath = join(dirname(proposal.livePath), "manifest.json");
      manifestExisted = existsSync(liveManifestPath);
      if (manifestExisted) {
        copyFileSync(liveManifestPath, join(backupPath, "manifest.bak"));
      }
    }

    const meta = {
      existed: liveExisted,
      manifestExisted,
      livePath: proposal.livePath,
      backedUpAt: Date.now(),
      kind: proposal.kind,
      targetId: proposal.targetId,
    };
    writeFileSync(join(backupPath, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    this.atomicWrite(proposal.livePath, stagedBytes);
    if (proposal.kind === "plugin" && stagedManifestBytes) {
      this.atomicWrite(join(dirname(proposal.livePath), "manifest.json"), stagedManifestBytes);
    }

    proposal.backupPath = backupPath;
    proposal.status = "promoted";
    proposal.updatedAt = Date.now();
    return { backupPath };
  }

  public rollbackProposal(proposal: SelfModProposalRecord): void {
    if (proposal.status !== "promoted") throw new Error("selfmod_not_promoted");
    if (!proposal.backupPath) throw new Error("selfmod_missing_backup");
    if (!isPathStrictlyWithinRoot(this.runtimeCfg.backupsDir, proposal.backupPath).ok) {
      throw new Error("backup_boundary_violation");
    }
    const meta = JSON.parse(readFileSync(join(proposal.backupPath, "meta.json"), "utf8")) as {
      existed: boolean;
      manifestExisted?: boolean;
    };
    const liveRoot = proposal.kind === "plugin" ? this.runtimeCfg.pluginsDir : this.runtimeCfg.rootDir;
    if (!isPathStrictlyWithinRoot(liveRoot, proposal.livePath).ok) {
      throw new Error("live_path_boundary_violation");
    }

    if (meta.existed) {
      const snapshot = join(proposal.backupPath, "snapshot.bak");
      if (!existsSync(snapshot)) throw new Error("backup_snapshot_missing");
      this.atomicWrite(proposal.livePath, readFileSync(snapshot));
      if (proposal.kind === "plugin") {
        const liveManifestPath = join(dirname(proposal.livePath), "manifest.json");
        const manifestBak = join(proposal.backupPath, "manifest.bak");
        if (meta.manifestExisted && existsSync(manifestBak)) {
          this.atomicWrite(liveManifestPath, readFileSync(manifestBak));
        } else if (!meta.manifestExisted) {
          rmSync(liveManifestPath, { force: true });
        }
      }
    } else {
      rmSync(proposal.livePath, { force: true });
      if (proposal.kind === "plugin") {
        rmSync(join(dirname(proposal.livePath), "manifest.json"), { force: true });
        try {
          rmdirSync(dirname(proposal.livePath));
        } catch {
          // plugin folder not empty; leave it in place
        }
      }
    }

    proposal.status = "rolled_back";
    proposal.updatedAt = Date.now();
  }

  public validateAndMergeConfigPatch(patch: Record<string, unknown>): HubConfig {
    return this.resolveMergedConfig(patch);
  }

  private resolveMergedConfig(patch: Record<string, unknown>): HubConfig {
    const baseRaw: unknown = existsSync(this.runtimeCfg.configPath)
      ? JSON.parse(readFileSync(this.runtimeCfg.configPath, "utf8"))
      : this.runtimeCfg.config;
    const base = isPlainObject(baseRaw) ? HubConfigSchema.parse(baseRaw) : this.runtimeCfg.config;
    return mergeOpenByosConfigPatch(base, patch, this.runtimeCfg.config);
  }

  private atomicWrite(targetPath: string, bytes: Buffer): void {
    mkdirSync(dirname(targetPath), { recursive: true });
    const tmp = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(tmp, bytes);
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
}
