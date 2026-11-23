import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
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

export const EXCLUSIVE_MODEL_ROSTER: Readonly<Record<string, readonly string[]>> = {
  "mistral-hosted": ["mistral-large-4", "glm-5.3", "glm-5.3-flash"],
  "google-antigravity": ["gemini-4-hydrogen", "gemini-4-neon"],
  "devin-acp": ["swe-2-max"],
};

const LOCKED_PROVIDER_SPEC: Readonly<
  Record<
    string,
    {
      runtime: "native_http" | "acp_stdio";
      protocol?: "openai_compatible" | "google_gemini";
      baseUrl?: string;
      apiKeyEnv?: string;
      command?: string;
      args?: readonly string[];
    }
  >
> = {
  "mistral-hosted": {
    runtime: "native_http",
    protocol: "openai_compatible",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
  },
  "google-antigravity": {
    runtime: "native_http",
    protocol: "google_gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: "GEMINI_API_KEY",
  },
  "devin-acp": {
    runtime: "acp_stdio",
    command: "devin",
    args: ["acp"],
  },
};

export function validateExclusiveRoster(config: HubConfig): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (config.hub.host !== "127.0.0.1") {
    errors.push(`hub.host must be "127.0.0.1" (got ${JSON.stringify(config.hub.host)})`);
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
  if (!config.routing.crossFamilyVerification) {
    errors.push("routing.crossFamilyVerification must remain true");
  }

  for (const [providerId, provider] of Object.entries(config.providers)) {
    const allowed = EXCLUSIVE_MODEL_ROSTER[providerId];
    const locked = LOCKED_PROVIDER_SPEC[providerId];
    if (!allowed || !locked) {
      errors.push(`provider "${providerId}" is not in the exclusive roster`);
      continue;
    }
    if (provider.runtime !== locked.runtime) {
      errors.push(`provider "${providerId}" runtime must be "${locked.runtime}"`);
    }
    if (locked.protocol && provider.protocol !== locked.protocol) {
      errors.push(`provider "${providerId}" protocol must be "${locked.protocol}"`);
    }
    if (locked.baseUrl !== undefined && provider.baseUrl !== locked.baseUrl) {
      errors.push(`provider "${providerId}" baseUrl is locked to "${locked.baseUrl}"`);
    }
    if (locked.baseUrl === undefined && provider.baseUrl !== undefined) {
      errors.push(`provider "${providerId}" must not define baseUrl`);
    }
    if (locked.apiKeyEnv !== undefined && provider.apiKeyEnv !== locked.apiKeyEnv) {
      errors.push(`provider "${providerId}" apiKeyEnv is locked to "${locked.apiKeyEnv}"`);
    }
    if (locked.command !== undefined && provider.command !== locked.command) {
      errors.push(`provider "${providerId}" command is locked to "${locked.command}"`);
    }
    if (locked.command === undefined && provider.command !== undefined) {
      errors.push(`provider "${providerId}" must not define command`);
    }
    if (locked.args !== undefined) {
      const actualArgs = provider.args ?? [];
      if (actualArgs.length !== locked.args.length || actualArgs.some((a, i) => a !== locked.args![i])) {
        errors.push(`provider "${providerId}" args are locked to ${JSON.stringify(locked.args)}`);
      }
    } else if (provider.args && provider.args.length > 0) {
      errors.push(`provider "${providerId}" must not define args`);
    }
    for (const modelId of Object.keys(provider.models)) {
      if (!allowed.includes(modelId)) {
        errors.push(`model "${modelId}" of provider "${providerId}" is not in the exclusive roster`);
      }
    }
  }
  for (const [intent, target] of Object.entries(config.routing.defaultsByIntent)) {
    const allowed = EXCLUSIVE_MODEL_ROSTER[target.provider];
    if (!allowed) {
      errors.push(`routing intent "${intent}" targets non-roster provider "${target.provider}"`);
    } else if (!allowed.includes(target.model)) {
      errors.push(`routing intent "${intent}" targets non-roster model "${target.provider}/${target.model}"`);
    }
  }
  return { ok: errors.length === 0, errors };
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
      if (FORBIDDEN_MERGE_KEYS.has(key)) continue;
      const hasOwn = Object.prototype.hasOwnProperty.call(out, key);
      out[key] = hasOwn ? deepMerge(out[key], value) : deepMerge(undefined, value);
    }
    return out;
  }
  if (isPlainObject(patch)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (FORBIDDEN_MERGE_KEYS.has(key)) continue;
      out[key] = deepMerge(undefined, value);
    }
    return out;
  }
  return patch;
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
      let detail = "staged config passes HubConfigSchema and exclusive roster";
      let ok = true;
      try {
        const parsed: unknown = JSON.parse(content);
        if (!isPlainObject(parsed)) throw new Error("staged config is not a plain JSON object");
        const validated = HubConfigSchema.parse(parsed);
        const roster = validateExclusiveRoster(validated);
        if (!roster.ok) throw new Error(`config_patch_rejected: ${roster.errors.join("; ")}`);
      } catch (err) {
        ok = false;
        detail = err instanceof Error ? err.message : String(err);
      }
      add("config_schema_and_roster", ok, detail);
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

  private resolveMergedConfig(patch: Record<string, unknown>): HubConfig {
    if (isPlainObject(patch.hub)) {
      for (const lockedKey of ["rootDir", "dbPath", "secretsEnvPath", "defaultProjectsDir"]) {
        if (lockedKey in patch.hub) {
          throw new Error(`config_patch_rejected: hub.${lockedKey} is immutable`);
        }
      }
    }
    const base: unknown = existsSync(this.runtimeCfg.configPath)
      ? JSON.parse(readFileSync(this.runtimeCfg.configPath, "utf8"))
      : this.runtimeCfg.config;
    const validated = HubConfigSchema.parse(deepMerge(base, patch));
    const roster = validateExclusiveRoster(validated);
    if (!roster.ok) throw new Error(`config_patch_rejected: ${roster.errors.join("; ")}`);
    return validated;
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
