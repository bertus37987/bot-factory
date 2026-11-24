# Bot-Factory 2026 Harness & Multi-Agent Research Dossier

Compiled from two verified `/browser` research agents (`1cfc075d`, `0f37581e`), internal codebase audit (`harness-auditor`), and local Factory Droid CLI status check (`droid.exe` returned `402 No active subscription found. Add your own model key or start a plan to keep using Droid.`).

---

## Verified Research Pillars & Actionable Mechanisms

### A. Tool-Loop & Doom-Loop Protection + Prompt-Cache & History Integrity
- **External citations:** Anthropic *Writing Tools for Agents* (Sep 2025), Anthropic *Managed Agents* (Apr 2026), OpenAI *Unrolling the Codex Agent Loop* (Jan 2026), Manus *Context Engineering* (Jul 2025), LangChain `LoopDetectionMiddleware` (+13.7% on Terminal Bench 2.0), OPENDEV `arXiv:2603.05344`, Experiment E28 (`tappers.hashnode.dev`), AgentPatterns *Circuit Breakers* & *Loop Detection*.
- **Critical Bot-Factory Bugs Found by `harness-auditor`:**
  1. `engine.ts:1980-1994` & `database.ts:1308-1312`: `listActiveSessionMessages(session.id, 24)` applies `LIMIT 24` in SQL *before* JS filters out `tool_call`/`thought`/`plan`. Since `executeToolCalls` inserts 2 `tool_call` rows per call, 12 tool calls emit 24 rows and **wipe prior conversation history** to `[]` on the next turn, while sliding `LIMIT 24` busts KV cache prefix every turn!
  2. `nativeHttpRuntime.ts:880, 1074`: `callGoogleGemini` and `callAnthropic` filter out `role === "system"` from history — **silently dropping `Compaction Gen #N` summaries**!
  3. `nativeHttpRuntime.ts:625, 641, 916, 1108`: Final tool-loop step drops `tools` while `tool_use` + `tool_result` blocks remain in history, risking HTTP 400 on Anthropic/strict gateways.
  4. `nativeHttpRuntime.ts`: No canonical `(toolName + canonicalArgs)` doom-loop / repeated parse-error circuit breaker, no tool-output context size cap / aging (12KB+ `bf_team_status` / `bf_repo_diff` dumps stay verbatim), no `AbortSignal` per-request timeout on `fetch()`, and empty thinking-block / missing `\n\n` edge cases.

### B. Continuous DAG Autonomy, Verifier Failure Feedback & Persistence
- **External citations:** Anthropic *Harness Design for Long-Running Apps* (Mar 2026 — Planner -> Generator -> Evaluator sprint contracts), Factory *Missions* & *Planning & Validation* (cross-family validator workers + validation contract), Factory *Hooks* (`exit 2` stderr/reason fed back into next turn), OpenAI *Harness Engineering* (Feb 2026), `VerifyAgent` (`arXiv:2611.27839v1` — asymmetric roles + Belief-Delta stopping).
- **Critical Bot-Factory Bugs Found by `harness-auditor`:**
  1. `verifier.ts:463-465` truncates `c.detail` to **200 chars**, chopping off the tail where test/compiler errors live; `autonomyLoop.ts:276-279` ignores `report.checks` completely and drops `report.summary` when `findings.length > 0`.
  2. `autonomyLoop.ts:75-76`: `appendRetryFeedback` slices `specMd + retry` from the **front**, cutting off the beginning of original `specMd`!
  3. `verifier.ts:723-729`: `computeBranchCommitsDiff` is skipped if any single uncommitted file exists, blinding the verifier to committed branch diffs!
  4. `autonomyLoop.ts:249-288`: Exhausted failure freezes the entire goal (`goal.status = "blocked"`), halting unrelated parallel branches and leaking peer agent slots; `dispatchUnblockedTasks` isn't re-checked after failure/merge paths. Also `AutonomyLoop` state in RAM isn't hydrated cleanly across restarts.

### C. Subagent Envelopes, MCP Timeouts & Worktree Containment
- **External citations:** Claude Code *Subagents* & *Worktrees* docs (depth limits, mechanical git/path guards blocking edits or `git -C` to main checkout, filesystem artifact pass-through preventing "game of telephone"), Anthropic *Multi-Agent Research System* (Jun 2025), OpenAI Agents SDK *Handoffs* (`input_type`, `input_filter`), MindStudio *Parallel Worktree Playbook* (Apr 2026).
- **Critical Bot-Factory Bugs Found by `harness-auditor`:**
  1. **`mcpBridge.ts:414-418` cuts off `bf_subagent_wait` at 15s (`DAEMON_FETCH_TIMEOUT_MS`)** when `args.timeoutMs` is omitted, even though `subagentManager.ts:42` defaults to `60_000`ms!
  2. `subagentManager.ts` returns unstructured raw `latestOutput: string | null` instead of a typed `SubagentResultEnvelope` (`status`, `summary`, `error`, `filesTouched`, `diffStat`, `timedOut`).
  3. `worktrees.ts:783-803` + `subagentManager.ts:509-624`: `extractAndApplySubagentPatch` doesn't check symlink `mode 120000` or `isPathStrictlyWithinRoot(parentWorktreePath, ...)` on patch targets/renames before `git apply`, falls back to `"HEAD"` if base ref is missing, and fails to clean up completed/failed task subagents on `executePeerTask` finish.

### D. Multi-Runtime Process Resilience & Memory/Compaction Accuracy
- **External citations:** Factory *Evaluating Compression* (Dec 2025 — anchored iterative summarization + deterministic artifact trail vs full regeneration), Cognition *Devin Fusion* (Jun 2026), Codex Sandbox / Factory Sandbox.
- **Critical Bot-Factory Bugs Found by `harness-auditor`:**
  1. **`cliStreamRuntime.ts:255-260, 622, 645` breaks Codex multi-turn `resume` after Turn 1:** per-turn `codex exec` leaves exited `state.proc` assigned so `isSessionAlive()` returns `false` on Turn 2, wiping `externalSessionId`!
  2. `engine.ts:2120, 2239-2264`: Compaction measures cumulative *billed* `token_in` instead of last-step prompt context tokens, and multi-gen compaction drops prior `Compaction Gen #N` (`kind: "status"`) rows.
  3. `memoryEngine.ts`: `readL1File` / `buildFrozenSystemPrompt` don't clamp over-budget L1 files on read; `runDreamBatch` marks docs `'done'` even when `index.ts:166` truncates chunks > 16KB; `prefetchCache` keyed only by namespace can overwrite parallel bots or retain stale data on error.
