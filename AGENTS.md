# AGENTS.md — AI Agent Engineering Guide for Bot-Factory

Read this file **before** editing code in this repository. It gives you the exact architecture, non-negotiable invariants, file map, verification commands, and known traps.

For the prioritized list of missing features and bugs to build next, also read **[`HANDOFF.md`](./HANDOFF.md)**.
For visual/CSS rules, read **[`DESIGN.md`](./DESIGN.md)**.
For original clean-room architecture patterns, read **[`docs/research/README.md`](./docs/research/README.md)**.

---

## 1. Monorepo Architecture & Entry Points

Bot-Factory is a Bun + TypeScript monorepo with three workspaces:

| Workspace | Purpose | Key Files |
|---|---|---|
| `packages/shared` | Single source of truth for Zod contracts (`RpcCommandSchema`, `WsClientMessage`, `WsServerMessage`, `HubConfigSchema`, entity types, subscription topics) | [`packages/shared/src/index.ts`](./packages/shared/src/index.ts) |
| `apps/daemon` | Local-only Control Plane (`127.0.0.1`), Single-Writer SQLite (`bun:sqlite` WAL + FTS5), Outbox Worker, Git Worktrees & Hidden Checkpoints, Memory Engine, Native HTTP + ACP Runtimes, MCP Bridge, Phase-3 Verifier & Self-Mod | [`apps/daemon/src/index.ts`](./apps/daemon/src/index.ts)<br>[`apps/daemon/src/rpc/server.ts`](./apps/daemon/src/rpc/server.ts)<br>[`apps/daemon/src/orchestration/engine.ts`](./apps/daemon/src/orchestration/engine.ts)<br>[`apps/daemon/src/core/commandCore.ts`](./apps/daemon/src/core/commandCore.ts)<br>[`apps/daemon/src/db/database.ts`](./apps/daemon/src/db/database.ts)<br>[`apps/daemon/src/git/worktrees.ts`](./apps/daemon/src/git/worktrees.ts)<br>[`apps/daemon/src/memory/memoryEngine.ts`](./apps/daemon/src/memory/memoryEngine.ts)<br>[`apps/daemon/src/runtimes/nativeHttpRuntime.ts`](./apps/daemon/src/runtimes/nativeHttpRuntime.ts)<br>[`apps/daemon/src/runtimes/acpSubprocessRuntime.ts`](./apps/daemon/src/runtimes/acpSubprocessRuntime.ts)<br>[`apps/daemon/src/runtimes/router.ts`](./apps/daemon/src/runtimes/router.ts)<br>[`apps/daemon/src/mcp/mcpBridge.ts`](./apps/daemon/src/mcp/mcpBridge.ts)<br>[`apps/daemon/src/phase3/verifier.ts`](./apps/daemon/src/phase3/verifier.ts)<br>[`apps/daemon/src/phase3/selfMod.ts`](./apps/daemon/src/phase3/selfMod.ts) |
| `apps/web` | React 19 + Vite 6 + Three.js Light-Mode Studio UI | [`apps/web/src/App.tsx`](./apps/web/src/App.tsx)<br>[`apps/web/src/client/useBotFactory.ts`](./apps/web/src/client/useBotFactory.ts)<br>[`apps/web/src/chat/ChatTab.tsx`](./apps/web/src/chat/ChatTab.tsx)<br>[`apps/web/src/bots/BotsTab.tsx`](./apps/web/src/bots/BotsTab.tsx)<br>[`apps/web/src/bots/BotChatStream.tsx`](./apps/web/src/bots/BotChatStream.tsx)<br>[`apps/web/src/browser/InAppBrowser.tsx`](./apps/web/src/browser/InAppBrowser.tsx)<br>[`apps/web/src/phase3/Phase3Panels.tsx`](./apps/web/src/phase3/Phase3Panels.tsx)<br>[`apps/web/src/components/PrecisionComposer.tsx`](./apps/web/src/components/PrecisionComposer.tsx)<br>[`apps/web/src/components/ReasoningEffortSlider.tsx`](./apps/web/src/components/ReasoningEffortSlider.tsx)<br>[`apps/web/src/components/BotAvatars.tsx`](./apps/web/src/components/BotAvatars.tsx)<br>[`apps/web/src/components/BotFactoryIcons.tsx`](./apps/web/src/components/BotFactoryIcons.tsx)<br>[`apps/web/src/components/BotThinkingOrb.tsx`](./apps/web/src/components/BotThinkingOrb.tsx)<br>[`apps/web/src/styles/tokens.css`](./apps/web/src/styles/tokens.css)<br>[`apps/web/src/styles/app.css`](./apps/web/src/styles/app.css) |
| `tests` | End-to-end, unit, memory/ACP/MCP, Phase-3 & browser-API security test suites | [`tests/harness_e2e.test.ts`](./tests/harness_e2e.test.ts)<br>[`tests/memory_acp_mcp.test.ts`](./tests/memory_acp_mcp.test.ts)<br>[`tests/phase3_debates_verifier_selfmod.test.ts`](./tests/phase3_debates_verifier_selfmod.test.ts)<br>[`tests/browser_api_security.test.ts`](./tests/browser_api_security.test.ts) |

---

## 2. Non-Negotiable Architecture & Security Invariants

**NEVER break these invariants when adding features or fixing bugs:**

1. **Single-Writer SQLite + `runtime_epoch` (`apps/daemon/src/db/database.ts`)**
   - Only the daemon writes `state.db` (exclusive PID lockfile + `assertWritable()` epoch guard on every write). Never let the UI, CLI, or MCP bridge open `state.db` directly for writes.
2. **1-TX Command → Event → Outbox Atomicity (`apps/daemon/src/core/commandCore.ts`)**
   - Every RPC command commits `{events, projections, command_receipt, outbox_effects}` in one SQLite transaction with **zero network or filesystem I/O inside the transaction**. All side effects (model calls, ACP turns, Git checkpoints) run asynchronously via the Outbox worker.
3. **Never Blindly Replay Crashed Turns**
   - On restart (`recoverAfterRestart`), `started` session admissions become `unknown`, prior-epoch effects become `retired`, and FIFO blocks until `session.resolve_unknown` with matching `executionGeneration`.
4. **3-Tier Frozen System Prompt & CWD-Free Prefix Ordering (`apps/daemon/src/memory/memoryEngine.ts`)**
   - Prompt assembly order is `stable → context (cwd-free first!) → volatile`. Freeze and hash once per session. Never inject timestamps, live task counts, or dynamic recall into the system prompt mid-session — attach ephemeral per-turn recall only to the outgoing user turn.
5. **FTS5 Is Derived & Detachable (`apps/daemon/src/db/database.ts`)**
   - Canonical writes must never fail due to FTS5 corruption. On FTS errors, detach triggers, set `fts_stale`, and fall back to `LIKE`. Never run `INSERT INTO ... VALUES('rebuild')` inside a live write path.
6. **Workspace-Scoped Hidden Git Checkpoints (`apps/daemon/src/git/worktrees.ts`)**
   - Checkpoint scope keys MUST include `(agentId, normalizedCwd)` (`root:{agentId}:{cwd}`). Always refuse cross-worktree restores.
7. **Strict Path Containment & Secret Hygiene (`apps/daemon/src/rpc/server.ts`, `worktrees.ts`, `memory/secretScrubber.ts`)**
   - All artifact reads (`/api/projects/:id/artifact`) are restricted to `plans/`, `artifacts/`, and `handoffs/` via `realpath`-checked boundary validation.
   - All repo reads (`/files`, `/file`, `/diff`) MUST enforce `isPathStrictlyWithinRoot`, block `.git` (both directories AND worktree `.git` pointer files!), `.env*`, `secrets.env`, `.pem`, `.key`, binary files, and oversized files (`>512 KB`), and pass text through `SecretScrubber`.
   - Web previews inside `InAppBrowser.tsx` MUST remain **loopback-only** (`127.0.0.1`, `localhost`, `[::1]`) inside a sandboxed `<iframe>`.
   - HTTP/WS server MUST remain bound to `127.0.0.1` with localhost-only Origin allowlist.
8. **Two-Worlds Anti-Log-Spam Isolation (`apps/daemon/src/orchestration/engine.ts`)**
   - `chat:meta` MUST NEVER receive raw `tool_call`, `thought`, `plan`, or `terminal` chunks from background bots. Dense telemetry belongs strictly to `bot:<id>:timeline`.
9. **Cross-Family Independent Verification & Self-Mod Integrity (`apps/daemon/src/phase3/`)**
   - `IndependentVerifier` MUST run in a fresh ephemeral session with zero author conversation history, zero L1/project memory, cross-family provider selection (`excludeProvider`), and fail-closed verdict parsing.
   - Self-Mod promotion MUST re-verify SHA-256 on a single read (TOCTOU-safe), keep immutable hub keys locked, and always snapshot a backup before atomic promotion.
10. **Windows Process-Tree Safety (`apps/daemon/src/runtimes/acpSubprocessRuntime.ts`)**
    - Always flush pending `session/request_permission` requests with `{ outcome: "cancelled" }` on abort/disconnect (otherwise ACP subprocesses hang).
    - On Windows Hard-Stop, use process-tree termination (`taskkill /PID <pid> /T /F`) so child processes are not orphaned.
11. **Design System Discipline (`DESIGN.md` & `apps/web/src/styles/tokens.css`)**
    - **Light Mode only** (`#FFFFFF`, `#FAFAFA`, `#F5F5F5`, `#171717`, `#525252`, `#8A8A8A`, `1px #EBEBEB`).
    - Warm **Burnt-Orange (`#D95D22`)** is reserved strictly for Human chat/steer bubbles, the 4-stop `Aufwand` slider, and the Low-Poly Flat-Shaded Orange Beaver avatars.
    - **Zero** purple/indigo gradients, **zero** neon glows, **zero** emojis as UI icons.

---

## 3. Verification & Dev Commands

> **Windows PowerShell 5.1 Note:** Chain commands with `;` (not `&&`), checking `$LASTEXITCODE` between steps if needed.

```powershell
# 1. Typecheck entire monorepo (must exit 0)
bun run typecheck

# 2. Run all 25 integration, memory/ACP/MCP, Phase-3 & browser-API security tests
bun test tests

# 3. Production Vite build (outputs to apps/web/dist, served automatically by daemon)
bun run build:web
```

### Running an Isolated Daemon for Live UI / Browser Testing
Always test against a fresh temporary `rootDir` so you don't pollute `~/bot-factory/system/state.db`:

```powershell
$tmp = Join-Path $env:TEMP ('bf-dev-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
bun -e "import { startBotFactoryDaemon } from './apps/daemon/src/index.ts'; const app = startBotFactoryDaemon({ rootDir: process.argv[1], port: 4318 }); console.log('READY', app.url); await new Promise(() => {});" $tmp
```

Then open `http://127.0.0.1:4318` (make sure `bun run build:web` ran first!).

---

## 4. Protocol Quick Reference

### RPC Commands (`RpcCommandSchema` in `packages/shared/src/index.ts:411-551`)
- **Chat & Steer:** `chat.send`, `steer.submit`
- **Projects & Bots:** `project.create`, `bot.spawn`, `bot.pause`, `bot.stop`, `session.resolve_unknown`
- **Tasks & Verification:** `task.create`, `task.dispatch`, `task.verify`
- **Annotations:** `annotation.create`, `annotation.resolve`
- **Phase-3 Debates:** `debate.open`, `debate.post`, `debate.resolve`
- **Phase-3 Self-Mod:** `selfmod.propose`, `selfmod.verify`, `selfmod.promote`, `selfmod.rollback`

### HTTP Endpoints (`apps/daemon/src/rpc/server.ts`)
- `GET /api/health` — daemon epoch, `ftsStale`, quiet projection
- `GET /api/snapshot` — global status snapshot
- `POST /api/command` — HTTP fallback for `RpcCommandSchema`
- `POST /api/mcp/:tool` — `x-bf-token`-authenticated MCP bridge dispatch
- `GET /api/projects/:id/artifact?path=` — scoped read for `plans|artifacts|handoffs`
- `GET /api/projects/:id/files` — safe repo file listing (respects `?agentId=` worktree)
- `GET /api/projects/:id/file?path=` — safe UTF-8 file read (512 KB cap, binary/sensitive blocked, scrubbed)
- `GET /api/projects/:id/diff` — safe workspace `git diff` + untracked synthetic patches (scrubbed)
- `GET /ws` — typed WebSocket RPC + scoped pub/sub

### WebSocket Subscription Topics (`packages/shared/src/index.ts:402-409`)
`global:status` · `global:selfmod` · `chat:meta` · `project:{id}:board` · `project:{id}:previews` · `project:{id}:debates` · `bot:{id}:timeline`

### Local MCP Bridge Tools (`apps/daemon/src/mcp/mcpBridge.ts:64-160`)
`bf_task_list` · `bf_task_claim` · `bf_task_update` · `bf_handoff_write` · `bf_memory_search` · `bf_fix_tasks_list` · `bf_fix_task_resolve` · `bf_debate_post`

---

## 5. Known Gotchas & Footguns (Save Hours of Debugging)

1. **`reasoningEffort`, `autonomyLevel`, and `chat.send.projectId` are currently NO-OPs in the daemon.**
   They are validated by Zod (`packages/shared/src/index.ts`) and sent by `App.tsx`, but `apps/daemon/src/orchestration/engine.ts` never reads them yet. Wire them before claiming they work!
2. **No `bot.resume` exists yet.**
   Calling `bot.pause` or `bot.stop` permanently marks the agent `paused`/`stopped`; `task.dispatch` rejects it (`engine.ts:617-619`). Adding `bot.resume` is a P0 task.
3. **`apps/web/src/previews/PreviewStudio.tsx` is dead legacy code.**
   713 lines, completely unreferenced since `InAppBrowser.tsx` replaced it, and its CSS classes were removed from `app.css`. Safe to delete.
4. **Git `status --porcelain` leading space trap.**
   `runGitSync` trims stdout, so `" M README.md"` arrives as `"M README.md"`. Never use `line.slice(3)` — keep the regex parser in `parsePorcelainStatus` (`worktrees.ts:787`) and its regression guard in `tests/browser_api_security.test.ts`.
5. **Git worktree `.git` is a file, not a directory.**
   Always filter `entry.name.toLowerCase() === ".git"` for files as well as directories in `listSafeRepoFiles` (`worktrees.ts:717`).
6. **`runningBots` excludes `scope === "global"`.**
   The Meta-Orchestrator is not counted in `quietStatus.runningBots` (`engine.ts:1581`), and `ChatTab`'s `busy` state clears on RPC ACK rather than turn completion.
7. **Error status event gap.**
   When `runAgentTurn` catches an error (`engine.ts:1070-1081`), it writes `status: "error"` to SQLite without emitting a `status.updated` WS event — emit it when fixing turn lifecycle.
8. **3D SVG intrinsic sizing.**
   SVGs without explicit `width`/`height` attributes (like `artifacts/ui-mockup.svg`) collapse to `0×0` inside `inline-block` flex children unless given explicit `width: "100%"` (already handled in `InAppBrowser.tsx:1602-1666`).
