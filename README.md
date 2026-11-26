# Bot-Factory Harness

> **Local-First Multi-Agent Orchestration Control Plane & Studio V2**
> Bun · TypeScript · SQLite (WAL + FTS5 + Embeddings) · React 19 + Vite 6 · Three.js · Open BYOS (Native HTTP SSE + ACP stdio + Claude/Codex CLI Stream + 14-Tool MCP Bridge)

**Bot-Factory** is a local-first operating hub for delegating, steering, verifying, and merging work across autonomous AI coding & creative engineering teams on your own machine — without drowning the human operator in raw background tool-call spam.

See the [Studio V2 handoff](./docs/STUDIO_V2_HANDOFF.md) for the latest implementation, verification, and recovered Antigravity research.

---

## 1. Separated Source Repo vs. Runtime Data Plane

Bot-Factory strictly separates version-controlled source code from live mutable runtime data:

- **Source Repository** (for example `C:\Users\<you>\source\repos\bot-factory` or `~/src/bot-factory`): holds only source code (`packages/`, `apps/`), automated tests (`tests/`), documentation, `config.example.json`, `secrets.env.example`, `biome.json`, and CI workflows. Live databases, tokens, secrets, and managed project repos must never live inside the Git repo.
- **Runtime Data Root (`BOT_FACTORY_ROOT`, default `~/bot-factory`)**: holds mutable local state:
  - `system/state.db` (+ `-wal`, `-shm`, `.writer.lock`) — single-writer SQLite state plane
  - `system/config.json` — Open BYOS provider, routing, memory, and guardrail config
  - `system/secrets.env` — local API keys (never echoed back by the API or UI)
  - `system/.daemon-token` — per-hub localhost auth secret
  - `system/staging/` & `system/backups/` — Self-Mod sandbox staging & rollback snapshots
  - `memory/USER.md` & `memory/GLOBAL_MEMORY.md` — global L1 curated Markdown memory
  - `logs/`, `plugins/`, and `projects/<slug>/` (`plans/`, `artifacts/`, `handoffs/`, `repo/`, `worktrees/`, `MEMORY.md`)
- **Isolated Local Dev & Read-Only Diagnostics:**
  - `bun run dev:daemon:isolated` runs the daemon against gitignored `.dev-runtime/` (`BOT_FACTORY_ROOT=.dev-runtime`) and prints an authenticated `http://127.0.0.1:<port>/?token=...` URL.
  - `bun run doctor` performs a zero-mutation preflight inspection of `BOT_FACTORY_ROOT`, config resolution, secret presence (keys present vs. missing only), `.writer.lock` health, temp-copy WAL SQLite schema/epoch/FTS diagnostics, and local CLI availability (`bun`, `git`, `devin`, `opencode`, `claude`, `codex`).

---

## 2. Five-Pillar Architecture

### Pillar 1 — Main Managing Agent (`Meta-Orchestrator`) & Active 3-Layer Memory
- **1 Calm Strategic Channel (`chat:meta`):** The Main Managing Agent converses 1-on-1 with the operator and manages projects, configuration, bots, tasks, and memory through its [executive tools](./AGENTS.md#agent-tool-surfaces). Raw background tool calls, thoughts, and terminal logs are never streamed into `chat:meta`.
- **3-Tier Frozen System Prompt:** Prompt assembly follows `stable -> context (cwd-free first) -> volatile snapshot`, SHA-256 hashed per session to maximize provider prefix-cache hits. Ephemeral per-turn recall is attached to outgoing user turns rather than mutating the system prompt mid-session.
- **Active 3-Layer Memory (`LocalSuperHermesMemory`):**
  - **L1 (Curated Markdown):** `USER.md` (2,000 chars), `GLOBAL_MEMORY.md` (3,000 chars), and project `MEMORY.md` (3,000 chars) with strict char caps and live percentage gauges.
  - **L2 (Temporal Fact Graph):** `memory_facts` and `memory_edges` (`updates`, `extends`, `derives`), `live_memory_facts` SQL view, decay sweeper, and debounced LLM batch dreaming (`createLlmDreamExtractor` routed via `memory_dreaming`, with deterministic heuristic fallback offline).
  - **L3 (Hybrid Retrieval + Auto-Compaction):** Combines dense cosine vector similarity (`memory_embeddings`), SQLite FTS5 (`messages_fts`, `chunks_fts`, `facts_fts` with auto-detach self-healing and `LIKE` fallback), and multi-hop graph traversal, plus automatic in-place session compaction (`compactSessionInPlace`) when tokens reach `autoCompactThresholdTokens`.

### Pillar 2 — Engineering Team Leads (`PM`), Parallel Bots & Depth-1 Subagents
- **Engineering Team Leads (`scope: "project"`):** Provisioned per project with **11 orchestration & read-only repo tools** (`bf_repo_tree`, `bf_repo_read`, `bf_repo_diff`, `bf_task_create_batch`, `bf_task_update`, `bf_bot_spawn`, `bf_task_dispatch`, `bf_bot_message`, `bf_task_verify_trigger`, `bf_debate_resolve`, `bf_report_to_manager`).
- **Parallel Peer Bots (`scope: "peer"`):** Each coding bot operates in its own isolated Git worktree (`worktrees/wt-<shortId>/` on branch `bf/<shortId>`) with workspace-scoped hidden Git checkpoints (`refs/bot-factory/checkpoints/<sha1(scopeKey)>/<turnNum>`) and confirmed `checkpoint.rollback`.
- **Depth-1 Bot-Deployed Subagents (`SubagentManager`):** Peer bots can deploy helper subagents (`scope: "sidekick"`, capped at `maxSubagentsPerBot`; depth > 1 rejected with `subagent_max_depth_exceeded`) in either `readonly` mode (shared parent worktree at `spec` autonomy) or `code` mode (isolated child worktree + `extractAndApplySubagentPatch`), coordinated through the **14-tool MCP Bridge** (`8 core bf_*` + `6 bf_subagent_*` tools).

### Pillar 3 — Continuous Autonomous DAG Loop, Real `IndependentVerifier` & Human-Approved `task.merge`
- **Autonomous DAG Loop (`AutonomyLoop`):** Tracks delegated goals, validates acyclic `dependsOn` task graphs, dispatches unblocked ready tasks up to `maxConcurrentBotsPerProject`, automatically triggers verification on completion, retries failed tasks with verifier findings up to `maxTaskAutoRetries`, and wakes the Team Lead to report milestones/completion back to the Main Agent via `bf_report_to_manager` (`meta.team_report` delivery cards).
- **Real `IndependentVerifier`:** Always executes in a brand-new ephemeral session with zero author history, zero project memory (`verifier:ephemeral`), and cross-family model routing (`excludeProvider`). Runs real `project.verifyChecks` shell commands (process-tree timeout kill + secret scrubbing), inspects real `git diff` + branch commits (empty-diff fail-closed gate), and parses `VERDICT: PASS | FAIL | NEEDS_HUMAN` fail-closed.
- **Debates, Self-Mod Sandbox & `task.merge`:** Conflict Debates cap at `maxDebateRounds` (default `3`) before PM escalation; Self-Mod proposals pass `system/staging/` -> TOCTOU-safe single-read SHA-256 -> secret scan -> verifier gate -> backup -> atomic promote -> rollback; human operators approve `task.merge` (`squash` or `merge_commit` via `mergeBotWorktree` with `preMergeRef`, dirty-base refusal, clean conflict abort, and automatic worktree/branch cleanup).

### Pillar 4 — Open BYOS Runtimes, 4-Tier Autonomy & Localhost Security
- **Open BYOS Runtimes:**
  - `native_http`: SSE streaming + multi-step tool loop supporting `openai_compatible` (Mistral, OpenAI, Ollama, custom OpenAI-compatible servers), `google_gemini`, and `anthropic` with `reasoningEffort` mapping and deterministic offline fallback (`BOT_FACTORY_OFFLINE_MOCK=1` or missing API key).
  - `acp_stdio`: JSON-RPC 2.0 stdio CLIs (`devin acp`, `opencode acp`) with per-session scoped MCP Bridge tokens and process-tree cleanup (Windows `taskkill /T /F`; POSIX detached process-group kill).
  - `cli_stream`: streaming subprocess adapters for `claude` and `codex` CLIs using minimal sanitized env (`buildMinimalCliEnv`, never forwarding `BOT_FACTORY_TOKEN`).
- **Progressive 4-Tier Autonomy & 120s Permissions:** Every turn respects `spec | low | medium | high` autonomy. Hard-deny rules block protected files (`secrets.env`, `.daemon-token`, `state.db`, `~/bot-factory/system`) and destructive commands; escalated actions pause up to `permissionRequestTimeoutSeconds` (`120s`) for human `Allow Once`, `Allow Session`, or `Deny` via `permission.respond`. **High autonomy is intentionally unsafe:** it can bypass provider CLI permission prompts and auto-approve network or host-affecting commands before OS-level sandboxing exists. Use it only in a disposable VM or otherwise isolated machine.
- **Localhost Auth & Transport:** `DaemonServer` (`127.0.0.1`) enforces Host/Origin allowlists and authenticates browser sessions via `/?token=...` -> `HttpOnly; SameSite=Strict` HMAC-signed `bf_session` cookie (or `POST /api/auth/session` from `AuthUnlockGate`), and CLI/MCP callers via `x-bf-token` or `Authorization: Bearer`.

### Pillar 5 — Studio V2 (`apps/web`)
- **Vanta Black and Light Mode:** A black default canvas with a Light toggle, seven Bear Crew role portraits with animated SVG eyes, and self-hosted `@fontsource/inter` and `@fontsource/jetbrains-mono`.
- **Dual-Layer Shell & Navigation:** A compact icon rail, collapsible/resizable drawer, split-chat mode, `Ctrl+K` command palette, WS reconnect banner, and a unified toast stack.
- **Two Worlds + Modular 2-Row In-App Browser + Wave 4 Studios:**
  - **Main Agent (`ChatTab`):** Devin/Codex airy stream with `MarkdownRenderer`, live streaming thoughts/replies, `Memory recalled` indicator, interleaved Delegation / Artifact / Verified Delivery cards (`Review Diff` + one-click `Merge to main`), and Double-Deck `PrecisionComposer` (auto-resetting Diff Tray, `/` slash commands, 4-tier `Autonomy`, live `Model` picker, 4-stop `Effort` slider, Context ring).
  - **Bots Page (`BotsTab` + `BotChatStream`):** Messenger-style Group Chat with role attribution, bot target chips, Pause/Resume/Stop controls, and an animated todo board grouped by bot or status.
  - **Resizable Browser (`apps/web/src/browser/*`):** Right, bottom, floating and fullscreen modes; Markdown editing, image markup, demand-driven 3D previews, code and diff inspection, and a sandboxed loopback web viewer. Review context can be added to the active chat composer.
  - **Escalation Inbox & Studios (`apps/web/src/studio/*`):** `EscalationInbox` (Allow/Deny with live countdown, `session.resolve_unknown` crash recovery, `inboxNotices`), `ProjectModal` (`externalRepoPath`, `verifyChecks`), `BotSpawnModal`, `CheckpointsMergePanel`, `MemoryL1Studio` (L1 editor + L2 fact explorer), and `SettingsView` (BYOS providers, write-only API key management, `Test Connection`, project routing overrides, guardrails).

---

## 3. Repository Structure

```text
bot-factory/
├── .github/workflows/ci.yml        # GitHub Actions CI (typecheck, lint, security scan, build, tests, browser E2E)
├── AGENTS.md                       # AI-Agent engineering guide, invariants, RPC/HTTP map & gotchas
├── HANDOFF.md                      # Phase 1-5 implementation scorecard, verification & next-horizon backlog
├── DESIGN.md                       # Monochrome Ink Light-Mode design system & Smoke/Pearl Thinking Orbs
├── biome.json                      # Biome 2.6.8 lint configuration across packages/, apps/, and tests/
├── config.example.json             # Reference HubConfig (BYOS providers, routing intents, memory, guardrails)
├── secrets.env.example             # Template for ~/bot-factory/system/secrets.env
├── docs/                           # Architecture spec + clean-room research notes
├── packages/
│   └── shared/src/index.ts         # Shared Zod schemas, 30 RpcCommands, WsServerMessage & domain types
├── apps/
│   ├── daemon/src/
│   │   ├── index.ts                # Daemon bootstrap, LLM dreamer, embedder, shutdown lifecycle
│   │   ├── config.ts               # HubConfig loader, secrets.env parser, SecretScrubber, .daemon-token
│   │   ├── cli/                    # devIsolated.ts (.dev-runtime) & doctor.ts (read-only preflight)
│   │   ├── core/commandCore.ts     # 1-TX Command -> Event -> Outbox worker (200ms poll, 3 retries)
│   │   ├── db/database.ts          # Single-writer SQLite (22 tables, 1 view, 3 FTS5 tables, WAL)
│   │   ├── git/worktrees.ts        # Worktrees, subagent patches, hidden checkpoints, squash/merge_commit
│   │   ├── mcp/mcpBridge.ts        # Standalone stdio JSON-RPC 2.0 MCP server (14 bf_* tools)
│   │   ├── memory/memoryEngine.ts  # L1 Markdown, 3-tier frozen prompts, L2 graph/dreaming, L3 hybrid search
│   │   ├── orchestration/          # engine.ts, autonomyLoop.ts, subagentManager.ts, agentTools.ts
│   │   ├── phase3/                 # verifier.ts (IndependentVerifier) & selfMod.ts (Sandbox staging)
│   │   ├── rpc/server.ts           # 127.0.0.1 HTTP/WS server, session cookie/token auth, safe file/diff APIs
│   │   └── runtimes/               # nativeHttpRuntime, acpSubprocessRuntime, cliStreamRuntime, router
│   └── web/src/
│       ├── App.tsx                 # Dual-layer Studio shell, auth gate, Ctrl+K palette, WS orchestration
│       ├── main.tsx                # Self-hosted Fontsource Inter & JetBrains Mono entry
│       ├── client/useBotFactory.ts # Ref-counted WS pub/sub, heartbeat, streaming buffers, HTTP helpers
│       ├── chat/ChatTab.tsx        # Main Agent stream, delivery cards, composer integration
│       ├── bots/                   # BotsTab.tsx & BotChatStream.tsx (Grok-Bot multi-side chat + Kanban)
│       ├── browser/                # Modular 2-row 6-viewer In-App Browser (lazy Three.js Model3DViewer)
│       ├── studio/                 # EscalationInbox, ProjectModal, BotSpawnModal, CheckpointsMerge, MemoryL1, Settings
│       ├── phase3/Phase3Panels.tsx # Conflict Debates & Self-Mod Sandbox panels
│       ├── components/             # MarkdownRenderer, PrecisionComposer, ReasoningEffortSlider, Avatars, Orbs, Icons
│       └── styles/                 # tokens.css & app.css (Phase 3.3 Light Mode)
└── tests/                          # Bun integration, security, BYOS, autonomy & Playwright UI E2E tests
```

---

## 4. Quick Start & Commands

### Prerequisites
- [Bun](https://bun.sh/) `v1.4+`
- `git` `2.40+`
- Optional local agent CLIs: `devin`, `opencode`, `claude`, `codex`
- Optional for local headless browser smoke tests: Python 3 `playwright` with Chromium installed (CI runs this in a dedicated job)

### Install, Check & Build
```bash
bun install
bun run scan:security  # Socket supply-chain/advisory scan of bun.lock
bun run check          # Runs: typecheck && lint (Biome) && build:web && test (bun test tests)
bun run doctor         # Read-only preflight check of BOT_FACTORY_ROOT, secrets, lock, DB & CLIs
```

### Configure Live Model Keys (Optional)
Without API keys (or with `BOT_FACTORY_OFFLINE_MOCK=1`), the daemon runs deterministically in offline simulation mode so you can exercise the full Studio UI, worktrees, 6-viewer browser, debates, verifier, and self-mod locally.

For live models, copy `secrets.env.example` to `~/bot-factory/system/secrets.env` (or configure keys write-only inside **Settings → API Keys** in the Studio UI).

### Run Locally
```bash
# 1. Isolated daemon against ./.dev-runtime (recommended for development; prints tokenized URL)
bun run build:web
bun run dev:daemon:isolated

# 2. Optional Vite HMR frontend alongside a running daemon (:4310 -> :5173 auto-proxied with token)
bun run dev:web

# 3. Production single-port hub using default ~/bot-factory root (http://127.0.0.1:4310)
bun run build:web
bun run start
```

---

## 5. For AI Agents Working in This Repository

Start by reading **[`AGENTS.md`](./AGENTS.md)**, **[`HANDOFF.md`](./HANDOFF.md)**, and **[`DESIGN.md`](./DESIGN.md)**. They document every non-negotiable security and concurrency invariant, protocol contract, and verified workflow.
