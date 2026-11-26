# AGENTS.md — AI Agent Engineering Guide for Bot-Factory

Read this file **before** editing code in this repository. It documents the foundational architecture, non-negotiable invariants, entry points, verification commands, and known constraints. Start with the **[Studio V2 handoff](./docs/STUDIO_V2_HANDOFF.md)** for the current UI, schema v3, and research backlog; Phase 5 descriptions here are the baseline.

See also:
- **[`HANDOFF.md`](./HANDOFF.md)** — Phase 1–5 delivery scorecard, verified checks, and remaining roadmap.
- **[`DESIGN.md`](./DESIGN.md)** — Historical Phase 3.3 Light-Mode design reference; use the Studio V2 handoff and `tokens.css` for current UI decisions.
- **[`docs/ARCHITECTURE_AND_UI_SPEC.md`](./docs/ARCHITECTURE_AND_UI_SPEC.md)** and **[`docs/research/README.md`](./docs/research/README.md)** — Original clean-room design specs.

---

## 1. Monorepo Architecture & Entry Points

Bot-Factory is a Bun + TypeScript monorepo (`packages/*`, `apps/*`) with strict separation between **source code** and **runtime state (`BOT_FACTORY_ROOT`, default `~/bot-factory`)**.

| Workspace | Purpose | Key Entry Points |
|---|---|---|
| `packages/shared` | Single source of truth for Zod contracts (`HubConfigSchema`, `RpcCommandSchema`, `WsClientMessage`, `WsServerMessage`, `SubscriptionTopic`, entity & anchor schemas) | [`packages/shared/src/index.ts`](./packages/shared/src/index.ts) |
| `apps/daemon` | Local-only Control Plane (`127.0.0.1`), Config/Secrets, Single-Writer SQLite (`bun:sqlite` WAL + FTS5 + Embeddings, schema v2), Outbox Worker, Git Worktrees/Subagent Patches/Merge/Checkpoints, 3-Layer Memory Engine, Autonomy Loop, Subagent Manager, Open BYOS Runtimes (`native_http`, `acp_stdio`, `cli_stream`), 14-Tool MCP Bridge, Independent Verifier & Self-Mod Sandbox | [`apps/daemon/src/index.ts`](./apps/daemon/src/index.ts)<br>[`apps/daemon/src/config.ts`](./apps/daemon/src/config.ts)<br>[`apps/daemon/src/cli/devIsolated.ts`](./apps/daemon/src/cli/devIsolated.ts)<br>[`apps/daemon/src/cli/doctor.ts`](./apps/daemon/src/cli/doctor.ts)<br>[`apps/daemon/src/core/commandCore.ts`](./apps/daemon/src/core/commandCore.ts)<br>[`apps/daemon/src/db/database.ts`](./apps/daemon/src/db/database.ts)<br>[`apps/daemon/src/rpc/server.ts`](./apps/daemon/src/rpc/server.ts)<br>[`apps/daemon/src/git/worktrees.ts`](./apps/daemon/src/git/worktrees.ts)<br>[`apps/daemon/src/memory/memoryEngine.ts`](./apps/daemon/src/memory/memoryEngine.ts)<br>[`apps/daemon/src/orchestration/engine.ts`](./apps/daemon/src/orchestration/engine.ts)<br>[`apps/daemon/src/orchestration/agentTools.ts`](./apps/daemon/src/orchestration/agentTools.ts)<br>[`apps/daemon/src/orchestration/autonomyLoop.ts`](./apps/daemon/src/orchestration/autonomyLoop.ts)<br>[`apps/daemon/src/orchestration/subagentManager.ts`](./apps/daemon/src/orchestration/subagentManager.ts)<br>[`apps/daemon/src/mcp/mcpBridge.ts`](./apps/daemon/src/mcp/mcpBridge.ts)<br>[`apps/daemon/src/runtimes/router.ts`](./apps/daemon/src/runtimes/router.ts)<br>[`apps/daemon/src/runtimes/nativeHttpRuntime.ts`](./apps/daemon/src/runtimes/nativeHttpRuntime.ts)<br>[`apps/daemon/src/runtimes/acpSubprocessRuntime.ts`](./apps/daemon/src/runtimes/acpSubprocessRuntime.ts)<br>[`apps/daemon/src/runtimes/cliStreamRuntime.ts`](./apps/daemon/src/runtimes/cliStreamRuntime.ts)<br>[`apps/daemon/src/phase3/verifier.ts`](./apps/daemon/src/phase3/verifier.ts)<br>[`apps/daemon/src/phase3/selfMod.ts`](./apps/daemon/src/phase3/selfMod.ts) |
| `apps/web` | React 19 + Vite 6 + Three.js Light-Mode Studio UI (Dual-Layer Shell, Devin/Codex Main Agent, Grok-Bot Multi-Side Group Chat, Modular 2-Row 6-Viewer Browser, Escalation Inbox, Wave 4 Studios) | [`apps/web/src/App.tsx`](./apps/web/src/App.tsx)<br>[`apps/web/src/main.tsx`](./apps/web/src/main.tsx)<br>[`apps/web/src/client/useBotFactory.ts`](./apps/web/src/client/useBotFactory.ts)<br>[`apps/web/src/chat/ChatTab.tsx`](./apps/web/src/chat/ChatTab.tsx)<br>[`apps/web/src/bots/BotsTab.tsx`](./apps/web/src/bots/BotsTab.tsx)<br>[`apps/web/src/bots/BotChatStream.tsx`](./apps/web/src/bots/BotChatStream.tsx)<br>[`apps/web/src/browser/InAppBrowser.tsx`](./apps/web/src/browser/InAppBrowser.tsx)<br>[`apps/web/src/browser/Model3DViewer.tsx`](./apps/web/src/browser/Model3DViewer.tsx)<br>[`apps/web/src/studio/EscalationInbox.tsx`](./apps/web/src/studio/EscalationInbox.tsx)<br>[`apps/web/src/studio/ProjectModal.tsx`](./apps/web/src/studio/ProjectModal.tsx)<br>[`apps/web/src/studio/BotSpawnModal.tsx`](./apps/web/src/studio/BotSpawnModal.tsx)<br>[`apps/web/src/studio/CheckpointsMergePanel.tsx`](./apps/web/src/studio/CheckpointsMergePanel.tsx)<br>[`apps/web/src/studio/MemoryL1Studio.tsx`](./apps/web/src/studio/MemoryL1Studio.tsx)<br>[`apps/web/src/studio/SettingsView.tsx`](./apps/web/src/studio/SettingsView.tsx)<br>[`apps/web/src/phase3/Phase3Panels.tsx`](./apps/web/src/phase3/Phase3Panels.tsx)<br>[`apps/web/src/components/PrecisionComposer.tsx`](./apps/web/src/components/PrecisionComposer.tsx)<br>[`apps/web/src/components/MarkdownRenderer.tsx`](./apps/web/src/components/MarkdownRenderer.tsx)<br>[`apps/web/src/styles/tokens.css`](./apps/web/src/styles/tokens.css)<br>[`apps/web/src/styles/app.css`](./apps/web/src/styles/app.css) |
| `tests` | Bun integration, security, BYOS, memory/ACP/MCP, autonomous DAG/subagents/merge & Playwright Chromium UI E2E suites | [`tests/harness_e2e.test.ts`](./tests/harness_e2e.test.ts)<br>[`tests/browser_api_security.test.ts`](./tests/browser_api_security.test.ts)<br>[`tests/memory_acp_mcp.test.ts`](./tests/memory_acp_mcp.test.ts)<br>[`tests/phase1_security_parallel_recovery.test.ts`](./tests/phase1_security_parallel_recovery.test.ts)<br>[`tests/phase2_byos_streaming_memory.test.ts`](./tests/phase2_byos_streaming_memory.test.ts)<br>[`tests/phase3_debates_verifier_selfmod.test.ts`](./tests/phase3_debates_verifier_selfmod.test.ts)<br>[`tests/phase3_autonomous_subagents_merge.test.ts`](./tests/phase3_autonomous_subagents_merge.test.ts)<br>[`tests/ui_e2e.test.ts`](./tests/ui_e2e.test.ts) + [`tests/ui_e2e_playwright.py`](./tests/ui_e2e_playwright.py) |

---

## 2. Non-Negotiable Architecture & Security Invariants

**NEVER weaken or bypass these invariants:**

1. **Single-Writer SQLite + `runtime_epoch` (`apps/daemon/src/db/database.ts`):**
   - Only the local daemon writes `state.db` (exclusive PID lockfile `${dbPath}.writer.lock` with Windows PID-reuse validation + `assertWritable()` epoch check on every write). Never let the UI, tests against live user data, `doctor.ts`, or MCP bridge write `state.db` directly.
2. **1-TX Command -> Event -> Outbox Atomicity (`apps/daemon/src/core/commandCore.ts`):**
   - Every `RpcCommand` checks `command_receipts` before any pre-commit I/O and commits `{events, projections, command_receipts, outbox_effects}` in one atomic SQLite transaction with **zero network or filesystem I/O inside the transaction**.
3. **Never Blindly Replay Crashed Turns:**
   - `recoverAfterRestart()` transitions prior-epoch `started` admissions to `unknown` and prior-epoch effects to `retired`, blocking FIFO admissions until `session.resolve_unknown` confirms `expectedGeneration`.
4. **3-Tier Frozen System Prompt & CWD-Free Prefix (`apps/daemon/src/memory/memoryEngine.ts`):**
   - Assembly order is `stable -> context (cwd-free first) -> volatile snapshot`, frozen and SHA-256 hashed per session. Never mutate the system prompt mid-session with dynamic timestamps or recall; attach ephemeral hybrid recall to outgoing turns only.
5. **FTS5 Is Derived & Detachable (`apps/daemon/src/db/database.ts`):**
   - Canonical writes must never fail due to FTS5 corruption. On FTS errors, detach FTS triggers, set `fts_stale = 1`, and fall back to `LIKE`.
6. **Workspace-Scoped Hidden Git Checkpoints & Merge Guards (`apps/daemon/src/git/worktrees.ts`):**
   - Checkpoint scope keys MUST include `(agentId, normalizedCwd)` (`root:{agentId}:{cwd}`), refusing cross-worktree restores.
   - `mergeBotWorktree` must reject dirty base repos (`base_repo_dirty`), record `preMergeRef`, abort cleanly on `merge_conflict`, and clean worktrees/branches only after closing live agent sessions.
7. **Depth-1 Subagent Cap & Windows Worktree Lock Safety (`apps/daemon/src/orchestration/subagentManager.ts`):**
   - Only `peer` bots (`depth < 1`) may spawn `sidekick` subagents (`subagent_max_depth_exceeded` otherwise, bounded by `maxSubagentsPerBot`).
   - On `applySubagentPatch` (and `cleanupSingleSubagent`), ALWAYS revoke MCP tokens and `abortAndCloseAgentSession(..., "hard_stop")` **before** removing the child worktree (`skipCleanup: true` -> close session -> `cleanupSubagentWorktree`), otherwise Windows holds open directory handles and fails `git worktree remove`.
8. **Strict Path Containment, Localhost Auth & Secret Hygiene (`apps/daemon/src/rpc/server.ts`, `config.ts`, `agentTools.ts`):**
   - Daemon binds strictly to `127.0.0.1` (`HubConfigSchema.hub.host = "127.0.0.1"`) with Origin/Host validation and HMAC-signed `bf_session` cookie / `x-bf-token` auth.
   - Artifact reads (`/api/projects/:id/artifact`) are restricted via `isPathStrictlyWithinRoot` (`realpathSync` symlink containment) to `plans/`, `artifacts/`, and `handoffs/`.
   - Repo reads (`/files`, `/file`, `/diff`, `bf_repo_tree`, `bf_repo_read`) must block `.git` (both dirs and worktree `.git` pointer files), `.env*`, `secrets.env`, `.daemon-token`, `config.json`, `.pem`, `.key`, `*.db*`, binaries, and files `>512 KB`, and scrub all text through `SecretScrubber`.
   - `WebViewer.tsx` MUST remain loopback-only with self-embed origin/port blocking and `sandbox="allow-scripts allow-forms"` (NO `allow-same-origin`).
   - Write-only Secrets API (`/api/secrets`) must NEVER return plaintext secret values.
   - Subprocesses (`cliStreamRuntime.ts`, `acpSubprocessRuntime.ts`, `verifier.ts`, `probeCliVersion`) must NEVER inherit `BOT_FACTORY_TOKEN` (except scoped per-session `bfmcp_*` tokens passed explicitly to `mcpBridge.ts`).
9. **Two-Worlds Anti-Log-Spam Isolation (`apps/daemon/src/orchestration/engine.ts`):**
   - `chat:meta` MUST NEVER receive raw `tool_call`, `thought`, `plan`, or `terminal` telemetry from background bots or subagents.
10. **Cross-Family Independent Verification & Self-Mod Integrity (`apps/daemon/src/phase3/`):**
    - `IndependentVerifier` runs in a fresh ephemeral session (`verifier:ephemeral`), zero author history, zero project memory, cross-family model selection (`excludeProvider`), real `verifyChecks` execution, empty-diff fail-closed gating, and fail-closed `VERDICT` parsing.
    - Self-Mod promotion verifies Open BYOS config schema, blocks embedded plaintext secrets, locks immutable hub keys (`rootDir`, `dbPath`, `secretsEnvPath`, `defaultProjectsDir`), re-verifies SHA-256 on a single read (TOCTOU-safe), and creates backups before atomic promotion.
11. **Windows Process-Tree Safety (`acpSubprocessRuntime.ts`, `cliStreamRuntime.ts`, `verifier.ts`):**
    - Flush pending `session/request_permission` requests with `{ outcome: "cancelled" }` on abort/disconnect.
    - Terminate subprocess trees on Windows with `taskkill /PID <pid> /T /F`.
12. **Design System Discipline (`DESIGN.md` & `apps/web/src/styles/tokens.css`):**
    - Support both Vanta Black (default) and Light Mode with shared tokens. Preserve the Bear Crew assets and SVG eye layer. No runtime `<style>` tag injection in JSX, no external CDNs, no emojis as UI icons.

---

## 3. Verification & Development Commands

> **Windows PowerShell 5.1 Note:** Chain commands with `;` (not `&&`), checking `$LASTEXITCODE` between steps if needed.

```powershell
# 1. Typecheck entire monorepo
bun run typecheck

# 2. Lint packages/, apps/, and tests/ with Biome (biome.json)
bun run lint

# 3. Build Studio UI into apps/web/dist (required before Playwright E2E on clean checkout)
bun run build:web

# 4. Run full Bun test suite (set BOT_FACTORY_SKIP_PLAYWRIGHT=1 if Chromium is absent)
bun test tests

# 5. Full check pipeline (typecheck + lint + build:web + tests)
bun run check

# 6. Dependency supply-chain/advisory scan
bun run scan:security

# 7. Read-only preflight diagnostics (never modifies state.db or .writer.lock)
bun run doctor
```

### Running an Isolated Daemon for Live Testing (Never Pollute `~/bot-factory`)
```powershell
bun run build:web
bun run dev:daemon:isolated
```
`dev:daemon:isolated` sets `BOT_FACTORY_ROOT` to `./.dev-runtime` (gitignored) and logs `http://127.0.0.1:4310/?token=<token>`. To run Vite HMR alongside it (`:5173`), run `bun run dev:web` in a second terminal (`vite.config.ts` automatically reads `.daemon-token` and injects `x-bf-token` on `/api` and `/ws` proxy requests).

---

## 4. Protocol & Tool Quick Reference

### `RpcCommandSchema` (`packages/shared/src/index.ts`)
- **Chat & Steer:** `chat.send`, `steer.submit`
- **Projects & Bots:** `project.create`, `project.archive`, `bot.spawn`, `bot.pause`, `bot.stop`, `bot.resume`, `bot.update_model`, `bot.message`, `permission.respond`, `session.resolve_unknown`
- **Tasks, Checkpoints & Merge:** `task.create`, `task.dispatch`, `task.verify`, `task.merge`, `checkpoint.list`, `checkpoint.rollback`
- **Annotations & Inbox:** `annotation.create`, `annotation.resolve`, `inbox.dismiss`
- **Phase-3 Debates & Self-Mod:** `debate.open`, `debate.post`, `debate.resolve`, `selfmod.propose`, `selfmod.verify`, `selfmod.promote`, `selfmod.rollback`
- **Settings, Routing & Memory:** `config.update`, `routing.set_override`, `memory.l1.get`, `memory.l1.update`

### HTTP Endpoints (`apps/daemon/src/rpc/server.ts`)
- `GET /?token=<token>` — exchanges daemon token for `HttpOnly; SameSite=Strict` `bf_session` cookie and redirects to `/`
- `GET /api/auth/status`, `POST /api/auth/session` — auth status check & token-to-cookie login
- `GET /api/health`, `GET /api/snapshot`, `POST /api/command`
- `GET /api/config`, `GET /api/secrets`, `POST /api/secrets`, `DELETE /api/secrets/:key`, `POST /api/secrets/test`
- `GET /api/memory/l1`, `GET /api/memory/facts`
- `POST /api/mcp/:toolName` — scoped `bfmcp_*` / master token MCP dispatch
- `GET /api/projects/:id/artifact?path=` — `plans|artifacts|handoffs` read (sandbox CSP)
- `PUT /api/projects/:id/artifact?path=` — authenticated writes to the same roots; only allowlisted UTF-8 docs and base64 image formats, with size caps
- `GET /api/projects/:id/files`, `GET /api/projects/:id/file?path=`, `GET /api/projects/:id/diff` — worktree-aware (`?agentId=`) safe read-only browser APIs
- `GET /ws` — typed WebSocket RPC + ref-counted pub/sub (`ping`/`pong`)

### Agent Tool Surfaces
- **Main Manager (`17` tools in `agentTools.ts`):** `bf_projects_list`, `bf_project_create`, `bf_team_delegate`, `bf_team_status`, `bf_config_get`, `bf_config_update`, `bf_bot_spawn`, `bf_bot_update_model`, `bf_bot_message`, `bf_task_list`, `bf_task_create`, `bf_task_update`, `bf_task_dispatch`, `bf_memory_search`, `bf_memory_remember`, `bf_memory_update_l1`, `bf_memory_forget`.
- **Team Lead (`11` tools in `agentTools.ts`):** `bf_repo_tree`, `bf_repo_read`, `bf_repo_diff`, `bf_task_create_batch`, `bf_task_update`, `bf_bot_spawn`, `bf_task_dispatch`, `bf_bot_message`, `bf_task_verify_trigger`, `bf_debate_resolve`, `bf_report_to_manager`.
- **MCP Bridge (`14` tools in `mcpBridge.ts`):** `bf_task_list`, `bf_task_claim`, `bf_task_update`, `bf_handoff_write`, `bf_memory_search`, `bf_fix_tasks_list`, `bf_fix_task_resolve`, `bf_debate_post`, `bf_subagent_spawn`, `bf_subagent_status`, `bf_subagent_wait`, `bf_subagent_message`, `bf_subagent_kill`, `bf_subagent_apply_patch`.

### WebSocket Subscription Topics (`packages/shared/src/index.ts`)
`global:status` · `global:selfmod` · `chat:meta` · `project:{id}:board` · `project:{id}:previews` · `project:{id}:debates` · `bot:{id}:timeline`

---

## 5. Known Constraints & Engineering Traps

1. **`biome.json` keeps `formatter.enabled: false` and `assist.enabled: false` intentionally.** Existing repository files mix CRLF/LF line endings and deliberate multi-line formatting; `bun run lint` (`bun x biome check packages apps tests`) runs recommended TS/TSX/CSS lint rules without failing on line-ending diffs.
2. **Playwright E2E requires built `apps/web/dist/index.html` and Python 3 Playwright Chromium.** `bun run check` builds the web UI before tests. Set `BOT_FACTORY_SKIP_PLAYWRIGHT=1` when Chromium is intentionally unavailable.
3. **Git `status --porcelain` leading space trap.** `runGitSync` trims stdout, so `" M file"` becomes `"M file"`. Always keep the regex parser in `parsePorcelainStatus` (`worktrees.ts`).
4. **Git worktree `.git` is a file, not a directory.** Always filter `.git` entries on both files and directories in repo listing/tree walkers (`worktrees.ts`, `agentTools.ts`).
5. **SQLite schema v3 + FTS triggers.** `database.ts` idempotently migrates v1 schema and timestamps, then adds v3 message attribution (`sender_agent_id`, `sender_role`). Never bypass `StateDatabase` migrations.
6. **Three.js `Model3DViewer` renders on demand.** Do not reintroduce a continuous 60fps `requestAnimationFrame` loop; schedule frames via `controls.addEventListener("change", ...)` / `ResizeObserver` / pointer events so idle GPU usage stays 0%.
