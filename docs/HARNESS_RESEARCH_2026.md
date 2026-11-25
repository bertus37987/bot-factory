# Bot-Factory V2 — 2025–2026 Harness & Multi-Agent Engineering Research Synthesis

> Synthesized from verified 2025–2026 industry research, the internal codebase audit (`harness-auditor`), and local Factory Droid CLI verification, mapped directly to Bot-Factory V2 implementation status and roadmap.

The [research archive](./research/antigravity-studio-v2/README.md) preserves the original source-cited briefs, detailed audit and provenance. The [Studio V2 handoff](./STUDIO_V2_HANDOFF.md) records the recovery checks separately.

---

## 1. 2025–2026 Harness Engineering Research

### 1.1 Context Engineering, KV-Cache Prefix Stability & Session Compaction
- **Manus — *Context Engineering for AI Agents* (Jul 2025):**
  - Keep prompt prefixes immutable (static system prompt + static tool definitions) so KV caches remain hot across turns; append volatile/per-turn state only in the latest user turn rather than mutating system prefixes.
  - Retain structured error traces and failed tool observations inside context briefly instead of silently erasing them so the model updates its beliefs; compact stale verbose observations rather than dropping active turn intent.
- **Factory — *Evaluating Context Compression* (Dec 2025):**
  - **Anchored iterative summarization** outperforms naive full-history regeneration on long coding sessions: retain prior compaction summaries across generations and preserve an explicit trail of modified files, failing tests, and verified state.
- **Anthropic — *Managed Agents* (Apr 2026) & *Building Effective Agents* / *Writing Tools for Agents* (Sep 2025):**
  - Pin ephemeral prompt-cache breakpoints (`cache_control: { type: "ephemeral" }`) on the frozen system instruction and tool catalog so multi-step loops pay cached read rates instead of full prompt re-ingestion.
  - Bound tool outputs returned to model context (head+tail excerpts with explicit truncation counts) and keep tool schemas concise and unambiguous.

### 1.2 Tool-Loop Hardening, Circuit Breakers & Protocol Safety
- **LangChain — `LoopDetectionMiddleware` (Terminal Bench 2.0, +13.7% benchmark gain):**
  - Detect repetitive identical tool calls using canonical `(toolName + sortedArgs)` signatures and consecutive failing steps; inject explicit loop-breaker reflection nudges and disable tools on the final wrap-up turn.
- **OpenAI — *Unrolling the Codex Agent Loop* (Jan 2026):**
  - Keep deterministic tool-step bounds, enforce strict per-request HTTP/stream timeouts so stalled responses do not wedge worker lanes, and pass explicit `tool_choice: "none"` (or equivalent final-turn no-tool constraints) rather than deleting tool schemas from messages that already contain `tool_use` / `tool_result` blocks.
- **OPENDEV (`arXiv:2603.05344`), Experiment E28 (`tappers.hashnode.dev`), AgentPatterns (*Circuit Breakers* & *Loop Detection*):**
  - Separate cumulative billing telemetry from active context window pressure.
  - Age/compact verbose tool outputs that are >3 steps old inside a single multi-step turn while preserving `tool_call_id` / `tool_result` pairing invariants.

---

## 2. 2025–2026 Multi-Agent & Subagent Research

### 2.1 Failure Taxonomies & Structural Containment
- **MAST (Multi-Agent System Failure Taxonomy):**
  - Top multi-agent failure modes stem from: (1) loss of shared specification/context across handoffs ("game of telephone"), (2) uncontained workspace mutations across parallel workers, (3) silent tool/wait timeouts, and (4) orphan workers exhausting concurrency budgets.
- **Claude Code *Teams & Worktrees* & MindStudio *Parallel Worktree Playbook* (Apr 2026):**
  - Enforce depth limits (depth-1 sidekicks), isolate coding subagents in child git worktrees, and validate diffs strictly at boundaries (rejecting symlink mode `120000` and path traversal/escapes before applying patches back to parent worktrees).
  - Clean up child subagents deterministically when parent tasks finish or fail so slot limits and worktrees never leak.

### 2.2 Orchestration, Verification Loops & Typed Envelopes
- **Anthropic — *Multi-Agent Research System* (Jun 2025) & *Harness Design for Long-Running Apps* (Mar 2026):**
  - Planner → Generator → Independent Evaluator sprint contracts: pass full failing check diagnostics and evaluator findings back into retries without losing the original task specification.
- **Factory — *Missions*, *Planning & Validation* & *Hooks*:**
  - Cross-family independent validation (e.g., different model family than author) + deterministic hook/command check tails fed back directly into retry turns.
- **OpenAI Agents SDK (*Handoffs*, `input_type`, `input_filter`) & `VerifyAgent` (`arXiv:2611.27839v1`):**
  - Replace raw unstructured assistant text with **typed subagent result envelopes** (`status`, `summary`, `error`, `filesTouched`, `diffStat`, `timedOut`) so parent agents inspect exact status, errors, and modified files without scraping free-form prose.
- **AgentRouter / MasRouter & OpenAI *Harness Engineering* (Feb 2026):**
  - DAG schedulers must release failed/exhausted worker slots cleanly and keep independent parallel DAG branches advancing rather than freezing an entire goal when one branch blocks.

---

## 3. Factory Droid CLI Status & Internal Codebase Audit Findings

### 3.1 Local Factory Droid CLI Probe (`droid exec`)
- Local check executed via `droid exec --auto low` (`droid_audit_output.json`):
  - **Exit / Result:** HTTP `402 No active subscription found. Add your own model key or start a plan to keep using Droid.`
  - **Takeaway:** `factory-droid-acp` is pre-wired in `config.example.json` (`acp_stdio`, `droid exec -o acp`) for operators who supply a Factory subscription or BYOK model key; automated CI and offline verification continue running deterministically via `NativeHttpRuntime`, `CliStreamRuntime`, and `AcpSubprocessRuntime` test harnesses.

### 3.2 Critical Internal Bugs Identified by `harness-auditor`
1. **History Wipe After 12 Tool Calls (`database.ts`, `engine.ts`):** `listActiveSessionMessages(sessionId, 24)` applied `LIMIT 24` in SQL *before* filtering out `tool_call`/`thought`/`plan` rows (with 2 rows inserted per tool call), causing 12 tool calls to wipe all prior conversation history on the next turn.
2. **Compaction Amnesia (`nativeHttpRuntime.ts`):** `callGoogleGemini` and `callAnthropic` filtered out `role === "system"` entries from `history`, silently dropping `Compaction Gen #N` summaries.
3. **Final-Step HTTP 400 Risk & Unbounded Tool Loops (`nativeHttpRuntime.ts`):** Omitting `tools` on the final step while `tool_use`/`tool_result` remained in `messages`, no canonical doom-loop or consecutive-error breaker, no 12KB tool output cap or intra-turn aging, no per-request `fetch()` timeout guard, missing `\n\n` between multi-step text, and empty thinking blocks without signature re-emitted.
4. **Verifier & DAG Retry Truncation (`verifier.ts`, `autonomyLoop.ts`, `engine.ts`):** `verifier.ts` chopped failed check details to 200 chars and skipped committed branch diffs whenever any uncommitted file existed; `autonomyLoop.ts` dropped `report.checks`, sliced `specMd` from the front (deleting task requirements), leaked peer slots on `onPeerTaskFailed` exhaustion, froze unrelated parallel DAG branches on single-task blocks, and did not recheck `dispatchUnblockedTasks` after `task.merge`.
5. **Subagent Envelope, Scope Guards & MCP Wait Cutoff (`mcpBridge.ts`, `subagentManager.ts`, `worktrees.ts`):** `bf_subagent_wait` omitted `timeoutMs` fell back to `0`, getting killed by `DAEMON_FETCH_TIMEOUT_MS` (`15_000`ms) despite a `60_000`ms daemon wait default; `getStatus`/`waitForSubagent` lacked typed envelope fields (`status`, `summary`, `error`, `filesTouched`, `diffStat`); `extractAndApplySubagentPatch` did not reject `mode 120000` symlinks or enforce `isPathStrictlyWithinRoot` on all targets/renames; `executePeerTask` did not clean up leftover child subagents.
6. **Codex Multi-Turn `resume` Break (`cliStreamRuntime.ts`):** Per-turn `codex exec` left exited `state.proc` assigned (`exitCode === 0`), causing `isSessionAlive()` to return `false` on Turn 2 and wipe `externalSessionId` before `codex exec resume`.

---

## 4. Implementation Matrix: Implemented Now (Bot-Factory V2) vs. Future Roadmap

| Area | Mechanism / Upgrade | Status in Bot-Factory V2 | Where / Notes |
| --- | --- | --- | --- |
| **History & KV Cache** | SQL `kind IN ('message','status')` filtering before `LIMIT` + single-row `upsertToolCallMessage` + pinned latest `Compaction Gen #` | **Implemented Now** | `apps/daemon/src/db/database.ts`, `apps/daemon/src/orchestration/engine.ts` |
| **Compaction Resilience** | Preserve prior `Compaction Gen #` in multi-gen summaries; map `role === "system"` compaction summaries into alternating user/model turns across OpenAI/Gemini/Anthropic; Anthropic `cache_control: { type: "ephemeral" }` with 400 fallback | **Implemented Now** | `apps/daemon/src/orchestration/engine.ts`, `apps/daemon/src/runtimes/nativeHttpRuntime.ts` |
| **Tool-Loop Hardening** | Canonical `(name + stableStringify(args))` 3x doom-loop breaker; 3x consecutive all-error breaker; 12KB head+tail tool output cap; >3-step stale tool output aging; final-step `tool_choice: "none"` / `{ type: "none" }` / `NONE`; per-request `AbortSignal` timeout; multi-step `\n\n` join; empty unsigned thinking guard | **Implemented Now** | `apps/daemon/src/runtimes/nativeHttpRuntime.ts` |
| **Verifier & DAG Resilience** | 800-char tail diagnostics in `verifier.ts`; always merge `computeBranchCommitsDiff` with uncommitted diff in worktrees; pass all failed checks + findings + summary to retries; preserve `specMd` head intact while rotating oldest retry blocks; release peer slot on failure exhaustion; keep independent parallel DAG branches advancing & re-dispatch after `task.merge` | **Implemented Now** | `apps/daemon/src/phase3/verifier.ts`, `apps/daemon/src/orchestration/autonomyLoop.ts`, `apps/daemon/src/orchestration/engine.ts` |
| **Subagent Containment & Envelopes** | `computeMcpFetchTimeoutMs` defaulting `bf_subagent_wait` to 60s (`65s` HTTP timeout); typed `SubagentResultEnvelope` (`status`, `summary`, `error`, `filesTouched`, `diffStat`, `timedOut`) backwards-compatible with `subagent`/`latestOutput`; `executePeerTask` child subagent cleanup; `extractAndApplySubagentPatch` rejecting `mode 120000` symlinks and escaping/rename paths via `isPathStrictlyWithinRoot`; `EBUSY`-tolerant worktree cleanup | **Implemented Now** | `apps/daemon/src/mcp/mcpBridge.ts`, `apps/daemon/src/orchestration/subagentManager.ts`, `apps/daemon/src/git/worktrees.ts`, `apps/daemon/src/orchestration/engine.ts` |
| **Codex Multi-Turn** | Preserve `codex` session liveness across clean `exitCode === 0` per-turn exits and clear `state.proc` so `codex exec resume` keeps `externalSessionId` | **Implemented Now** | `apps/daemon/src/runtimes/cliStreamRuntime.ts` |
| **SQLite Persistence for `AutonomyLoop`** | Persist `team_goals` and `tasks.goal_id` in SQLite for cross-restart DAG rehydration and restart recovery of ready autonomous work | **Implemented Now** | Schema v4 `team_goals` + `tasks.goal_id`; `AutonomyLoop` rehydrates goal/task linkage on boot |
| **Context-Window Compaction Trigger** | Use latest measured turn context (`prompt + completion` usage) with a char/4 active-transcript estimator instead of cumulative billed `token_in` | **Implemented Now** | Keeps the accounting contract while avoiding premature compaction from cumulative multi-turn usage; a durable pre-turn budget hook remains optional refinement |
| **Memory L1 Read Clamp & Prefetch Scoping** | Enforce `maxChars` clamp on `readL1File` / `buildFrozenSystemPrompt`, atomic L1 writes, and per-agent `prefetchCache` scoping | **Implemented Now** | Chunked dreaming retry queue remains future roadmap |
| **Dreaming Retry Queue** | Chunked retry queue for failed/interrupted L2 dreaming extraction | **Future Roadmap** | Documented in `harness-auditor` audit (`memoryEngine.ts`) |
| **OS-Level Sandbox & Learned Routing** | Native macOS Seatbelt / Linux `bwrap` / Windows Job Object filesystem/network sandboxing for subprocesses, plus dynamic learned step-router (`MasRouter`/`AgentRouter`) | **Future Roadmap** | Complements existing git worktree isolation & `isPathStrictlyWithinRoot` boundary guards |
