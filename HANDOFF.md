# HANDOFF.md — Product Goal vs. Current Implementation & Wave 3 Roadmap

> **Audit Date:** 2026-11-23  
> **Baseline Verification:** `bun run typecheck` (0 errors) · `bun test tests` (**25 pass, 0 fail, 242 assertions**) · `bun run build:web` (clean)  
> **Audit Basis:** Full read-only cross-audit of `docs/research/*.md`, `config.example.json`, `packages/shared`, `apps/daemon`, and all 17 files in `apps/web/src/`.

---

## 1. Executive Summary

Bot-Factory has completed **Phase 0 (Research)**, **Phase 1 (Core Daemon & Worktrees)**, **Phase 2 (Annotatable Previews & Memory/ACP/MCP Foundations)**, **Phase 3 (Debates, Independent Verifier & Self-Mod Sandbox)**, and **Phase 3.2/3.3 (Light-Mode Studio Redesign with Low-Poly Orange Beavers & Native 2-Row In-App Browser)**.

- **Backend readiness across the 9 product pillars:** **~73%** (core transactional engine, worktrees, hidden checkpoints, MCP bridge, Phase-3 verifier/self-mod, and browser security APIs are solid and tested).
- **Current Web UI E2E coverage across the 9 product pillars:** **~36%** (the visual shell, preview browser, annotation loop, and Phase-3 panels are genuinely wired, but key operator controls are either hardcoded, cosmetic/dropped server-side, or completely absent).

---

## 2. Pillar-by-Pillar Comparison

| # | Product Goal Pillar | Backend | Web UI | What Works Today | What Is Missing or Broken |
|---:|---|---:|---:|---|---|
| 1 | **Annotatable Previews & In-App Browser** | 95% | 85% | 2-row tab/breadcrumb chrome, 6 full-bleed viewers (Doc, Image/SVG, auto-framed Three.js 3D GLB + raycast pins + camera pose restore, Code, Live Git Diff, Loopback Web), `/files`+`/file`+`/diff` security boundaries, annotation create & approve/reopen. | Annotation composer forces `requestFixNow: true` (no comment-only mode); stored 3D `snapshotDataUrl` not shown in Pins popover; Image viewer shows `cursor: grab` with no pan/zoom; dead legacy `PreviewStudio.tsx` still on disk. |
| 2 | **Phase-3 Governance** | 90% | 75% | Conflict debates (3-round cap + PM escalation), Cross-Family Independent Verifier (fresh session, zero history, fail-closed), Self-Mod Sandbox (Stage→Verify→Promote→Rollback, TOCTOU SHA-256). | Debate UI auto-picks participants & cycles speaker instead of explicit selectors; Self-Mod forces `autoVerify: true`, hides `stagingPath`/`livePath`/`backupPath` & detailed report, and lacks reject/delete. |
| 3 | **Two-Worlds UI & Chat Isolation** | 90% | 70% | 44px custom icon rail, 252px collapsible drawer, Low-Poly Beaver avatars + Job Title pills, Burnt-Orange human bubbles, multi-side Group Chat, quiet collapsed traces, strict `chat:meta` isolation. | `QuietStatusProjection.inboxNotices` is **never rendered**; `chat.send` ignores `projectId`; Meta-Orchestrator thinking state clears on ACK instead of turn completion; fixed LIMIT reads (no user-anchored windowing/pagination). |
| 4 | **Project & Task Orchestration** | 75% | 45% | Provisioning workspaces (`plans/`, `artifacts/`, `handoffs/`, `repo/`, `worktrees/`), `bf/*` worktrees, task creation/dispatch/verify, MCP `bf_task_*`. | `project.create` UI hardcodes `Projekt-N` + demo artifacts (never passes custom name, `slug`, or `externalRepoPath`); `task.create` is title-only (hardcodes `specMd` & `priority: 2`); `task.dispatch` never selects target `agentId`; static Kanban; no `project.archive` or `task.merge` RPC. |
| 5 | **Bot Fleet, BYOS & Model Routing** | 80% | 25% | `NativeHttpRuntime` (Mistral/GLM/Gemini + offline mock), `AcpSubprocessRuntime` (JSON-RPC stdio + Windows `taskkill /T /F`), 8 MCP tools, `ModelRouter` with `projectOverrides`. | **No `bot.resume`** (Pause/Stop are one-way doors); `Aufwand` (`reasoningEffort`) & `Autonomie` (`autonomyLevel`) are **dropped by daemon**; `providers` list is fetched & discarded; `bot.spawn` hardcodes `peer` with no model/provider/scope picker; no RPC to write `projectOverrides`. |
| 6 | **Checkpoints & Scoped Rollback** | 65% | 10% | Per-turn hidden Git refs (`refs/bot-factory/checkpoints/<sha1>/<turn>`), `checkpoints` table, cross-worktree-safe `restoreCheckpoint()`. | **No `checkpoint.rollback` RPC** (only called in tests); `TimelineItem.checkpointRef` never rendered; no Checkpoint timeline or restore button in UI; `handoffs/` only viewable via generic file list. |
| 7 | **Escalations & Crash Recovery** | 75% | 5% | Single-writer `runtime_epoch`, `recoverAfterRestart` marks interrupted turns `unknown`, `session.resolve_unknown` RPC unblocks FIFO, ACP permission resolver detects out-of-worktree/destructive ops. | **0% UI for `session.resolve_unknown`**; **0% UI for `inboxNotices`**; ACP escalations are auto-cancelled immediately instead of pausing for human Allow/Deny RPC; no global error boundary/toast system. |
| 8 | **Memory, Fact-Graph & Compaction** | 65% | 0% | L1 Markdown (`USER.md`, `GLOBAL_MEMORY.md`, `MEMORY.md` + char gauge/cap), Frozen 3-Tier Prompt, L2 `live_memory_facts` + `updates/extends/derives`, `compactSessionInPlace` in DB. | **0% UI** (no L1 editor, no Fact Graph/Memory explorer, no compaction/dreaming status); dreaming still uses heuristic extractor instead of GLM 5.3 Flash; `compactSessionInPlace` & `getRelatedFacts` never called by engine; memory ingest only runs on steers (not chat/task turns). |
| 9 | **Onboarding, Settings & Secrets** | 50% | 0% | `config.json`, `secrets.env`, `GET /api/health`, `SecretScrubber`. | **0% UI** (no Settings panel, no API key configured/missing status, no guardrail/concurrency controls, no live vs. `local-sim` indicator). |

---

## 3. Prioritized Engineering Roadmap (Next Waves)

### Wave 3 — P0: Make Every Visible Control Honest & Production-Usable
1. **Wire `reasoningEffort` & `autonomyLevel` End-to-End**
   - Pass `reasoningEffort` through `engine.ts` → `NativeHttpRuntime` (provider reasoning/thinking params) & `AcpSubprocessRuntime` (session config/mode).
   - Map `autonomyLevel` (`spec` / `low` / `medium` / `high`) into the ACP permission policy & native prompt guardrails.
2. **Add `bot.resume` RPC + UI Button**
   - Add `bot.resume` to `RpcCommandSchema` (`packages/shared/src/index.ts`), transition `paused | stopped | error → idle` in `engine.ts`, and render a `Resume` button in `App.tsx` whenever `activeAgent.status` is `paused` or `stopped`.
3. **Real Project Creation & Existing Repo Attachment Modal**
   - Replace hardcoded `Projekt-N` click handlers (`App.tsx:326,419,745,796`) with a lightweight modal supporting: Project Name, optional `slug`, optional `externalRepoPath` (attach local Git repo), and `seedDemoArtifacts` toggle.
4. **Bot Spawn Modal with Provider / Model / Role / Scope Picker**
   - Consume the already-fetched `bf.providers` (`useBotFactory.ts:59`) to let operators choose `scope` (`peer` | `sidekick`), role preset (`Builder`, `3D Artist`, `Research`), provider, and model. Make the composer model badge interactive for active agent / project routing.
5. **Project-Scoped Meta-Orchestrator Chat**
   - Read `cmd.projectId` in `engine.ts:263` (`chat.send`) to inject active project context (repo summary, active tasks, project `MEMORY.md`) into the ephemeral turn context.
6. **Escalation Inbox & Crash-Recovery (`session.resolve_unknown`) UI**
   - Render `quietStatus.inboxNotices` in a calm collapsible Inbox drawer/popover (top header badge only when `action` notices exist).
   - Add an inline recovery banner when an admission is `unknown`, wired to `session.resolve_unknown`.
   - Upgrade `acpSubprocessRuntime.ts` permission escalations to hold a pending promise (bounded by `permissionRequestTimeoutSeconds`) resolvable via a new `permission.respond` RPC (`allow_once` / `reject_once`) with Approve/Deny cards in the Inbox & BotChatStream.

### Wave 4 — P1: Unlock Core Bot-Factory Differentiators
1. **Checkpoints & Scoped Rollback Surface**
   - Add `checkpoint.list` (HTTP/WS) and `checkpoint.rollback` RPC calling existing `restoreCheckpoint()` (`worktrees.ts:530`) + post-rollback ref cleanup (`t3code.md §4`).
   - Surface turn checkpoint chips inside `BotChatStream.tsx` with a confirmed scoped restore action.
2. **Memory Studio (L1 Markdown Editor + Supermemory Fact Explorer)**
   - Add read/write daemon endpoints for L1 Markdown (`USER.md`, `GLOBAL_MEMORY.md`, project `MEMORY.md`) with live char-gauge headers (`[67% — 1,474/2,200 chars]`).
   - Add read-only Supermemory Fact Graph viewer (`live_memory_facts` + `updates/extends/derives` edges + soft-forget toggle).
   - Wire real `GLM 5.3 Flash` batch dreaming (`memoryEngine.ts:282`), turn-level memory ingest (chat + peer tasks), and automatic `compactSessionInPlace` trigger.
3. **Settings, Secrets Status & Routing Overrides UI**
   - Add a `Settings` view (reachable from the far-left 44px icon rail) showing: daemon health (`GET /api/health`), configured vs. missing API keys (`secrets.env` key presence only — never echo secret values!), per-project `routingOverrides` editor (`project.update_routing` RPC), and active guardrails (`maxConcurrentBotsPerProject`, `maxDebateRounds`, `maxAnnotationFixRetries`).
4. **Richer Task, Debate, Self-Mod & Composer Flows**
   - Task creation modal/drawer with `specMd`, `priority`, and target `agentId` selector; Debate participant picker + `maxRounds` + task link; Self-Mod optional `autoVerify` toggle + audit paths + full verifier report disclosure.
   - Fix `PrecisionComposer.tsx` slash popover `Escape` handling and make `Enter` execute the highlighted slash action instead of sending literal `"/plan"`; wire `Quick review` to trigger a real verifier/review turn instead of duplicating `View diff`.

### Wave 5 — P2: Cleanup, Reliability & Polish
- Delete dead `apps/web/src/previews/PreviewStudio.tsx` (713 lines).
- Emit `status.updated` on agent error transitions (`engine.ts:1070-1081`) and track real Meta-Orchestrator turn busy state (don't clear on ACK).
- Extend `Ctrl+K` Command Palette (`App.tsx:228`) to search **Projects** and **Browser Files** in addition to Bots.
- Add WS `ping`/`pong` heartbeat, refcounted topic subscriptions (`useBotFactory.ts:96`), `agent.spawned` handling on `:board`, and a global Error Boundary + toast notifications.
- Show saved 3D `snapshotDataUrl` thumbnails inside `InAppBrowser`'s Pins popover and add pan/zoom to `ImageViewer`.
- Reset `PrecisionComposer`'s `trayDismissed` state automatically whenever a new diff hash arrives.
