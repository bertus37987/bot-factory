import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  newId,
  type GitDiffFileSummary,
  type GitDiffResponse,
  type ProjectRecord,
  type SelfModProposalRecord,
  type TaskRecord,
  type VerificationCheckResult,
  type VerificationReportRecord,
  type VerificationVerdict,
} from "@bot-factory/shared";
import type { LoadedRuntimeConfig, SecretScrubber } from "../config";
import type { StateDatabase } from "../db/database";
import { computeWorkspaceGitDiff } from "../git/worktrees";
import type { LocalSuperHermesMemory } from "../memory/memoryEngine";
import type { AcpSubprocessRuntime } from "../runtimes/acpSubprocessRuntime";
import type { CliStreamRuntime } from "../runtimes/cliStreamRuntime";
import { isPathStrictlyWithinRoot } from "../runtimes/nativeHttpRuntime";
import type { NativeHttpRuntime } from "../runtimes/nativeHttpRuntime";
import type { ModelRouter } from "../runtimes/router";
import type { AgentRuntime, ResolvedRoute, RuntimeSessionHandle, RuntimeSessionSpec } from "../runtimes/types";

/**
 * Independent Verifier (Phase 3).
 *
 * Context-independence invariant: every verification runs in a brand-new
 * ephemeral session with an empty history, a fresh frozen system prompt in the
 * "verifier:ephemeral" namespace (no project memory), and — when routing
 * allows — on a model from a different provider family than the author agent.
 * The verifier NEVER reads the author agent's session, timeline, or messages;
 * the author record is only consulted for provider + worktree path + id.
 */

const HANDOFF_EXCERPT_MAX_CHARS = 4000;
const SPEC_EXCERPT_MAX_CHARS = 4000;
const STAGED_CONTENT_EXCERPT_MAX_CHARS = 4000;
const DIFF_STAT_MAX_CHARS = 2000;
const DIFF_EXCERPT_MAX_CHARS = 6000;
const SUMMARY_MAX_CHARS = 4000;
const CHECK_DETAIL_MAX_CHARS = 300;
const DEFAULT_VERIFY_CHECK_TIMEOUT_MS = 60_000;
const VERIFY_OUTPUT_MAX_BUFFER_CHARS = 16_384;
const VERIFY_OUTPUT_TAIL_CHARS = 800;

export type ProjectVerifyCheck = NonNullable<ProjectRecord["verifyChecks"]>[number];

const VERDICT_INSTRUCTIONS =
  'Judge strictly from the evidence provided in this message. End your reply with exactly one verdict line: "VERDICT: PASS", "VERDICT: FAIL", or "VERDICT: NEEDS_HUMAN". Before that line, list every concrete issue you found as a bullet starting with "- FINDING:". If you cannot confidently confirm correctness from the evidence alone, use NEEDS_HUMAN.';

const FINDING_LINE_PATTERN = /^\s*[-*]?\s*FINDING:\s*(.*)$/i;

export function parseVerifierVerdict(
  rawText: string,
  objectiveChecksPassed: boolean,
): { verdict: VerificationVerdict; findings: string[] } {
  const findings = rawText
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = FINDING_LINE_PATTERN.exec(line);
      return match?.[1] ? [match[1].trim()] : [];
    })
    .filter(Boolean);

  if (!objectiveChecksPassed) {
    return { verdict: "fail", findings };
  }

  const explicit = /VERDICT:\s*(PASS|FAIL|NEEDS_HUMAN)/i.exec(rawText)?.[1]?.toUpperCase();
  // Fail-closed: missing or ambiguous VERDICT line defaults to needs_human, never pass.
  const verdict: VerificationVerdict =
    explicit === "PASS" ? "pass" : explicit === "FAIL" ? "fail" : "needs_human";
  return { verdict, findings };
}

function truncate(input: string, max: number): string {
  return input.length > max ? `${input.slice(0, max)}\n… [truncated]` : input;
}

function buildVerifyCheckEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  delete env.BOT_FACTORY_TOKEN;
  return env;
}

function killProcessTreeSync(proc: ReturnType<typeof Bun.spawn>): void {
  const pid = proc.pid;
  if (process.platform === "win32" && pid) {
    try {
      Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      // Fall back to direct kill below
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    try {
      proc.kill();
    } catch {
      // Process already exited
    }
  }
}

async function readStreamTail(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  maxChars = VERIFY_OUTPUT_MAX_BUFFER_CHARS,
): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        acc += decoder.decode(value, { stream: true });
        if (acc.length > maxChars * 2) {
          acc = acc.slice(acc.length - maxChars);
        }
      }
    }
    acc += decoder.decode();
    return acc.length > maxChars ? acc.slice(acc.length - maxChars) : acc;
  } catch {
    return acc;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore lock release failure
    }
  }
}

/**
 * Execute configured project verification commands inside the author worktree,
 * enforcing per-check timeouts (killing the process tree) and SecretScrubber redaction.
 */
export async function runProjectVerifyChecks(
  checks: ProjectVerifyCheck[],
  cwd: string | null,
  scrubber: SecretScrubber,
): Promise<VerificationCheckResult[]> {
  if (!checks || checks.length === 0) return [];
  const results: VerificationCheckResult[] = [];

  for (const check of checks) {
    const checkName = `cmd:${check.name}`;
    if (!cwd || !existsSync(cwd)) {
      results.push({
        name: checkName,
        passed: false,
        detail: `worktree/repo directory missing: ${cwd ?? "(none)"}`,
      });
      continue;
    }
    if (!check.cmd.trim() || check.cmd.includes("\0")) {
      results.push({
        name: checkName,
        passed: false,
        detail: "invalid verify check command",
      });
      continue;
    }

    const timeoutMs = Math.max(1, check.timeoutMs ?? DEFAULT_VERIFY_CHECK_TIMEOUT_MS);
    const argv =
      process.platform === "win32"
        ? ["cmd.exe", "/d", "/s", "/c", `"${check.cmd}"`]
        : ["/bin/sh", "-c", check.cmd];
    const spawnOpts: Record<string, unknown> = {
      cwd,
      env: buildVerifyCheckEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    };
    if (process.platform === "win32") {
      spawnOpts.windowsVerbatimArguments = true;
    }

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, spawnOpts as Parameters<typeof Bun.spawn>[1]);
    } catch (err) {
      results.push({
        name: checkName,
        passed: false,
        detail: scrubber.scrub(`spawn_failed: ${err instanceof Error ? err.message : String(err)}`),
      });
      continue;
    }

    const stdoutPromise = readStreamTail(proc.stdout);
    const stderrPromise = readStreamTail(proc.stderr);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const outcome = await Promise.race([
      proc.exited.then((code) => ({ timedOut: false as const, code })),
      new Promise<{ timedOut: true; code: number }>((resolveTimeout) => {
        timer = setTimeout(() => {
          killProcessTreeSync(proc);
          resolveTimeout({ timedOut: true, code: -1 });
        }, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome.timedOut) {
      await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 1000))]);
    }

    const [stdoutRaw, stderrRaw] = await Promise.all([
      Promise.race([stdoutPromise, new Promise<string>((r) => setTimeout(() => r(""), 1000))]),
      Promise.race([stderrPromise, new Promise<string>((r) => setTimeout(() => r(""), 1000))]),
    ]);

    const combined = [stdoutRaw.trim(), stderrRaw.trim()].filter(Boolean).join("\n");
    const scrubbed = scrubber.scrub(combined);
    const tail =
      scrubbed.length > VERIFY_OUTPUT_TAIL_CHARS
        ? `…${scrubbed.slice(scrubbed.length - VERIFY_OUTPUT_TAIL_CHARS)}`
        : scrubbed;

    const detail = outcome.timedOut
      ? `timed out after ${timeoutMs}ms${tail ? `: ${tail}` : ""}`
      : `exit ${outcome.code}${tail ? `: ${tail}` : " (no output)"}`;

    results.push({
      name: checkName,
      passed: !outcome.timedOut && outcome.code === 0,
      detail,
    });
  }

  return results;
}

async function runGitAsync(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["git", "-c", "core.longpaths=true", "-c", "core.quotePath=false", ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr: stderr.trim() };
  } catch (err) {
    return { code: 1, stdout: "", stderr: `git_spawn_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function computeBranchCommitsDiff(
  worktreePath: string,
  baseRepoPath: string,
  scrub: (text: string) => string,
): Promise<GitDiffResponse> {
  const empty: GitDiffResponse = { branch: "main", filesChanged: 0, insertions: 0, deletions: 0, files: [] };
  const [wtHead, repoHead, branchRes] = await Promise.all([
    runGitAsync(["rev-parse", "--verify", "HEAD"], worktreePath),
    runGitAsync(["rev-parse", "--verify", "HEAD"], baseRepoPath),
    runGitAsync(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath),
  ]);
  if (wtHead.code !== 0 || repoHead.code !== 0) return empty;
  const wtSha = wtHead.stdout.trim();
  const repoSha = repoHead.stdout.trim();
  if (!wtSha || !repoSha || wtSha === repoSha) return empty;

  const mergeBaseRes = await runGitAsync(["merge-base", repoSha, wtSha], worktreePath);
  const baseSha = mergeBaseRes.code === 0 ? mergeBaseRes.stdout.trim() : repoSha;
  if (!baseSha || baseSha === wtSha) return empty;

  const range = `${baseSha}..${wtSha}`;
  const [nameStatusRes, numstatRes, diffRes] = await Promise.all([
    runGitAsync(["diff", "--name-status", "-z", range], worktreePath),
    runGitAsync(["diff", "--numstat", range], worktreePath),
    runGitAsync(["diff", "--unified=3", range], worktreePath),
  ]);
  if (nameStatusRes.code !== 0) return empty;

  const stats = new Map<string, { added: number; removed: number }>();
  for (const line of numstatRes.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [rawA, rawR, ...rest] = line.split("\t");
    if (!rawA || !rawR || rest.length === 0) continue;
    const p = rest.join("\t").trim().replace(/^"|"$/g, "").replace(/\\/g, "/");
    if (p) {
      stats.set(p, {
        added: rawA === "-" ? 0 : Number.parseInt(rawA, 10) || 0,
        removed: rawR === "-" ? 0 : Number.parseInt(rawR, 10) || 0,
      });
    }
  }

  const patches = new Map<string, string>();
  const chunks = diffRes.stdout.replace(/\r\n/g, "\n").split(/^diff --git /m);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const full = `diff --git ${chunk}`.trimEnd();
    const lines = full.split("\n");
    let target = "";
    for (const line of lines) {
      if (line.startsWith("@@ ")) break;
      if (line.startsWith("rename to ")) target = line.slice("rename to ".length);
      else if (line.startsWith("+++ b/")) target = line.slice("+++ b/".length);
      else if (!target && line.startsWith("--- a/")) target = line.slice("--- a/".length);
    }
    target = target.replace(/^"|"$/g, "").replace(/\\/g, "/");
    if (target) patches.set(target, full);
  }

  const parts = nameStatusRes.stdout.split("\0").filter(Boolean);
  const files: GitDiffFileSummary[] = [];
  let insertions = 0;
  let deletions = 0;
  for (let i = 0; i < parts.length && files.length < 40; i += 1) {
    const code = parts[i] ?? "";
    let filePath = "";
    if (code.startsWith("R") || code.startsWith("C")) {
      filePath = (parts[i + 2] ?? "").replace(/\\/g, "/");
      i += 2;
    } else {
      filePath = (parts[i + 1] ?? "").replace(/\\/g, "/");
      i += 1;
    }
    if (!filePath) continue;
    const st = stats.get(filePath) ?? { added: 0, removed: 0 };
    insertions += st.added;
    deletions += st.removed;
    const status: GitDiffFileSummary["status"] = code.startsWith("A")
      ? "added"
      : code.startsWith("D")
        ? "deleted"
        : code.startsWith("R")
          ? "renamed"
          : "modified";
    files.push({
      path: filePath,
      status,
      added: st.added,
      removed: st.removed,
      patch: scrub(patches.get(filePath) ?? ""),
    });
  }

  const branch = branchRes.code === 0 && branchRes.stdout.trim() !== "HEAD" ? branchRes.stdout.trim() : "main";
  return { branch, filesChanged: files.length, insertions, deletions, files };
}

function extractHandoffChangedFiles(handoffContent: string): string[] {
  const sectionMatch = /## Changed Files\s*\n([\s\S]*?)(?:\n## |\s*$)/i.exec(handoffContent);
  if (!sectionMatch?.[1]) return [];
  const out: string[] = [];
  for (const rawLine of sectionMatch[1].split(/\r?\n/)) {
    const m = /^\s*[-*]\s*`([^`]+)`/.exec(rawLine);
    if (m?.[1]) {
      out.push(m[1].trim().replace(/\\/g, "/"));
    }
  }
  return out;
}

export class IndependentVerifier {
  constructor(
    private readonly runtimeCfg: LoadedRuntimeConfig,
    private readonly db: StateDatabase,
    private readonly memory: LocalSuperHermesMemory,
    private readonly router: ModelRouter,
    private readonly nativeRuntime: NativeHttpRuntime,
    private readonly acpRuntime: AcpSubprocessRuntime,
    private readonly scrubber: SecretScrubber,
    private readonly cliRuntime?: CliStreamRuntime,
  ) {}

  public async verifyTask(params: {
    project: ProjectRecord;
    task: TaskRecord;
    customChecks?: string[];
  }): Promise<VerificationReportRecord> {
    const { project, task, customChecks } = params;

    // Author record is read ONLY for provider, worktreePath, and id — never its session/timeline/messages.
    const author = task.assignedAgentId ? this.db.getAgent(task.assignedAgentId) : null;
    const route = this.router.resolveIntent("verifier_default", {
      projectOverrides: project.routingOverrides,
      excludeProvider: author?.provider,
    });
    const crossFamily = Boolean(author?.provider && route.provider !== author.provider);

    // --- Deterministic objective checks ---

    const handoff = this.checkHandoffExists(task, project.rootPath);
    const checks: VerificationCheckResult[] = [handoff.result, this.checkSecretScan(handoff.content, handoff.result.passed)];

    const worktreeBase = author?.worktreePath ?? project.repoPath;
    const worktree = await this.checkWorktreeEvidence({
      basePath: worktreeBase,
      project,
      task,
      handoffContent: handoff.content,
    });
    checks.push(worktree.result);

    for (const custom of this.checkCustomPaths(customChecks ?? [], worktreeBase)) {
      checks.push(custom);
    }

    for (const cmdCheck of await runProjectVerifyChecks(project.verifyChecks ?? [], worktreeBase, this.scrubber)) {
      checks.push(cmdCheck);
    }

    const objectiveChecksPassed = checks.every((c) => c.passed);

    // --- Fresh ephemeral verifier session (strictly zero global/project L1 memory & empty history) ---

    const verifierAgentId = newId("ver");
    const verifierSessionId = newId("ses");
    const systemPrompt = [
      "You are an independent Bot Factory verifier. You review completed work with fresh eyes and zero prior context about how it was produced.",
      VERDICT_INSTRUCTIONS,
      `Runtime Model: ${route.provider}/${route.model}`,
    ].join("\n\n");

    const userText =
      `Independently verify the following completed task against its spec.\n\n` +
      `## Task Spec\n${truncate(task.specMd ?? "", SPEC_EXCERPT_MAX_CHARS) || "(empty spec)"}\n\n` +
      `## Handoff Excerpt\n${this.scrubber.scrub(truncate(handoff.content, HANDOFF_EXCERPT_MAX_CHARS)) || "(handoff missing or empty)"}\n\n` +
      `## Worktree Change Evidence\n${this.scrubber.scrub(worktree.diffStat || "(git status unavailable)")}\n\n` +
      `## Worktree Git Diff\n${this.scrubber.scrub(worktree.diffExcerpt || "(no worktree diff)")}\n\n` +
      `## Objective Check Results\n${checks
        .map((c) => `- ${c.name}: ${c.passed ? "PASS" : "FAIL"} — ${truncate(c.detail, CHECK_DETAIL_MAX_CHARS)}`)
        .join("\n")}\n\n` +
      (objectiveChecksPassed
        ? "All objective checks passed. Assess whether the work actually satisfies the spec, then end with your VERDICT line."
        : "One or more objective checks already failed; the final verdict is therefore fixed to FAIL. Still list each issue as a \"- FINDING:\" bullet.");

    const turn = await this.runIsolatedTurn({
      route,
      cwd: project.rootPath,
      verifierAgentId,
      verifierSessionId,
      systemPrompt,
      userText,
    });

    const parsed = parseVerifierVerdict(turn.finalText, objectiveChecksPassed);
    const failedCheckFindings = checks
      .filter((c) => !c.passed)
      .map((c) => `check_failed:${c.name}: ${truncate(c.detail, 200)}`);
    const verdict: VerificationVerdict = !objectiveChecksPassed
      ? "fail"
      : turn.ok
        ? parsed.verdict
        : "needs_human";

    return {
      id: newId("vr"),
      projectId: project.id,
      targetKind: "task",
      targetId: task.id,
      authorAgentId: task.assignedAgentId,
      authorProvider: author?.provider ?? null,
      verifierAgentId,
      verifierSessionId,
      verifierProvider: route.provider,
      verifierModel: route.model,
      crossFamily,
      verdict,
      summary: this.scrubber.scrub(truncate(turn.finalText, SUMMARY_MAX_CHARS)),
      checks,
      findings: [...failedCheckFindings, ...parsed.findings, ...(turn.ok ? [] : [turn.finalText])].map((f) =>
        this.scrubber.scrub(f),
      ),
      createdAt: Date.now(),
    };
  }

  public async verifySelfMod(params: {
    proposal: SelfModProposalRecord;
    staticChecks: { passed: boolean; checks: VerificationCheckResult[]; findings: string[] };
    stagedContent: string;
  }): Promise<VerificationReportRecord> {
    const { proposal, staticChecks, stagedContent } = params;

    const author = proposal.authorAgentId ? this.db.getAgent(proposal.authorAgentId) : null;
    const route = this.router.resolveIntent("verifier_default", {
      excludeProvider: author?.provider,
    });
    const crossFamily = Boolean(author?.provider && route.provider !== author.provider);

    const verifierAgentId = newId("ver");
    const verifierSessionId = newId("ses");
    const systemPrompt = [
      "You are an independent Bot Factory self-modification verifier. You review staged proposals with fresh eyes and zero prior context; staged proposals are NOT live yet.",
      `Proposals that modify the Bot Factory's own system demand strict scrutiny: subtle logic changes, guardrail weakening, or scope creep must be flagged. ${VERDICT_INSTRUCTIONS}`,
      `Runtime Model: ${route.provider}/${route.model}`,
    ].join("\n\n");

    const scrubbedExcerpt = this.scrubber.scrub(truncate(stagedContent ?? "", STAGED_CONTENT_EXCERPT_MAX_CHARS));

    const userText =
      `Independently verify the following staged self-modification proposal. It has NOT been promoted to the live system.\n\n` +
      `## Proposal\n- ID: ${proposal.id}\n- Kind: ${proposal.kind}\n- Target: ${proposal.targetId}\n- Title: ${proposal.title}\n` +
      `- Rationale: ${this.scrubber.scrub(truncate(proposal.rationale, 1000))}\n- Staged path: ${proposal.stagingPath}\n` +
      `- Live path: ${proposal.livePath}\n- Content SHA-256: ${proposal.contentSha256}\n\n` +
      `## Staged Content Excerpt (scrubbed)\n${scrubbedExcerpt || "(empty staged content)"}\n\n` +
      `## Static Check Results\n${staticChecks.checks
        .map((c) => `- ${c.name}: ${c.passed ? "PASS" : "FAIL"} — ${truncate(c.detail, CHECK_DETAIL_MAX_CHARS)}`)
        .join("\n") || "(none)"}\n\n` +
      (staticChecks.passed
        ? "All static checks passed. Assess whether this staged change is safe and justified, then end with your VERDICT line."
        : "Static checks FAILED; the final verdict is therefore fixed to FAIL. List every issue as a \"- FINDING:\" bullet.");

    const turn = await this.runIsolatedTurn({
      route,
      cwd: this.runtimeCfg.systemDir,
      verifierAgentId,
      verifierSessionId,
      systemPrompt,
      userText,
    });

    const parsed = parseVerifierVerdict(turn.finalText, staticChecks.passed);
    const failedCheckFindings = staticChecks.checks
      .filter((c) => !c.passed)
      .map((c) => `static_check_failed:${c.name}: ${truncate(c.detail, 200)}`);
    const verdict: VerificationVerdict = !staticChecks.passed
      ? "fail"
      : turn.ok
        ? parsed.verdict
        : "needs_human";

    return {
      id: newId("vr"),
      projectId: null,
      targetKind: "selfmod",
      targetId: proposal.id,
      authorAgentId: proposal.authorAgentId,
      authorProvider: author?.provider ?? null,
      verifierAgentId,
      verifierSessionId,
      verifierProvider: route.provider,
      verifierModel: route.model,
      crossFamily,
      verdict,
      summary: this.scrubber.scrub(truncate(turn.finalText, SUMMARY_MAX_CHARS)),
      checks: staticChecks.checks,
      findings: [
        ...(staticChecks.passed ? [] : staticChecks.findings),
        ...failedCheckFindings,
        ...parsed.findings,
        ...(turn.ok ? [] : [turn.finalText]),
      ].map((f) => this.scrubber.scrub(f)),
      createdAt: Date.now(),
    };
  }

  // --- Deterministic objective check helpers ---

  private checkHandoffExists(
    task: TaskRecord,
    projectRoot: string,
  ): { result: VerificationCheckResult; content: string } {
    const rel = task.handoffPath;
    if (!rel) {
      return {
        result: { name: "handoff_exists", passed: false, detail: "task has no handoffPath" },
        content: "",
      };
    }
    const inside = isPathStrictlyWithinRoot(projectRoot, rel);
    if (!inside.ok) {
      return {
        result: { name: "handoff_exists", passed: false, detail: `handoff path escapes project root: ${rel}` },
        content: "",
      };
    }
    const relFromRoot = relative(resolve(projectRoot), inside.absTarget).replace(/\\/g, "/");
    const topDir = relFromRoot.split("/")[0] ?? "";
    if (topDir !== "handoffs") {
      return {
        result: { name: "handoff_exists", passed: false, detail: `handoff path not under 'handoffs/': ${relFromRoot}` },
        content: "",
      };
    }
    try {
      const content = readFileSync(inside.absTarget, "utf8");
      if (!content.trim()) {
        return {
          result: { name: "handoff_exists", passed: false, detail: `handoff file is empty: ${relFromRoot}` },
          content: "",
        };
      }
      return {
        result: { name: "handoff_exists", passed: true, detail: `handoff present and non-empty: ${relFromRoot}` },
        content,
      };
    } catch (err) {
      return {
        result: {
          name: "handoff_exists",
          passed: false,
          detail: `handoff unreadable: ${err instanceof Error ? err.message : String(err)}`,
        },
        content: "",
      };
    }
  }

  private checkSecretScan(handoffContent: string, handoffPassed: boolean): VerificationCheckResult {
    if (!handoffPassed) {
      return { name: "secret_scan", passed: false, detail: "handoff unavailable; secret scan not run" };
    }
    const clean = this.scrubber.scrub(handoffContent);
    return {
      name: "secret_scan",
      passed: clean === handoffContent,
      detail: clean === handoffContent ? "no unredacted secrets detected in handoff" : "unredacted secret detected in handoff",
    };
  }

  private isVerifiedDocOnlyChange(project: ProjectRecord, task: TaskRecord, handoffContent: string): boolean {
    const annotation = task.sourceAnnotationId ? this.db.getAnnotation(task.sourceAnnotationId) : null;
    const annPathNorm = annotation?.filePath.replace(/\\/g, "/") ?? "";
    const handoffRelNorm = task.handoffPath?.replace(/\\/g, "/") ?? "";
    const handoffJsonNorm = handoffRelNorm.replace(/\.md$/i, ".json");
    const handoffChangedFiles = extractHandoffChangedFiles(handoffContent);
    const specDocPaths = Array.from((task.specMd ?? "").matchAll(/(?:plans|handoffs)\/[A-Za-z0-9_.\-/]+/g)).map(
      (m) => m[0],
    );

    const docOnlyTargeted = Boolean(
      (annotation?.targetType === "doc" && /^(plans|handoffs)\//.test(annPathNorm)) ||
        /\bdocs?[- ]?only\b|\bno repo (?:files|changes)\b/i.test(`${task.specMd ?? ""}\n${handoffContent}`) ||
        specDocPaths.length > 0,
    );
    if (!docOnlyTargeted) return false;

    const candidates = new Set<string>([
      ...(annotation?.targetType === "doc" && annPathNorm ? [annPathNorm] : []),
      ...handoffChangedFiles,
      ...specDocPaths,
    ]);
    if (handoffRelNorm) candidates.delete(handoffRelNorm);
    if (handoffJsonNorm) candidates.delete(handoffJsonNorm);

    for (const relPath of candidates) {
      const inside = isPathStrictlyWithinRoot(project.rootPath, relPath);
      if (!inside.ok) continue;
      const relFromRoot = relative(resolve(project.rootPath), inside.absTarget).replace(/\\/g, "/");
      if (!relFromRoot.startsWith("plans/") && !relFromRoot.startsWith("handoffs/")) continue;
      if (relFromRoot === handoffRelNorm || relFromRoot === handoffJsonNorm) continue;
      try {
        const st = statSync(inside.absTarget);
        if (!st.isFile() || st.size === 0) continue;
        if (handoffChangedFiles.includes(relFromRoot) || st.mtimeMs > task.createdAt) {
          return true;
        }
        const content = readFileSync(inside.absTarget, "utf8");
        if (content.includes(task.id)) {
          return true;
        }
      } catch {
        // Ignore unreadable candidate
      }
    }

    return false;
  }

  private async checkWorktreeEvidence(params: {
    basePath: string | null;
    project: ProjectRecord;
    task: TaskRecord;
    handoffContent: string;
  }): Promise<{ result: VerificationCheckResult; diffStat: string; diffExcerpt: string }> {
    const { basePath, project, task, handoffContent } = params;
    if (!basePath || !existsSync(basePath)) {
      return {
        result: {
          name: "worktree_evidence",
          passed: false,
          detail: `author worktree/repo path missing: ${basePath ?? "(none)"}`,
        },
        diffStat: "",
        diffExcerpt: "",
      };
    }

    const insideGit = await runGitAsync(["rev-parse", "--is-inside-work-tree"], basePath);
    const mentionsCheckpoint = /refs\/bot-factory\/checkpoints\//.test(handoffContent);
    if (insideGit.code !== 0) {
      const reason = insideGit.stderr || `not_a_git_repo(${insideGit.code})`;
      return {
        result: {
          name: "worktree_evidence",
          passed: mentionsCheckpoint,
          detail: mentionsCheckpoint
            ? `non-git fallback accepted via checkpoint ref citation (${reason})`
            : `non-git worktree without checkpoint ref citation (${reason})`,
        },
        diffStat: "",
        diffExcerpt: "",
      };
    }

    let diff = await computeWorkspaceGitDiff(basePath, (t) => this.scrubber.scrub(t));
    if (diff.filesChanged === 0 && resolve(basePath) !== resolve(project.repoPath) && existsSync(project.repoPath)) {
      const branchDiff = await computeBranchCommitsDiff(basePath, project.repoPath, (t) => this.scrubber.scrub(t));
      if (branchDiff.filesChanged > 0) {
        diff = branchDiff;
      }
    }

    if (diff.filesChanged === 0) {
      if (this.isVerifiedDocOnlyChange(project, task, handoffContent)) {
        return {
          result: {
            name: "worktree_evidence",
            passed: true,
            detail: "doc-only change verified under plans/ or handoffs/ (no repo code changes required)",
          },
          diffStat: "(doc-only change under plans/ or handoffs/)",
          diffExcerpt: "(doc-only change — no repo diff)",
        };
      }
      return {
        result: {
          name: "worktree_evidence",
          passed: false,
          detail: "worktree has zero changed files (fail-closed)",
        },
        diffStat: "(clean worktree — 0 changed files)",
        diffExcerpt: "(empty diff)",
      };
    }

    const summaryHeader = `Branch: ${diff.branch} | Files: ${diff.filesChanged} | +${diff.insertions}/-${diff.deletions}`;
    const fileList = diff.files.map((f) => `- ${f.path} (${f.status}, +${f.added}/-${f.removed})`);
    const diffStat = truncate([summaryHeader, ...fileList].join("\n"), DIFF_STAT_MAX_CHARS);
    const diffPatches = diff.files
      .map((f) => `### ${f.path} (${f.status}, +${f.added}/-${f.removed})\n${f.patch || "(no text patch / binary)"}`)
      .join("\n\n");
    const diffExcerpt = truncate(this.scrubber.scrub(diffPatches), DIFF_EXCERPT_MAX_CHARS);

    return {
      result: {
        name: "worktree_evidence",
        passed: true,
        detail: diffStat,
      },
      diffStat,
      diffExcerpt,
    };
  }

  private checkCustomPaths(entries: string[], basePath: string | null): VerificationCheckResult[] {
    if (entries.length === 0) return [];
    return entries.map((entry) => {
      if (!basePath) {
        return {
          name: "custom_checks",
          passed: false,
          detail: `no worktree available to check expected path: ${entry}`,
        };
      }
      const check = isPathStrictlyWithinRoot(basePath, entry);
      if (!check.ok) {
        return {
          name: "custom_checks",
          passed: false,
          detail: `expected path escapes worktree boundary: ${entry}`,
        };
      }
      return {
        name: "custom_checks",
        passed: existsSync(check.absTarget),
        detail: `${existsSync(check.absTarget) ? "expected path present" : "expected path missing"} in worktree: ${entry}`,
      };
    });
  }

  // --- Isolated single-turn execution ---

  private async runIsolatedTurn(params: {
    route: ResolvedRoute;
    cwd: string;
    verifierAgentId: string;
    verifierSessionId: string;
    systemPrompt: string;
    userText: string;
  }): Promise<{ finalText: string; ok: boolean }> {
    const runtime: AgentRuntime =
      params.route.runtimeKind === "acp_stdio"
        ? this.acpRuntime
        : params.route.runtimeKind === "cli_stream" && this.cliRuntime
          ? this.cliRuntime
          : this.nativeRuntime;
    const spec: RuntimeSessionSpec = {
      agentId: params.verifierAgentId,
      sessionId: params.verifierSessionId,
      provider: params.route.provider,
      model: params.route.model,
      cwd: params.cwd,
      systemPrompt: params.systemPrompt,
    };

    let handle: RuntimeSessionHandle | null = null;
    try {
      handle = await runtime.startSession(spec);
      let finalText = "";
      let ok = false;
      for await (const evt of runtime.sendTurn(handle, { history: [], userText: params.userText })) {
        if (evt.type === "done") {
          finalText = evt.finalText;
          ok = true;
        } else if (evt.type === "error" && !ok) {
          finalText = `verifier_runtime_error: ${evt.message}`;
        }
      }
      return { finalText, ok };
    } catch (err) {
      return {
        finalText: `verifier_session_error: ${err instanceof Error ? err.message : String(err)}`,
        ok: false,
      };
    } finally {
      if (handle) {
        try {
          await runtime.closeSession(handle);
        } catch {
          // Best-effort ephemeral cleanup
        }
      }
    }
  }
}
