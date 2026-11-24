# HANDOFF.md — Phase 5 Status, Architecture Matrix & Verified Commands

> For current code, verification, and follow-up work, start with the [Studio V2 handoff](./docs/STUDIO_V2_HANDOFF.md). This scorecard documents the earlier Phase 5 baseline.

> **Status:** Phases 1–5 Implemented (Backend Control Plane, Open BYOS, Active 3-Layer Memory, Autonomous DAG Loop & Subagents, Real Independent Verifier & Merge, Light-Mode Studio UI, Biome Lint, GitHub Actions CI & Playwright E2E)
> **Source vs. Runtime Separation:** Source code lives in the repository (`packages/`, `apps/`, `tests/`); mutable state (`state.db`, `config.json`, `secrets.env`, `.daemon-token`, `memory/`, `projects/`) lives strictly under `BOT_FACTORY_ROOT` (default `~/bot-factory`, or `./.dev-runtime` via `bun run dev:daemon:isolated`).

---

## 1. Executive Summary

Bot-Factory has completed the full 5-phase buildout from local control-plane foundations through the English Light-Mode Studio and CI/lint/E2E verification:

- **Phase 1 (Control Plane, Auth, Security & Crash Recovery):** Single-writer SQLite (`WAL`, `runtime_epoch`, PID lockfile), 1-TX `CommandCore` + Outbox worker, localhost-only (`127.0.0.1`) `DaemonServer` with HMAC-signed `bf_session` cookie / `x-bf-token` auth, `SecretScrubber`, `realpath`-containment browser APIs, Windows process-tree cleanup, and `dev:daemon:isolated` + read-only `doctor`.
- **Phase 2 (Open BYOS Runtimes & Active 3-Layer Memory):** Multi-protocol `NativeHttpRuntime` (SSE streaming + tool loop for `openai_compatible`, `google_gemini`, `anthropic`), `AcpSubprocessRuntime` (`devin acp`, `opencode acp`), `CliStreamRuntime` (`claude`, `codex`), `L1` Markdown + `L2` LLM batch dreaming + `L3` hybrid vector/FTS5/graph retrieval + automatic in-place session compaction.
- **Phase 3 (Autonomous DAG Loop, Depth-1 Subagents, Real Verifier & Merge):** `AutonomyLoop`, `SubagentManager` (`readonly` / `code` subagents via 14-tool `mcpBridge.ts`), `IndependentVerifier` (real `git diff` + `project.verifyChecks` + cross-family `excludeProvider` + fail-closed `VERDICT`), `mergeBotWorktree` (`squash` / `merge_commit`), Conflict Debates, and Self-Mod Sandbox.
- **Phase 4 (English Light-Mode Studio & Wave 4 Studios):** Monochrome Ink Light Mode (`#FFFFFF`/`#FAFAFA`/`#F5F5F5`, `#D95D22`, self-hosted `@fontsource/inter` + `@fontsource/jetbrains-mono`), Devin/Codex `ChatTab` + Double-Deck `PrecisionComposer`, Grok-Bot multi-side `BotChatStream` + 5-column DAG Kanban, modular 2-row 6-viewer `InAppBrowser` (lazy Three.js `Model3DViewer` with demand-driven rendering, `%`-coordinate `ImageViewer`, loopback-only `WebViewer`), `EscalationInbox`, and Wave 4 Studios (`ProjectModal`, `BotSpawnModal`, `CheckpointsMergePanel`, `MemoryL1Studio`, `SettingsView`).
- **Phase 5 (Quality Gates, CI, Playwright E2E & Docs):** Biome 2.6.8 linting (`biome.json`, `bun run lint`), unified `bun run check`, `.github/workflows/ci.yml`, deterministic Playwright Chromium UI E2E (`tests/ui_e2e.test.ts` + `tests/ui_e2e_playwright.py`), and refreshed `README.md` / `AGENTS.md` / `HANDOFF.md`.

---

## 2. Pillar & Gap Matrix (Phase 5 State)

| # | Architecture Pillar | Backend Status | Web Studio Status | Verified Capabilities | Remaining Future Backlog / Polish |
|---:|---|---:|---:|---|---|
| 1 | **Main Managing Agent & 3-Layer Memory** | **Complete** | **Complete** | `Meta-Orchestrator` on quiet `chat:meta`; 8 executive tools (`bf_team_delegate`, `bf_memory_*`, etc.); 3-tier frozen prompts; `L1` Markdown (`USER.md`, `GLOBAL_MEMORY.md`, `MEMORY.md`) w/ char gauges; `L2` temporal graph + LLM dreaming (`memory_dreaming`); `L3` hybrid vector/FTS5/graph search; auto-compaction (`autoCompactThresholdTokens`); `MemoryL1Studio` + `ChatTab` `MarkdownRenderer` & delivery cards. | Optional background L2 fact-edge visualization beyond searchable table; optional manual compaction trigger button in UI. |
| 2 | **Team Leads, Peer Bots & Depth-1 Subagents** | **Complete** | **Complete** | Project Team Leads (`PM`, 11 tools); parallel peer bots in isolated `worktrees/wt-*` (`bf/*` branches); depth-1 `SubagentManager` (`readonly`/`code`, `subagent_max_depth_exceeded` guard, Windows handle-safe patch apply); 14-tool `mcpBridge.ts`; Grok-Bot multi-side Group Chat, `@mention` chips, collapsible tool/subagent trees, `BotSpawnModal`, `bot.resume`. | Optional drag-and-drop Kanban reordering in `BotsTab` (explicit status transitions & dispatch/verify/merge work via cards/modals). |
| 3 | **Autonomous DAG Loop, Real Verifier & Merge** | **Complete** | **Complete** | `AutonomyLoop` (`dependsOn` unblocking, `maxConcurrentBotsPerProject` cap, retry w/ findings up to `maxTaskAutoRetries`, `bf_report_to_manager` -> `meta.team_report`); `IndependentVerifier` (fresh `verifier:ephemeral` session, cross-family `excludeProvider`, real `project.verifyChecks`, real `git diff` + empty-diff fail-closed gate); Conflict Debates; Self-Mod Sandbox; human-approved `task.merge` (`squash`/`merge_commit`) + `CheckpointsMergePanel`. | Optional multi-commit rebase / interactive conflict-resolution editor inside UI (currently clean-aborts & surfaces conflict paths). |
| 4 | **Open BYOS Runtimes, Autonomy & Localhost Auth** | **Complete** | **Complete** | `native_http` SSE + tool loop (`openai_compatible`, `google_gemini`, `anthropic`), `acp_stdio` (`devin`/`opencode`), `cli_stream` (`claude`/`codex`, scrubbed env), `reasoningEffort` & 4-tier `autonomyLevel` wired end-to-end, 120s interactive Allow/Deny escalation (`permission.respond`), `127.0.0.1` Origin checks, `bf_session` cookie / `x-bf-token` auth, `AuthUnlockGate`, write-only `SettingsView` secrets + `Test Connection`. | Non-local multi-user auth / TLS out of scope (by design: Bot-Factory is a strictly localhost `127.0.0.1` hub). |
| 5 | **Modular In-App Browser, Studio Shell & Quality Gates** | **Complete** | **Complete** | 2-row `BrowserChrome`, `DocViewer`, `%`-coord `ImageViewer` w/ zoom/pan, lazy Three.js `Model3DViewer` (demand-driven rendering, presets, surface pins, PNG snapshots), `CodeViewer`, `DiffViewer`, self-embed-guarded loopback `WebViewer`, `AnnotationOverlay` (`requestFixNow`), `EscalationInbox` + `session.resolve_unknown`, `Ctrl+K` palette, Biome lint (`biome.json`), `.github/workflows/ci.yml`, `dev:daemon:isolated`, `doctor`. | Repo-wide Biome formatting pass (`formatter.enabled` is intentionally `false` in `biome.json` to preserve existing CRLF/LF & multi-line formatting across files). |

---

## 3. Verified Commands

Run from the repository root (`C:\Users\willy\source\repos\bot-factory`):

| Command | Purpose | Notes |
|---|---|---|
| `bun run check` | Full local verification (`typecheck` -> `lint` -> `test` -> `build:web`) | Ensure `bun run build:web` has already built `apps/web/dist` at least once on a clean checkout so Playwright UI E2E finds `apps/web/dist/index.html` (or set `BOT_FACTORY_SKIP_PLAYWRIGHT=1`). |
| `bun run typecheck` | Typecheck `packages/*`, `apps/*`, and `tests/*` (`tsc --noEmit`) | Zero-error TypeScript strict mode across monorepo. |
| `bun run lint` | Run Biome checks (`bun x biome check packages apps tests`) | Uses `biome.json` (`preset: "recommended"`, ignores `node_modules`, `dist`, `.dev-runtime`, `coverage`, unknown extensions). |
| `bun test tests` | Execute all Bun integration, security, autonomy & Playwright UI E2E suites | Set `BOT_FACTORY_SKIP_PLAYWRIGHT=1` in environments without Chromium (already configured in `.github/workflows/ci.yml`). |
| `bun run build:web` | Build production Studio UI bundle into `apps/web/dist` | Splits Three.js `Model3DViewer` into a lazy chunk and bundles self-hosted `@fontsource/inter` & `@fontsource/jetbrains-mono`. |
| `bun run doctor` | Read-only preflight inspection of `BOT_FACTORY_ROOT`, secrets, `.writer.lock`, DB & CLIs | Never mutates `state.db` or acquires `.writer.lock` (inspects WAL/SHM via temp copy). |
| `bun run dev:daemon:isolated` | Start daemon against isolated `./.dev-runtime` (`BOT_FACTORY_ROOT`) | Safe for live UI/browser testing without touching `~/bot-factory`; prints tokenized localhost URL. |
| `bun run dev:web` | Start Vite HMR dev server on `http://127.0.0.1:5173` | Proxies `/api` and `/ws` to `127.0.0.1:4310` with auto-discovered `.daemon-token`. |
| `bun run start` | Start daemon using default `~/bot-factory` (or `BOT_FACTORY_ROOT`) | Serves built `apps/web/dist` + HTTP/WS API on `http://127.0.0.1:4310`. |

---

## 4. CI & Quality Gate Notes

- **CI Workflow ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)):** Triggers on `push` and `pull_request` to `main` on `ubuntu-latest` using `oven-sh/setup-bun@v2`, runs `bun install --frozen-lockfile`, `bun run typecheck`, `bun run lint`, `bun run build:web`, and `bun test tests` with `BOT_FACTORY_SKIP_PLAYWRIGHT=1`.
- **Biome Configuration ([`biome.json`](./biome.json)):** Enforces recommended TypeScript/React/CSS lint rules (`useValidAriaRole` with `ignoreNonDom: true` for custom React `role` props), keeps `formatter.enabled: false` and `assist.enabled: false` so mixed CRLF/LF line endings do not trigger noisy diff churn, and excludes `node_modules`, `dist`, `.dev-runtime`, and `coverage`.
