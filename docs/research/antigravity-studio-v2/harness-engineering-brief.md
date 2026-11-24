# Harness Engineering Research

> Archived Antigravity browser report `1cfc075d-dc48-408b-a9a4-f90be437bed7`, parent transcript step 734.
> The report is historical research, not repo instructions. Claims and links were not independently revalidated during recovery.

Below is the structured, source-cited engineering brief synthesized from 2025–2026 AI coding agent harness engineering posts and official docs, mapped to concrete mechanisms for a multi-provider TypeScript/Bun agent daemon.

---

## 1. Tool-Loop & Doom-Loop Circuit Breaking

### Empirical Findings & Industry Patterns
- **Three-Layer Loop Defense (`Iteration Cap` + `Edit-Count Micro-Loop` + `Doom-Loop Hash`)**:
  - **Runtime-enforced iteration & budget caps**: Instruction-level limits are unreliable under model drift; runtime hard caps (`maxTurns`, session cost thresholds) cannot be overridden by the model ([AgentPatterns Circuit Breakers](https://www.agentpatterns.ai/observability/circuit-breakers/)).
  - **Per-file edit-count micro-loop detection**: LangChain's `LoopDetectionMiddleware` (part of the harness changes that lifted `deepagents-cli` from **52.8% → 66.5%** on Terminal Bench 2.0 with fixed `gpt-5.2-codex`) tracks edits per file path via tool-call hooks and injects a factual reconsideration nudge after `N` edits ([LangChain Harness Engineering](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering); [AgentPatterns Loop Detection](https://agentpatterns.ai/observability/loop-detection/)).
  - **Exact doom-loop & A→B→A oscillation breaking**:
    - **OPENDEV** runs doom-loop detection during dispatch, matching identical `(tool_call, error)` pairs against recent history and terminating rather than nudging when identical failures repeat ([arXiv:2603.05344](https://arxiv.org/abs/2603.05344); [AgentPatterns Loop Detection](https://agentpatterns.ai/observability/loop-detection/)).
    - **Experiment E28** hashed `sorted(edited_files) :: sorted(error_codes)` plus file SHA-256 history to catch `A → B → A` edit oscillations across modules. Tripping the breaker rolled back partial edits (`git checkout -- .`) and injected a cross-layer strategy-shift directive, cutting input tokens by **-94.9%** (`43,900 → 2,230`) and model calls by **-66.7%** (`3 → 1`) ([Tappers E28](https://tappers.hashnode.dev/e28-loop-detection-circuit-breaker)).
  - **Transport & Retry Watchdogs**: Claude Code's default streaming idle watchdog aborts and retries streams producing no events for 5 minutes (`CLAUDE_ENABLE_STREAM_WATCHDOG`), and client retry logic must respect API non-retryable errors so hung turns do not stall indefinitely ([AgentPatterns Circuit Breakers](https://www.agentpatterns.ai/observability/circuit-breakers/)).
  - **Calibration Warning (Backfire Risk)**: Across 220 instrumented runs (`boucle2026`), only half of 12 automated loop interventions reduced their target signal, and detector-on-detector feedback can amplify loops or waste context near the limit ([AgentPatterns Loop Detection](https://agentpatterns.ai/observability/loop-detection/)). Distinguishing **stagnant failures** (loop) from **decreasing failure counts** (legitimate iterative refinement) prevents false positives.

### Actionable Mechanisms for a TypeScript/Bun Daemon
- Implement a **stateful Turn Watchdog & Circuit Breaker** per session:
  1. **Canonical Tool-Call & Error Fingerprinter**: Hash `toolName + canonicalJson(args)` and normalized error/exit signature (`SHA-256` prefix). Trip `DOOM_LOOP` after `>= 2–3` identical `(callHash, errorHash)` repeats; trip `OSCILLATION` if a file's post-edit SHA-256 reverts to any prior hash in the last `K` turns.
  2. **Progress-Aware Edit Counter**: Track `editCounts.get(filePath)` alongside `lastTestFailureCount`. Only inject a nudge if `edits >= N` **and** `failureCount` is non-decreasing.
  3. **Hard Runtime Guards**: Enforce `maxTurns`, `maxToolCallsPerTurn`, `streamIdleTimeoutMs` (via `AbortController` on provider SSE streams), and `maxSessionCostUsd` outside the prompt.
  4. **Graceful Degradation on Trip**: Halt writes, preserve/return partial diff + trigger reason (`DOOM_LOOP` / `BUDGET_EXCEEDED`), and optionally escalate to a human gate or fresh-context reset rather than silently discarding work.

---

## 2. Context Engineering, Tool-Output Pruning/Offloading, Compaction & Prompt-Cache Prefix Stability

### Context Engineering & Tool-Output Control
- **Attention Budget & Context Rot**: Transformer attention scales as $O(n^2)$ pairwise relationships; every low-signal token degrades recall ("context rot") ([Anthropic Context Engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)).
- **Token-Efficient ACI & Tool Responses**:
  - **Hard truncation + steering**: Claude Code caps tool outputs at **25,000 tokens** by default and pairs truncation with actionable hints (e.g., use narrower search/range reads) ([Anthropic Writing Tools for Agents](https://www.anthropic.com/research/writing-tools-for-agents)).
  - **Concise vs. Detailed modes**: Expose a `response_format: "concise" | "detailed"` parameter (saving ~2/3 tokens when IDs/metadata aren't needed) and map opaque UUIDs to natural identifiers ([Anthropic Writing Tools for Agents](https://www.anthropic.com/research/writing-tools-for-agents)).
  - **Windowed views & succinct search**: SWE-agent's ACI showed **100-line windowed file viewers** and file-path-only grep summaries outperform raw `cat` or verbose match context ([SWE-agent ACI](https://swe-agent.com/0.7/background/aci/)).
  - **Keep errors in context; avoid few-shotting into a rut**: Manus deliberately leaves failed actions and stack traces in context so the model updates its beliefs and stops repeating mistakes, while adding minor template variation on repetitive batch tasks to avoid few-shot imitation ruts ([Manus Context Engineering](https://manus.im/en/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
  - **Recitation (`todo.md`)**: Updating a checklist file pushes global objectives into the tail of the context window, counteracting "lost-in-the-middle" goal drift over 50+ tool calls ([Manus Context Engineering](https://manus.im/en/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).

### Offloading, Compaction & Resets
- **Restorable Compression / Filesystem & Session-Log Offloading**:
  - **Manus** treats the sandbox filesystem as externalized memory and keeps compression *restorable* (drop web page/file bodies while keeping the URL or file path) ([Manus Context Engineering](https://manus.im/en/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
  - **Anthropic Managed Agents** separates the **Session** (durable append-only event log outside the context window, interrogated via positional `getEvents()` slices) from the **Context Window** (ephemeral harness-transformed projection) so compaction decisions are never irreversible ([Anthropic Managed Agents](https://www.anthropic.com/research/managed-agents)).
- **Anchored Iterative Summarization vs. Full Regeneration vs. Opaque Compaction**:
  - **Factory AI** benchmarked compression across **36,611 production messages** using 4 functional probes (Recall, Artifact, Continuation, Decision) scored 0–5: **Factory anchored iterative summarization scored 3.70** (Accuracy 4.04, Context 4.01) vs. **Anthropic full-regeneration 3.44** vs. **OpenAI `/responses/compact` 3.35** (99.3% compression, lowest technical detail retention). Crucially, **Artifact Trail** (tracking touched files) scored poorly across *all* summarizers (**2.19–2.45/5.0**), proving file state must be tracked in deterministic scaffolding outside LLM summaries ([Factory Evaluating Compression](https://factory.com/news/evaluating-compression)).
  - **Context Resets vs. Compaction (Model-Generation Sensitivity)**: Anthropic found Claude Sonnet 4.5 suffered "context anxiety" (wrapping up prematurely near limits) requiring hard **context resets + structured handoff files**, whereas Claude Opus 4.5 eliminated context anxiety, making forced resets unnecessary dead weight ([Anthropic Harness Design](https://www.anthropic.com/research/harness-design-long-running-apps); [Anthropic Managed Agents](https://www.anthropic.com/research/managed-agents)).

### Prompt-Cache Prefix Stability & Multi-Provider Routing
- **100:1 Input-to-Output Ratio**: Because coding agents average ~100:1 input:output tokens (e.g., Factory Missions logged **744.9M cache-read tokens out of 778.5M total**), KV-cache hit rate is the dominant cost/latency lever ([Manus Context Engineering](https://manus.im/en/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus); [Factory Missions Architecture](https://factory.com/news/missions-architecture)).
- **Codex & Manus Prefix Rules**:
  - **Stateless prefix preservation**: OpenAI Codex avoids server-side `previous_response_id` (staying stateless/ZDR-compatible via `encrypted_content`) and keeps tool definitions and initial `instructions` frozen. When sandbox permissions or `cwd` change mid-session, Codex **appends** a new `developer` (`<permissions instructions>`) or `user` (`<environment_context>`) message rather than mutating earlier items ([OpenAI Unrolling the Codex Loop](https://openai.com/index/unrolling-the-codex-agent-loop/)).
  - **Deterministic serialization & no dynamic timestamps**: Always use stable JSON key ordering and never put per-second timestamps in the system prefix ([Manus Context Engineering](https://manus.im/en/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
  - **Mask, Don't Remove Tools**: Never dynamically add/remove MCP tools mid-loop (which invalidates the prefix cache near the front of the prompt); keep the tool schema fixed and constrain calls via response prefill / logit masking or namespaced prefixes ([Manus Context Engineering](https://manus.im/en/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
  - **Multi-Provider Switching Without Cache Thrash (`Devin Fusion`)**: Calling an "Advisor" or "Smart Friend" model synchronously on full context misses cache on every call. Instead, **Devin Fusion** runs a parallel **Sidekick** agent with its own persistent cached context (41–60% cheaper on FrontierCode) and performs **dynamic mid-session model switching at context compaction boundaries**, where a cache miss occurs anyway ([Cognition Devin Fusion](https://cognition.com/blog/devin-fusion)). Note 5-minute provider cache TTLs when scheduling daemon work.

### Actionable Mechanisms for a TypeScript/Bun Daemon
- **Split Storage from Projection**: Persist an immutable append-only event log (`JSONL`/SQLite) per session, and build a pure `projectContext(events, providerAdapter)` function that renders provider-specific payloads (`AnthropicMessages`, `OpenAIResponses`, `GeminiContents`).
- **Deterministic Tool-Output Spooler**: Truncate any tool output above e.g. `~12–25k` tokens, write the full artifact to `.agent/tmp/tool_<id>.log`, and return head/tail + line count + file path so the agent can `grep`/slice on demand.
- **Anchored Structured Compactor + Deterministic Artifact Index**: Maintain a daemon-owned `touchedFiles` map (path, ops, last hash, test status) outside LLM prose, and merge newly truncated spans into a structured summary schema (`intent`, `decisions`, `modified_files`, `next_steps`).
- **Cache-Safe Mutation Discipline**: Freeze `system` + `tools` per session; emit state/CWD/sandbox updates as appended user/developer deltas; place explicit `cache_control` breakpoints at system/tools and latest stable turn; trigger cross-provider model escalation/downgrade only on compaction boundaries or via persistent-context subagent workers.

---

## 3. Structured Verification & Validator Feedback Loops

### Empirical Findings & Industry Patterns
- **Self-Evaluation Bias**: Agents that wrote code reliably rationalize bugs and praise mediocre output when asked to evaluate their own work ([Anthropic Harness Design](https://www.anthropic.com/research/harness-design-long-running-apps); [Factory Missions Architecture](https://factory.com/news/missions-architecture)).
- **Independent Evaluator / Validator Separation**:
  - **Anthropic's 3-Agent Harness (Planner → Generator → Evaluator)** negotiates a testable **sprint contract** before coding, then runs an isolated **Evaluator** using **Playwright MCP** against the live app to produce concrete defect feedback for the next generator iteration ([Anthropic Harness Design](https://www.anthropic.com/research/harness-design-long-running-apps)).
  - **Factory Missions** separates **Orchestrator**, **Workers** (completing features in `features.json`), and **Independent Validators** (driven by an upfront `validation-contract.md`: `scrutiny-validator` + `user-testing-validator` using `tuistory` / `agent-browser`). Validators never implement fixes; they emit structured findings that spawn fix features (`81` issues surfaced → `21` fix features in a real build) ([Factory Missions Architecture](https://factory.com/news/missions-architecture); [Factory Planning & Validation](https://docs.factory.com/missions/planning-and-validation)).
- **Deterministic Lifecycle Hooks & Pre-Completion Gates**:
  - **LangChain `PreCompletionChecklistMiddleware`** intercepts agent exit (similar to a controlled Ralph Wiggum loop) to force a final verification pass against the original specification before returning ([LangChain Harness Engineering](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering)).
  - **SWE-agent Edit-Time Linter** rejects syntactically invalid edits immediately at tool execution time, returning actionable lint errors before the bad state enters the repo ([SWE-agent ACI](https://swe-agent.com/0.7/background/aci/)).
  - **Factory Hooks Protocol** (`PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PreCompact`) lets deterministic scripts enforce checks via exit codes (`exit 2` = deterministic block; `stderr` or JSON `reason` is fed directly back into the model's next turn on `PostToolUse`/`Stop`, and `onFailure: "block"` fails closed) ([Factory Hooks](https://docs.factory.com/harness/hooks)).
  - **OpenAI Harness Engineering** (0 manual lines, ~1M LOC, ~1,500 PRs) relies on custom architectural linters, structural tests, and machine-readable observability/DOM inspection so Codex agents receive exact, local remediation instructions on every failure ([OpenAI Harness Engineering](https://openai.com/index/harness-engineering/)).
  - **Reasoning Sandwich**: Spending `xhigh` reasoning on upfront planning and final verification while using `high` for middle implementation lifted Terminal Bench 2.0 from **53.9%** (pure `xhigh` timed out) to **66.5%** ([LangChain Harness Engineering](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering)).

### Actionable Mechanisms for a TypeScript/Bun Daemon
- **Lifecycle Hook Bus (`PreToolUse`, `PostToolUse`, `PreStop`)**:
  - On `PostToolUse(edit|write)`, optionally run fast syntactic/typecheck validation (e.g., `tsc --noEmit` / AST parse / `oxlint`) and append concise structured diagnostics (`file:line:col`, rule, message) directly to the tool result.
  - On `PreStop` (when the model emits no tool calls), run configured verification commands (`bun test`, typecheck, lint) and **only** allow loop termination if checks pass or `maxRetries` is reached; otherwise convert stderr/test failures into a compact structured failure summary (deduplicated root causes, capped line count) and continue the loop.
- **Unbiased Validator Subagent**: When verifying high-stakes or multi-file tasks, spawn a **fresh-context validator** given only the diff, spec/acceptance criteria, and test/browser tools—never the generator's reasoning trace—returning structured pass/fail assertions.
- **Provider-Aware Reasoning Routing**: Expose per-phase reasoning budgets (`plan: high`, `execute: medium`, `verify: high`) across providers rather than maxing reasoning on every routine edit.

---

## 4. Sandbox/Worktree Guardrails, Checkpointing & Long-Running Failure Mitigations

### Empirical Findings & Industry Patterns
- **OS-Level Process-Tree Sandboxing + Proxy Egress**:
  - **OpenAI Codex Sandbox** runs commands natively on the developer host (avoiding Docker toolchain mismatch) via `spawn_command_under_sandbox(...)` across **macOS Seatbelt**, **Linux Landlock/bubblewrap/seccomp**, and **Windows** primitives. All descendant processes inherit the sandbox tree; workspace files are writable while **`.git` and `.codex` remain read-only** (blocking `.git/hooks` or config tampering), and network access is disabled or routed through a `NetworkProxy` ([OpenAI Inside the Codex Sandbox](https://openai.com/de-DE/index/inside-the-codex-sandbox/)).
  - **Factory Sandbox** similarly uses **macOS Seatbelt**, **Linux `bubblewrap` + `seccomp`**, and **Windows MXC**, routing all outbound network through an **HTTP/SOCKS allowlist proxy**, failing closed if OS primitives are unavailable, and offering `per-command` vs. `whole-process` isolation ([Factory Sandbox](https://docs.factory.com/autonomy-and-safety/sandbox)).
- **Credential Isolation Outside the Sandbox**:
  - **Anthropic Managed Agents** decouples **Brain** (stateless harness), **Hands** (`execute(name, input) -> string` cattle containers provisioned lazily, cutting p50 TTFT ~60% and p95 >90%), and **Session** (durable log enabling `wake(sessionId)` crash recovery). Crucially, API/OAuth/Git tokens are **never placed inside the sandbox environment**; Git remotes are pre-wired at init and external MCP tools go through an out-of-sandbox credential proxy vault ([Anthropic Managed Agents](https://www.anthropic.com/research/managed-agents)).
- **Risk-Tiered Autonomy & Diff Secret Scanning**:
  - **Factory Autonomy Levels** (`Off`, `Low`, `Medium`, `High`) classify `Execute` and MCP tools by risk and evaluate explicit `allow` / `ask` / `block` policies before falling back to the session autonomy level ([Factory Autonomy Levels](https://docs.factory.com/autonomy-and-safety/auto-run)).
  - **Factory Droid Shield** scans added lines on `git commit`/`git push` using deterministic pattern + entropy checks (plus semantic risk/false-positive classifiers in 2.0) to block secret leaks ([Factory Droid Shield](https://docs.factory.com/autonomy-and-safety/droid-shield)).
- **Long-Running Checkpointing & Failure Modes**:
  - **Anthropic Initializer + Coding Agent** solved four core failure modes: (1) premature victory → immutable JSON `feature_list.json` (`passes: false` toggled only after e2e verification; JSON resists accidental edits better than Markdown), (2) dirty/undocumented state → mandatory git commits + `claude-progress.txt`, (3) wasted startup time → `init.sh` smoke-test script, (4) missing environment context → `LocalContextMiddleware` injecting directory tree & tool paths at session start ([Anthropic Long-Running Harnesses](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents); [LangChain Harness Engineering](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering)).
  - **Workstreams & Shared Context**: **Cognition** warns against naive multi-agent splits that hide implicit decisions and cause diverging subagent worlds ([Cognition Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)); **Factory Workstreams** and isolated worker machines pair scoped task ownership with a shared artifacts folder and PR-based review ([Factory Workstreams](https://docs.factory.com/workstreams/overview)).

### Actionable Mechanisms for a TypeScript/Bun Daemon
- **Git Worktree Isolation & Automatic Checkpoints**:
  - Spawn autonomous runs inside a dedicated `git worktree` (`git worktree add`) per session/task so concurrent runs cannot collide.
  - Capture a **pre-turn shadow commit / git tree snapshot** (`git write-tree` or lightweight ref under `refs/agent-checkpoints/<session>/<turn>`) before file-mutating turns, enabling instant deterministic rollback when a doom-loop circuit breaker trips.
- **Process-Tree Sandboxing & Secret-Free Child Env**:
  - Wrap `Bun.spawn(...)` in OS-native confinement (`bwrap`/`seccomp` on Linux, `sandbox-exec` on macOS, Job Objects / AppContainer or WSL2 isolation on Windows), keep `.git/` and daemon config directories **read-only** to tool subprocesses, and strip provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) from child process `env` (route external auth via daemon-hosted MCP proxies).
  - Default to network-off or an explicit domain-allowlist local HTTP/SOCKS proxy.
- **Pre-Commit Secret Guard & Risk Policy Gate**:
  - Intercept `git commit` / `git push` and destructive shell commands in `PreToolUse`: run regex + Shannon-entropy secret scanning on staged diffs and enforce tiered `allow` / `ask` / `block` rules.
- **Crash-Resilient Daemon State**:
  - Store session events, `feature_list.json` / task state, `touchedFiles` artifact index, and checkpoint refs durably on disk so daemon restarts recover via `wake(sessionId)` without losing trajectory state.

---

## Sources Visited

1. Anthropic — *Building effective agents* (Dec 2024): https://www.anthropic.com/engineering/building-effective-agents
2. Anthropic — *Writing effective tools for agents — with agents* (Sep 2025): https://www.anthropic.com/research/writing-tools-for-agents
3. Anthropic — *Effective context engineering for AI agents* (Sep 2025): https://www.anthropic.com/research/effective-context-engineering-for-ai-agents
4. Anthropic — *Effective harnesses for long-running agents* (Nov 2025): https://www.anthropic.com/research/effective-harnesses-for-long-running-agents
5. Anthropic — *Harness design for long-running application development* (Mar 2026): https://www.anthropic.com/research/harness-design-long-running-apps
6. Anthropic — *Scaling Managed Agents: Decoupling the brain from the hands* (Apr 2026): https://www.anthropic.com/research/managed-agents
7. Factory Research — *Evaluating Context Compression for AI Agents* (Dec 2025): https://factory.com/news/evaluating-compression
8. Factory Research — *How Missions Work* (Apr 2026): https://factory.com/news/missions-architecture
9. Factory Docs — *Planning & Validation*: https://docs.factory.com/missions/planning-and-validation
10. Factory Docs — *Hooks*: https://docs.factory.com/harness/hooks
11. Factory Docs — *Sandbox*: https://docs.factory.com/autonomy-and-safety/sandbox
12. Factory Docs — *Autonomy Level*: https://docs.factory.com/autonomy-and-safety/auto-run
13. Factory Docs — *Droid Shield*: https://docs.factory.com/autonomy-and-safety/droid-shield
14. Factory Docs — *Workstreams Overview*: https://docs.factory.com/workstreams/overview
15. OpenAI — *Unrolling the Codex Agent Loop* (Jan 2026): https://openai.com/index/unrolling-the-codex-agent-loop/
16. OpenAI — *Harness Engineering: Leveraging Codex in an Agent-First World* (Feb 2026): https://openai.com/index/harness-engineering/
17. OpenAI Developers — *Codex as a platform: build on the open agent harness* (Aug 2026): https://developers.openai.com/blog/codex-as-a-platform
18. OpenAI — *Inside the Codex Sandbox* (Nov 2026): https://openai.com/de-DE/index/inside-the-codex-sandbox/
19. Cognition — *Don’t Build Multi-Agents* (Jun 2025): https://cognition.com/blog/dont-build-multi-agents
20. Cognition — *Devin Fusion: Frontier Performance at 60% Lower Cost* (Jun 2026): https://cognition.com/blog/devin-fusion
21. Manus — *Context Engineering for AI Agents: Lessons from Building Manus* (Jul 2025): https://manus.im/en/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
22. LangChain — *Improving Deep Agents with harness engineering* (Feb 2026): https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering
23. SWE-agent Docs — *Agent Computer Interface (ACI)*: https://swe-agent.com/0.7/background/aci/
24. OPENDEV Paper (Bui, Mar 2026) — *Building Effective AI Coding Agents for the Terminal*: https://arxiv.org/abs/2603.05344
25. AgentPatterns.ai — *Loop Detection for AI Agents*: https://agentpatterns.ai/observability/loop-detection/
26. AgentPatterns.ai — *Circuit Breakers for Agent Loops*: https://www.agentpatterns.ai/observability/circuit-breakers/
27. Tappers Tech Blog — *Breaking A→B→A Edit Oscillations in Coding Agents (Experiment E28)* (Nov 2026): https://tappers.hashnode.dev/e28-loop-detection-circuit-breaker
