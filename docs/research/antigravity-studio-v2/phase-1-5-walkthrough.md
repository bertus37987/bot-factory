# Bot-Factory Execution Walkthrough

> Historical Antigravity artifact for the Phase 1-5 work at `a785bba`. Its checks are not the V2 recovery checks.

All 5 implementation phases of **Bot-Factory** have been completed in `source checkout` while keeping your existing runtime data in `~/bot-factory/system` (`state.db*`, `.daemon-token`, `memory/`, `projects/`) untouched and preserving all archived Gen-1/Gen-2 prototypes on git tag `archive/variants-gen1-gen2`.

---

## Local Commit History (`main`, unpushed)
- `ba4439d` *(tag: `archive/variants-gen1-gen2`)* — Baseline handoff snapshot
- `4afa8a1` — **Step 0:** Relocated repository from `~/bot-factory/system/harness` to `the source checkout`, removed duplicate unversioned files under `~/bot-factory/system/`, archived `variants/` and removed dead `PreviewStudio.tsx`, and added [ARCHITECTURE_AND_UI_SPEC.md](../../../docs/ARCHITECTURE_AND_UI_SPEC.md) + English Phase 3.3 [DESIGN.md](../../../DESIGN.md).
- `8652a35` — **Phase 1:** P0 security hardening, lane-partitioned parallel outbox, SQLite v2 migration, async git diff, and honest error/admission state machines.
- `ca3f3ac` — **Phase 2:** Open BYOS roster, multi-protocol SSE + multi-step tool loop, Claude/Codex `CliStreamRuntime`, progressive 4-tier autonomy + 120s interactive ACP permission gate, active 3-layer memory, and write-only Secrets API.
- `6343f00` — **Phase 3:** 3-tier autonomous orchestration (`Main Manager` -> `Team Lead` -> `Peer Bots` -> `Depth-1 Subagents`), 14 MCP tools, real `IndependentVerifier` check runner & diff gate, and human-approved `task.merge`.
- `d0a062b` — **Phase 4:** English Phase 3.3 Light-Mode Studio with bundled Fontsource fonts, Devin/Codex Main Agent + Double-Deck Composer, Grok-Bot multi-side Group Chat + nested subagent trees, modular 2-row 6-viewer In-App Browser (lazy Three.js + `%` image overlays), Escalation Inbox, and Wave 4 Studios.
- `a785bba` — **Phase 5:** Headless Chromium Playwright UI E2E (`tests/ui_e2e.test.ts` / `tests/ui_e2e_playwright.py`), fixes for two UI bugs discovered by Playwright (`ImageViewer` SVG `fit`-mode sizing and `MemoryL1Studio` banner reset), Biome lint config (`biome.json`), GitHub Actions CI (`.github/workflows/ci.yml`), and refreshed `README.md`, `AGENTS.md`, `HANDOFF.md`.

---

## Key Changes Implemented

### 1. Security, Parallel Outbox & Runtime Hardening
- **Authentication & Isolation:** Enforced HMAC-SHA256 `HttpOnly; SameSite=Strict` `bf_session` cookie / `x-bf-token` auth across `/ws` and `/api/*` in [server.ts](../../../apps/daemon/src/rpc/server.ts) (with `GET /?token=` cookie bootstrap, `/api/auth/session`, `/api/auth/status`, and Vite dev proxy header forwarding in [vite.config.ts](../../../apps/web/vite.config.ts)).
- **Containment & XSS Fixes:** Fixed Windows cross-drive reads in `serveStaticUi`, added `lstatSync` dangling-symlink protection in [nativeHttpRuntime.ts](../../../apps/daemon/src/runtimes/nativeHttpRuntime.ts), enforced `Content-Security-Policy: sandbox` + `nosniff` on `/api/projects/:id/artifact`, expanded the sensitive repo denylist in [worktrees.ts](../../../apps/daemon/src/git/worktrees.ts), guarded `deepMerge` against prototype pollution in [selfMod.ts](../../../apps/daemon/src/phase3/selfMod.ts), and minted per-agent scoped MCP tokens in [engine.ts](../../../apps/daemon/src/orchestration/engine.ts).
- **Parallel Lanes & SQLite v2:** Partitioned [commandCore.ts](../../../apps/daemon/src/core/commandCore.ts) into an immediate `control` lane (`bot.abort`, `permission.respond`), `interactive` lane, and bounded parallel `work` pool; migrated [database.ts](../../../apps/daemon/src/db/database.ts) to schema v2 (persisted `turn_counter`, `depth`, `subagent_mode`, `depends_on_json`, `auto_retry_count`, `verify_checks_json`, `memory_embeddings`, FTS5 `AFTER UPDATE` triggers, Windows PID-reuse lock verification, and SQL `COUNT(*)` status counts); made `computeWorkspaceGitDiff` async.

### 2. Open BYOS Runtimes, Streaming & Strong Active Memory
- **Open BYOS & Hot Reload:** Unlocked [packages/shared/src/index.ts](../../../packages/shared/src/index.ts) and [selfMod.ts](../../../apps/daemon/src/phase3/selfMod.ts) from the old 3-provider lock, added presets in [config.example.json](../../../config.example.json), and wired config + `system/plugins/` hot-reload.
- **Runtimes:** Added SSE streaming, `reasoningEffort`, usage metering, and multi-step tool-calling loops across `openai_compatible`, `google_gemini`, and `anthropic` in [nativeHttpRuntime.ts](../../../apps/daemon/src/runtimes/nativeHttpRuntime.ts); added progressive 4-tier autonomy + 120s interactive `permission.respond` pauses in [acpSubprocessRuntime.ts](../../../apps/daemon/src/runtimes/acpSubprocessRuntime.ts); added [cliStreamRuntime.ts](../../../apps/daemon/src/runtimes/cliStreamRuntime.ts) for `claude` and `codex`.
- **Strong Active Memory & Write-Only Secrets:** Wired `chat:meta` + team-report auto-ingestion, real LLM-backed `DreamExtractor` + RRF hybrid vector/FTS5 + 3-hop graph recall in [memoryEngine.ts](../../../apps/daemon/src/memory/memoryEngine.ts) and [index.ts](../../../apps/daemon/src/index.ts), automatic session compaction refreshing frozen 3-tier prompts, and write-only `/api/secrets*` routes.

### 3. Autonomous 3-Tier Orchestration, Subagents, Real Verifier & Merge
- **Executive & Team Lead Tools:** Added [agentTools.ts](../../../apps/daemon/src/orchestration/agentTools.ts) giving `Meta-Orchestrator` delegation/status/memory tools and each `PM` Team Lead repo-inspection, DAG task batching, bot spawning, verification, and `bf_report_to_manager` upward reporting tools.
- **Depth-1 Bot Subagents:** Added [subagentManager.ts](../../../apps/daemon/src/orchestration/subagentManager.ts) and 6 `bf_subagent_*` MCP tools in [mcpBridge.ts](../../../apps/daemon/src/mcp/mcpBridge.ts) (`readonly` shared worktree vs. `code` isolated `bf/sub-*` child worktree + `bf_subagent_apply_patch` + parent-stop cleanup).
- **Continuous Loop, Verifier & Merge:** Built [autonomyLoop.ts](../../../apps/daemon/src/orchestration/autonomyLoop.ts), upgraded [verifier.ts](../../../apps/daemon/src/phase3/verifier.ts) to run configured `verifyChecks` + inspect real `git diff` (failing closed on empty non-doc diffs), and implemented `mergeBotWorktree` (`squash` / `merge_commit`, conflict abort, pre-merge safety ref, and worktree/branch cleanup).

### 4. English Light-Mode Studio UI & Modular 2-Row Browser
- **Shell & Main Agent:** Bundled `@fontsource/inter` and `@fontsource/jetbrains-mono`, localized all UI copy to English, refactored [useBotFactory.ts](../../../apps/web/src/client/useBotFactory.ts) (ref-counted subscriptions, backoff, heartbeat, streaming deltas), upgraded [App.tsx](../../../apps/web/src/App.tsx), [ChatTab.tsx](../../../apps/web/src/chat/ChatTab.tsx), [PrecisionComposer.tsx](../../../apps/web/src/components/PrecisionComposer.tsx), and [ReasoningEffortSlider.tsx](../../../apps/web/src/components/ReasoningEffortSlider.tsx), and added [EscalationInbox.tsx](../../../apps/web/src/studio/EscalationInbox.tsx).
- **Grok-Bot Group Chat & Wave 4 Studios:** Updated [BotChatStream.tsx](../../../apps/web/src/bots/BotChatStream.tsx) and [BotsTab.tsx](../../../apps/web/src/bots/BotsTab.tsx) with multi-side alignment (`You`/`Team Lead` right, `Bots`/`Verifier` left), nested subagent trees, DAG chips, and explicit Pause/Resume/Stop controls; built [ProjectModal.tsx](../../../apps/web/src/studio/ProjectModal.tsx), [BotSpawnModal.tsx](../../../apps/web/src/studio/BotSpawnModal.tsx), [SettingsView.tsx](../../../apps/web/src/studio/SettingsView.tsx), [CheckpointsMergePanel.tsx](../../../apps/web/src/studio/CheckpointsMergePanel.tsx), and [MemoryL1Studio.tsx](../../../apps/web/src/studio/MemoryL1Studio.tsx).
- **2-Row Modular Browser:** Split [InAppBrowser.tsx](../../../apps/web/src/browser/InAppBrowser.tsx) across dedicated viewer modules with lazy-loaded render-on-demand [Model3DViewer.tsx](../../../apps/web/src/browser/Model3DViewer.tsx), `%`-based [ImageViewer.tsx](../../../apps/web/src/browser/ImageViewer.tsx) zoom/pan + annotations, [DocViewer.tsx](../../../apps/web/src/browser/DocViewer.tsx), [CodeViewer.tsx](../../../apps/web/src/browser/CodeViewer.tsx), [DiffViewer.tsx](../../../apps/web/src/browser/DiffViewer.tsx), and [WebViewer.tsx](../../../apps/web/src/browser/WebViewer.tsx).

---

## Verification Results (Observed After Final Commit `a785bba`)

- **`bun run check`** — **exit 0**:
  - `bun run typecheck` (`bun x tsc --noEmit`): **exit 0**
  - `bun run lint` (`bun x biome check packages apps tests`): Checked 66 files, **0 errors** (381 warnings, 15 infos), **exit 0**
  - `bun test tests`: **42 pass, 0 fail, 583 `expect()` calls across 8 files (`35.14s`)**
    - `tests/browser_api_security.test.ts`: 1 pass
    - `tests/harness_e2e.test.ts`: 4 pass
    - `tests/memory_acp_mcp.test.ts`: 17 pass
    - `tests/phase1_security_parallel_recovery.test.ts`: 8 pass (includes v1→v2 migration test on an isolated temp copy of `~/bot-factory/system/state.db*`)
    - `tests/phase2_byos_streaming_memory.test.ts`: 4 pass
    - `tests/phase3_autonomous_subagents_merge.test.ts`: 4 pass
    - `tests/phase3_debates_verifier_selfmod.test.ts`: 3 pass
    - `tests/ui_e2e.test.ts`: 1 pass (`8875.42ms`, driving headless Chromium `143.0.7499.4` end-to-end with zero uncaught page or console errors)
  - `bun run build:web` (`vite build`): **exit 0** (`3.66s`, `dist/assets/index-Bo6RPObk.js` `593.20 kB` / `164.43 kB` gzip + lazy chunk `dist/assets/Model3DViewer-Yy6f0tKl.js` `593.59 kB` / `151.94 kB` gzip + local Fontsource fonts)
- **`bun run doctor`** — **exit 0** (confirmed `~/bot-factory/system/state.db` untouched at `schema_version=1`, `epoch=1`, and local `bun`, `git`, `devin`, `opencode`, `claude`, `codex` CLIs detected).
