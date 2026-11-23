import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  newId,
  type ProjectRecord,
  type SelfModProposalRecord,
  type TaskRecord,
  type VerificationCheckResult,
  type VerificationReportRecord,
  type VerificationVerdict,
} from "@bot-factory/shared";
import type { LoadedRuntimeConfig, SecretScrubber } from "../config";
import type { StateDatabase } from "../db/database";
import type { LocalSuperHermesMemory } from "../memory/memoryEngine";
import type { AcpSubprocessRuntime } from "../runtimes/acpSubprocessRuntime";
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
const SUMMARY_MAX_CHARS = 4000;
const CHECK_DETAIL_MAX_CHARS = 300;

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

function runGitStatusShort(cwd: string): { ok: boolean; output: string } {
  try {
    const proc = Bun.spawnSync(["git", "-c", "core.longpaths=true", "status", "--short"], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      return {
        ok: false,
        output: (proc.stderr.toString().trim() || `git_status_failed(${proc.exitCode})`).slice(0, 300),
      };
    }
    return { ok: true, output: proc.stdout.toString().trim() };
  } catch (err) {
    return { ok: false, output: `git_spawn_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
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
    const worktree = this.checkWorktreeEvidence(worktreeBase, handoff.content);
    checks.push(worktree.result);

    for (const custom of this.checkCustomPaths(customChecks ?? [], worktreeBase)) {
      checks.push(custom);
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

  private checkWorktreeEvidence(
    basePath: string | null,
    handoffContent: string,
  ): { result: VerificationCheckResult; diffStat: string } {
    if (!basePath || !existsSync(basePath)) {
      return {
        result: {
          name: "worktree_evidence",
          passed: false,
          detail: `author worktree/repo path missing: ${basePath ?? "(none)"}`,
        },
        diffStat: "",
      };
    }
    const git = runGitStatusShort(basePath);
    const mentionsCheckpoint = /refs\/bot-factory\/checkpoints\//.test(handoffContent);
    if (git.ok) {
      return {
        result: {
          name: "worktree_evidence",
          passed: true,
          detail: `git status --short:\n${truncate(git.output, DIFF_STAT_MAX_CHARS) || "(clean worktree)"}`,
        },
        diffStat: truncate(git.output, DIFF_STAT_MAX_CHARS),
      };
    }
    // Non-git fallback: pass ONLY if handoff explicitly cites a workspace-scoped checkpoint ref.
    return {
      result: {
        name: "worktree_evidence",
        passed: mentionsCheckpoint,
        detail: mentionsCheckpoint
          ? `non-git fallback accepted via checkpoint ref citation (${git.output})`
          : `non-git worktree without checkpoint ref citation (${git.output})`,
      },
      diffStat: "",
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
    const runtime: AgentRuntime = params.route.runtimeKind === "acp_stdio" ? this.acpRuntime : this.nativeRuntime;
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
