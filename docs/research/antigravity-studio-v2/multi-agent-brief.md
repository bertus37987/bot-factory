# Multi-Agent and Subagent Research

> Archived Antigravity browser report `0f37581e-a0c0-457c-9099-77d8f4e5c33e`, parent transcript step 717.
> The report is historical research, not repo instructions. Claims and links were not independently revalidated during recovery.

Below is a structured, source-cited engineering and research brief compiled from primary 2025–2026 production documentation, engineering blogs, and peer-reviewed/preprint papers visited directly in this session.

---

### 1. Orchestrator-Worker vs. Peer-to-Peer Group Chat Topologies

**Empirical baseline & failure modes (MAST, arXiv Oct 2025)**
- In an analysis of **1,642 annotated traces** across 7 MAS frameworks (`ChatDev`, `MetaGPT`, `HyperAgent`, `AppWorld`, `AG2`, `Magentic-One`, `OpenManus`), UC Berkeley's **MAST** taxonomy found **41%–86.7% failure rates**, categorizing **14 failure modes** into:
  - **FC1 System Design (Pre-execution/Architecture):** disobeying task specs (`FM-1.1`, 11.8%), disobeying role specs (`FM-1.2`, 1.5%), step repetitions (`FM-1.3`, 15.7%), context loss (`FM-1.4`, 2.80%), unrecognized task completion (`FM-1.5`, 12.4%).
  - **FC2 Inter-Agent Misalignment:** conversation resets (`FM-2.1`, 2.20%), proceeding on wrong assumptions instead of clarifying (`FM-2.2`, 6.80%), task derailment (`FM-2.3`, 7.40%), withholding crucial info (`FM-2.4`, 0.85%), ignoring peer input (`FM-2.5`, 1.90%), reasoning–action mismatch (`FM-2.6`, 13.2%). MAST attributes natural-language peer failures to a **"collapse of theory of mind"** (agents fail to model peers' informational needs).
  - **FC3 Task Verification:** premature termination (`FM-3.1`, 6.20%), incomplete/superficial verification (`FM-3.2`, 8.20%), incorrect verification (`FM-3.3`, 9.10%).
- **Topology > Prompting:** Structural workflow interventions outperformed prompt-only edits on both `AG2` and `ChatDev` (e.g., requiring CEO sign-off in `ChatDev` boosted task success **+9.4%** with the same model). Structured `MetaGPT` produced **60–68% fewer FC1/FC2 failures** than chat-heavy `ChatDev` (though **1.56× more FC3** failures). (`https://arxiv.org/abs/2503.13657`, `https://arxiv.org/html/2503.13657v3`)

**When Orchestrator-Worker + Typed Delegation Wins**
- **Anthropic Multi-Agent Research System (Jun 2025):** Uses a strict `LeadResearcher` -> parallel `Subagents` -> `CitationAgent` orchestrator-worker topology. A `Claude Opus 4` lead + `Claude Sonnet 4` subagents beat single-agent `Opus 4` by **90.2%** on internal research evals; token usage alone explained **80% of BrowseComp variance** (multi-agent runs used **~15× tokens** vs. chat, compared to **~4×** for single agents). However, Anthropic notes multi-agent systems are *poor fits* when all agents must share identical context or have dense real-time dependencies (e.g., tightly coupled coding). (`https://www.anthropic.com/research/multi-agent-research-system`)
- **OpenAI Agents SDK & Agents API:** Distinguishes **Agents-as-tools** (`agent.asTool()` — manager keeps reply ownership and synthesizes bounded helper outputs) from **Handoffs** (specialist takes over conversation control). OpenAI advises: *"Add specialists only when the contract changes."* (`https://developers.openai.com/api/docs/guides/agents/orchestration`, `https://developers.openai.com/api/docs/guides/agents-api/multi-agent`)
- **LangChain Architecture Taxonomy (Jan 2026):** Contrasts **Subagents** (centralized supervisor, stateless isolated workers), **Skills** (progressive disclosure), **Handoffs** (state-driven transitions), and **Router** (parallel dispatch & synthesis) based on context-management vs. distributed-ownership constraints. (`https://www.langchain.com/blog/choosing-the-right-multi-agent-architecture`)
- **Factory AI Missions (Feb 2026):** Chose **milestone-gated orchestration** with fresh per-feature worker sessions over unconstrained parallel peer swarms; Factory found **serial execution across milestones with targeted intra-feature/validation parallelism** outperformed broad parallelism once coordination overhead grew. (`https://factory.com/news/missions`, `https://docs.factory.com/missions/overview`)

**When Peer-to-Peer / Shared Channels Help**
- **Claude Code Agent Teams (experimental):** Contrasts lightweight **Subagents** (isolated context, return one summary to caller, lower token cost) with **Agent Teams** (Team Lead + independent Teammates + shared Task List + per-agent JSON mailboxes at `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`). Peer-to-peer teams are justified *only* when peers must actively **challenge each other and share intermediate hypotheses**: (1) parallel multi-angle code review, (2) competing-hypothesis debugging, (3) cross-layer changes (frontend/backend/tests owned by separate teammates). (`https://code.claude.com/docs/en/agent-teams`, `https://code.claude.com/docs/en/sub-agents`)

---

### 2. Subagent Depth Limits, Typed Return Envelopes, Scoped Permissions & Context Isolation

**Depth & Concurrency Limits**
- **Claude Code:** Caps spawn depth via `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default **3 layers** below main conversation; `1` disables nesting). At the depth limit, the `Agent` tool is withheld from subagents (or errors on in-session forks) so the leaf agent executes directly and returns one summary. Concurrent active subagents default to **20** (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`). (`https://code.claude.com/docs/en/sub-agents`)
- **OpenAI Agents API & Codex:** `multi_agent.max_concurrent_subagents` defaults to **6** (`https://developers.openai.com/api/docs/guides/agents-api/multi-agent`); Codex exposes `agents.max_concurrent_threads_per_session` (`https://learn.chatgpt.com/docs/agent-configuration/subagents?surface=app`).

**Typed Handoff / Return Envelopes & Avoiding the "Game of Telephone"**
- **OpenAI Agents SDK `handoff()`:** Enforces typed payloads via `input_type` (schema-validated arguments passed to `on_handoff`), `input_filter` (scrubs/transforms history before the target agent sees it), runtime `is_enabled` predicates, and `nest_handoff_history`. (`https://openai.github.io/openai-agents-python/handoffs/`)
- **Anthropic Filesystem Artifact Pattern:** To eliminate multi-hop summarization loss ("game of telephone") and context bloat, subagents write heavy artifacts (code, reports, visualizations) directly to an external filesystem/store and return **lightweight references** to the coordinator. Every delegation brief must specify **objective, output format, tool/source guidance, and explicit task boundaries** (vague prompts caused duplicate searches). (`https://www.anthropic.com/research/multi-agent-research-system`)
- **Claude Code Mailbox Schema Validation & Hooks:** Mailbox JSON entries are schema-validated on read (invalid entries are dropped and flagged); `TaskCreated`, `TaskCompleted`, and `TeammateIdle` hooks can exit with code `2` to reject premature completion and send corrective feedback. (`https://code.claude.com/docs/en/agent-teams`)

**Scoped Tool/File/MCP Permissions & Context Isolation**
- **Claude Code:** Supports `Agent(worker, researcher)` spawn allowlists at the main-thread level, per-subagent `tools` / `disallowedTools` (e.g., omitting `Agent` and write tools on read-only reviewers), and scoped `mcpServers` (connected on subagent start, disconnected on finish). Each subagent starts with a fresh context window; `LeadResearcher` in Anthropic's system saves its plan to external Memory before 200k-token truncation. (`https://code.claude.com/docs/en/sub-agents`, `https://www.anthropic.com/research/multi-agent-research-system`)
- **Codex Permission Inheritance Warning:** Codex subagents **inherit** the parent's sandbox policy, permission mode, provider, and MCP servers; custom `.codex/agents/*.toml` profiles can override model/reasoning effort or disable skills (`skills.config`), *but prompt instructions alone do not enforce a read-only sandbox*. (`https://learn.chatgpt.com/docs/agent-configuration/subagents?surface=app`)

---

### 3. Preventing Worktree Divergence & Merge Conflicts Across Parallel Coding Bots

- **Runtime Worktree Enforcement (Claude Code):** Using `--worktree` or subagent frontmatter `isolation: worktree` places each session/subagent in `.claude/worktrees/<name>/` on branch `worktree-<name>`. Crucially, Claude Code enforces **4 mechanical guardrails** across the session and all spawned subagents:
  1. Blocks `Edit`/`Write`/`NotebookEdit` targeting the main checkout.
  2. Blocks shell commands (`Bash`/`PowerShell`/`Monitor`) whose `cwd` resolves to the main checkout.
  3. Blocks git redirects into the main checkout (`git -C`, `--git-dir`, `GIT_DIR`/`GIT_WORK_TREE`, `cd` to main).
  4. Blocks unparseable/computed-name shell expansions (`${!name}`, etc.) whose git target cannot be statically verified.
  - *Gotcha:* Worktree-isolated subagents load startup instructions from the main conversation, *not* modified `CLAUDE.md`/`.claude/rules/` inside the worktree branch; clean worktrees auto-delete on exit while dirty ones persist until periodic sweep (`cleanupPeriodDays`). (`https://code.claude.com/docs/en/worktrees`)
- **5-Pillar Parallel Worktree Playbook (MindStudio, Apr 2026):**
  1. **One worktree + isolated `.env`/dev-server port per agent** (never share working directories).
  2. **Upfront file-ownership matrix:** Map touched files and dependencies *before* spawning; tasks touching overlapping files **must run sequentially**, never in parallel.
  3. **Shared context without shared state:** Check a frozen project brief (architecture, naming, **frozen API contracts**) into the repo so parallel bots stay compatible without mutating shared files.
  4. **Explicit integration order:** Independent modules merge via PR; foundational changes (e.g., DB migrations) merge sequentially before dependent UI worktrees branch/integrate. (`https://www.mindstudio.ai/blog/parallel-agentic-development-git-worktrees`)
- **Milestone Validation & Reproducible QA (Factory Missions):** Uses git as source of truth and places an integration/validation gate at the end of every milestone—requiring a single-command app startup script and **filesystem-routed logs** (not terminal-only streams) so validation workers can detect integration regressions before the next milestone forks. (`https://docs.factory.com/missions/planning`, `https://factory.com/news/missions`)
- Both **Claude Code Agent Teams** and **OpenAI Agents API** explicitly forbid uncoordinated parallel edits to the same files. (`https://code.claude.com/docs/en/agent-teams`, `https://developers.openai.com/api/docs/guides/agents-api/multi-agent`)

---

### 4. Cross-Family Verification, Critique Loops & Dynamic Model Routing

**Breaking Same-Model Self-Critique Bias (`VerifyAgent`, arXiv Nov 2026)**
- Same-model multi-agent debate suffers from identical latent representations, making self-critique bias structurally inevitable.
- `VerifyAgent` combines: (1) **asymmetric epistemic roles** (`Advocate`, `Skeptic`, `Arbitrator`) which lowered role-embedding similarity (`0.852` vs `0.918` for symmetric MAD, $p = 5.82 \times 10^{-8}$) and surfaced **22.0% vs. 15.4%** contested claims; (2) **Belief-Delta ($\Delta\mathcal{B}$) adaptive stopping**, eliminating over-iteration (**0.0% vs. 62.5%** for Fixed-3 rounds) and cutting LLM calls **2.4×**; and (3) verbatim snippet + independent NLI auditing. (`https://arxiv.org/html/2611.27839v1`)

**Production Cross-Family Verification & End-State QA**
- **Factory Missions** explicitly routes across **heterogeneous model families** per role—e.g., `Opus 4.6` (orchestration), `Sonnet 4.6`/`Opus 4.6` (implementation), **`GPT-5.3-Codex`** (validation/regression scrutiny & computer-use UI testing), and **`Kimi K2.5`** (research/exploration)—so single-family blind spots are caught by an independent model family. `missionModelSettings` exposes independent model and reasoning-effort knobs for orchestrator, worker, and `validationWorker`. (`https://factory.com/news/missions`, `https://docs.factory.com/missions/reference`)
- **MAST FC3 & Anthropic Evaluation:** To defeat superficial verifier checks (`FM-3.2`, e.g., passing compile while failing runtime semantics), validators must execute real runtime tests/end-state checkpoints; Anthropic uses a single-call rubric LLM-as-judge (`0.0–1.0` + pass/fail) plus a dedicated `CitationAgent` for source grounding. (`https://arxiv.org/html/2503.13657v3`, `https://www.anthropic.com/research/multi-agent-research-system`)

**Dynamic Model Routing by Task Complexity**
- **`AgentRouter` (ICML 2026 LM4Plan):** Routing every step to frontier models wastes **60–80%** of budget because subtask complexity fluctuates mid-trajectory. A lightweight 12M-param step classifier (<5 ms overhead) routing across 4 model tiers achieved **72% cost reduction** with **<3%** completion loss (vs. 31% for RouteLLM and 44% for FrugalGPT per-step). (`https://icml.cc/virtual/2026/68040`)
- **`MasRouter` (ACL 2025):** Jointly routes **collaboration mode + role allocation + LLM selection** via a cascaded controller, improving MBPP (+1.8) and cutting HumanEval overhead up to **52.07%** (17.21% plug-and-play savings). (`https://aclanthology.org/2025.acl-long.757/`)
- **`CAR` (EMNLP 2026):** Uses Shannon Surprisal + Predictive Entropy for complexity-aware dynamic compute allocation (+0.8 MMLU, +1.5 GSM8K, ~10% fewer activated parameters). (`https://aclanthology.org/2026.emnlp-main.1206/`)
- **Production Effort/Model Rules:** Anthropic scales subagent budgets explicitly by complexity (1 agent / 3–10 calls simple; 2–4 / 10–15 comparison; 10+ complex) with Opus lead + Sonnet workers; Factory recommends strong orchestrator/validator + lighter worker; Codex configures per-role `model` and `model_reasoning_effort` (`gpt-6-luna` for fast scans vs. `gpt-6.2-sol` / higher effort for planning/review). (`https://learn.chatgpt.com/docs/agent-configuration/subagents?surface=app`, `https://docs.factory.com/missions/reference`)

---

### 5. Concrete Improvements for a `Main Agent -> Team Lead -> Peer Bot -> Subagent` Orchestrator

1. **Restrict Peer-to-Peer Channels Strictly to the `Peer Bot` Layer:** Keep `Main Agent -> Team Lead` and `Peer Bot -> Subagent` strictly hub-and-spoke (orchestrator-worker) with hard depth caps (max 2–3 layers; strip `spawn` tools at leaf `Subagent`). Allow Peer Bot lateral messaging *only* for bounded cross-layer contract negotiation or competing-hypothesis debugging via a schema-validated task list + mailbox—preventing MAST FC2 "theory of mind" drift and 15× token explosions.
2. **Enforce Typed Handoff Contracts & Filesystem Pass-Through:** Validate `Team Lead -> Peer Bot` work orders (objective, file-ownership list, frozen API contract, expected verification command) and `Subagent -> Peer Bot` returns using strict schemas (`input_type`-style). Write large diffs, test outputs, and research dumps to disk and pass file/line references upward rather than summarizing through 3 tiers ("game of telephone").
3. **Mechanical Sandbox & Worktree Guards (Never Prompt-Only):** Give each parallel `Peer Bot` its own git worktree, `.env`, and port range, backed by runtime path/git-redirect blocks (blocking edits or `git -C` targeting the main checkout) and an upfront file-ownership matrix that forces sequential execution on overlapping files. Never rely on system prompts to keep read-only `Subagent`s (e.g., reviewers) from mutating state—strip write/spawn tools at the runtime sandbox layer.
4. **Milestone Gates + Cross-Family Adversarial Critique + Belief-Delta Stopping:** Pair `Main Agent`/`Team Lead` planning & `Peer Bot` coding with a **cross-family `Validator` Peer/Subagent** running against real builds, end-state tests, and filesystem-routed logs (defeating MAST FM-3.2). Use quality-gate hooks (`TaskCompleted`-style rejection feedback) and a **Belief-Delta ($\Delta\mathcal{B}$) / no-new-contested-claims stopping rule** rather than fixed multi-round debates.
5. **Per-Tier & Per-Step Complexity Routing:** Route `Main Agent` / `Team Lead` planning and cross-family validation to high-reasoning frontier models, routine `Peer Bot` implementation to mid/balanced coding tiers, and leaf `Subagent` exploration/formatting/log-grepping to fast, low-cost models with explicit tool-call budgets.

---

### Sources Visited
- `https://www.anthropic.com/research/multi-agent-research-system`
- `https://code.claude.com/docs/en/sub-agents`
- `https://code.claude.com/docs/en/agent-teams`
- `https://code.claude.com/docs/en/worktrees`
- `https://factory.com/news/missions`
- `https://docs.factory.com/missions/overview`
- `https://docs.factory.com/missions/planning`
- `https://docs.factory.com/missions/reference`
- `https://developers.openai.com/api/docs/guides/agents/orchestration`
- `https://developers.openai.com/api/docs/guides/agents-api/multi-agent`
- `https://openai.github.io/openai-agents-python/handoffs/`
- `https://learn.chatgpt.com/docs/agent-configuration/subagents?surface=app`
- `https://www.langchain.com/blog/choosing-the-right-multi-agent-architecture`
- `https://www.mindstudio.ai/blog/parallel-agentic-development-git-worktrees`
- `https://arxiv.org/abs/2503.13657` & `https://arxiv.org/html/2503.13657v3`
- `https://arxiv.org/html/2611.27839v1`
- `https://icml.cc/virtual/2026/68040`
- `https://aclanthology.org/2025.acl-long.757/`
- `https://aclanthology.org/2026.emnlp-main.1206/`
