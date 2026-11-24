# Bot-Factory Studio V2 — Implementation Plan

## Scope & Approved Decisions
1. **Bear Crew Brand Identity:** 7 bespoke velvety matte low-poly 3D Brown Bear Head portraits (`bear-orchestrator`, `bear-team-lead`, `bear-builder`, `bear-artist`, `bear-research`, `bear-verifier`, `bear-cub`) with lighter tan snouts, single role accessories, and a **60fps live animated SVG eye layer** (natural blinks, subtle glances, working scan, alert waiting eyes, happy curved `^ ^` completion eyes).
2. **Vanta Black (`#000000`) Theme + Light Toggle & Messenger Chats:** `#000000` canvas default with Light Mode toggle in the rail; classic Messenger bubbles (You on right, Bots & Orchestrator on left with distinct role-tinted high-contrast bubbles); Orchestrator messages inside target bot chats wear the Orchestrator Bear avatar and warm Amber/Gold bubble; `Debates & Verifier` tab removed (inline in Group Chat).
3. **Zero-Gap Resizable Layout & 4-Mode Browser:** Zero-footprint `1px` `ResizeSplitter` components replacing `.browser-resize-gutter`; resizable & collapsible Sidebar; **4-mode Browser** (`right`, `bottom`, `float` draggable + 8-edge resizable, `fullscreen`); **Split-Chat** side-by-side mode; container-responsive `PrecisionComposer` with attachment chips.
4. **Inline Editable & Commentable Docs & Images:** `Annotate` and `Pins (0)` buttons removed; `DocViewer` supports direct inline markdown edit & save + selection/block `"Comment → Chat"`; `ImageViewer` supports direct region comment + lightweight brush/arrow/rect/crop markup & save + `"Add to Chat"` importing cropped thumbnails & notes straight into the active chat composer.
5. **Animated All-Bots Todo List & Main Agent Full Control:** Unified `TodoBoardView` (`All` / `By Bot` / `By Status`, animated progress bar, spring SVG checkmarks, pulsing working rings); Main Agent gets `bf_config_get`, `bf_config_update`, `bf_bot_spawn`, `bf_bot_update_model`, `bf_bot_message`, `bf_task_list/create/update/dispatch`, plus `PUT /api/projects/:id/artifact` and SQLite Schema v3 attribution.
6. **2026 Harness & Multi-Agent Upgrades:** Synthesized from `/browser` research + Factory Droid CLI architectural audit into `docs/HARNESS_RESEARCH_2026.md` and surgical runtime improvements (`nativeHttpRuntime.ts`, `autonomyLoop.ts`, `subagentManager.ts`, `verifier.ts`).

## Execution Strategy
- **Wave 0:** Parallel `/browser` research (harness engineering + multi-agent collaboration), Factory Droid CLI audit (`droid exec --auto low`), and 7 matte 3D Bear Head portrait generations + alpha/crop processing.
- **Wave 1 (Parallel Swarm):** `v2-backend`, `v2-layout-browser`, `v2-todo-board`.
- **Wave 2 (Parallel Swarm):** `v2-theme-bears-shell`, `v2-harness-upgrades`.
- **Wave 3:** `v2-verifier` Playwright E2E + full `bun run check`, `bun run doctor`, live daemon restart on `:4310`, and multi-view visual QA in Vanta Black & Light Mode.
