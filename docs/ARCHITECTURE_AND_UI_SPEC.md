# Bot-Factory — Architecture & UI Specification

> **Status:** Authoritative design & engineering reference for Bot-Factory (`127.0.0.1` Local-First Control Plane & Light-Mode Studio).

---

## 1. Core Product Vision (5 Pillars)

1. **One Main Managing Agent (`Meta-Orchestrator`, `scope: "global"`):**
   - Communicates calmly with the operator in `Agent Chat` and interfaces directly with Engineering Bot Teams via structured executive tools (`bf_projects_list`, `bf_project_create`, `bf_team_delegate`, `bf_team_status`, `bf_memory_*`).
   - Automatically wakes on proactive completion and blocker reports (`bf_report_to_manager` -> `meta.team_report`) so the operator receives concise verified summaries and one-click Review Diff / Merge cards without digging through raw bot telemetry.
2. **Engineering Bot Teams (`Engineering Team Lead / PM` + Parallel Bots):**
   - Each project has an autonomous **Team Lead (`PM`, `scope: "project"`)** equipped with read-only repo inspection, DAG task planning (`bf_task_create_batch` with `dependsOn`), bot spawning (`bf_bot_spawn`), dispatch (`bf_task_dispatch`), verification triggering (`bf_task_verify_trigger`), debate resolution, and upward manager reporting (`bf_report_to_manager`).
   - **Individual Engineering Bots (`scope: "peer"`)** execute inside isolated Git worktrees (`worktrees/wt-*` on `bf/*`) via real ACP/CLI coding runtimes (`devin acp`, `opencode acp`, `claude`, `codex`).
3. **Bot-Deployed Subagents (`scope: "sidekick"`, Depth 1):**
   - Individual coding bots dynamically spawn bounded helper subagents (`maxSubagentsPerBot = 3`) via MCP tools (`bf_subagent_spawn`, `bf_subagent_status`, `bf_subagent_wait`, `bf_subagent_message`, `bf_subagent_kill`, `bf_subagent_apply_patch`).
   - **`readonly` subagents** share the parent bot's worktree under read-only/safe-test guardrails (search, review, test execution).
   - **`code` subagents** get an isolated child worktree (`worktrees/sub-*` on `bf/sub-*`) forked from the parent worktree's HEAD and apply verified patches (`git apply --check && git apply`) cleanly back into the parent bot's worktree.
4. **Strong Active 3-Layer Memory (Main Manager):**
   - **L1 Markdown (`USER.md`, `GLOBAL_MEMORY.md`, project `MEMORY.md`):** Char-capped, scrubber-protected live files injected into the 3-tier frozen system prompt and editable in Studio or via `bf_memory_update_l1`.
   - **L2 Temporal Fact Graph (`memory_facts` + `memory_edges` + `live_memory_facts`):** Real LLM-backed dreaming (`updates`, `extends`, `derives`) triggered automatically on every Main Chat turn, Team Lead report, and operator steer.
   - **L3 Hybrid Vector + SQLite FTS5 + Multi-Hop Graph Recall:** Optional embeddings (`memory_embeddings` via Open BYOS / Ollama) fused with SQLite FTS5 via Reciprocal Rank Fusion and expanded up to 3 hops via `getRelatedFacts`, paired with automatic `compactSessionInPlace` prompt snapshot refreshes.
5. **Fully Autonomous Delivery Loop:**
   - Main Manager delegates goal -> Team Lead decomposes into DAG -> parallel bots code, deploy subagents, self-test -> hidden Git checkpoint + real handoff -> automatic **Cross-Family Independent Verifier** (runs real project check commands + inspects real `git diff HEAD`, failing closed on empty non-doc diffs) -> `FAIL` auto-retries up to `maxTaskAutoRetries` -> `PASS` unlocks dependent tasks -> verified delivery reported to Main Manager -> human-triggered `task.merge` (`squash` | `merge_commit`) with pre-merge safety checkpoint and automatic worktree/branch cleanup.

---

## 2. System & Security Architecture

### Repository vs. Runtime Separation
- **Source Repository:** a local checkout such as `~/src/bot-factory` or `C:\Users\<you>\source\repos\bot-factory` (clean workspace with zero runtime DB files).
- **Runtime Data (`BOT_FACTORY_ROOT`, default `~/bot-factory`):**
  - `system/state.db` (WAL + FTS5 + single-writer PID lock + `runtime_epoch`)
  - `system/config.json` & `system/secrets.env` (write-only secrets via Settings UI or file; never echoed over API)
  - `system/plugins/*/plugin.md` & `system/staging/` & `system/backups/`
  - `projects/<slug>/` (`project.json`, `MEMORY.md`, `plans/`, `artifacts/`, `handoffs/`, `worktrees/`)
- Isolated development uses `BOT_FACTORY_ROOT=.dev-runtime` (`bun run dev:daemon:isolated`).

### Hybrid Open BYOS Runtime & Parallel Outbox
- **Lane-Partitioned `CommandCore`:**
  - **Control Lane (immediate out-of-band):** `bot.abort` (`pause`/`hard_stop`) and `permission.respond` preempt active turns without head-of-line blocking.
  - **Interactive Lane:** `meta.chat.turn`, `meta.team_report`, `pm.steer.turn`, `pm.goal.turn`.
  - **Bounded Parallel Work Pool:** `task.run`, `subagent.run`, `task.verify.run`, `selfmod.verify.run`, `debate.escalate.pm` run concurrently up to `maxConcurrentEffects` while serialized per `agentId`.
- **Open BYOS Providers:** No hardcoded model roster lock. Supports any `openai_compatible` (Mistral, OpenAI, Ollama, custom), `google_gemini`, or `anthropic` HTTP endpoint (SSE streaming + multi-step tool loop), plus `acp_stdio` (`devin acp`, `opencode acp`) and `cli_stream` (`claude`, `codex`) coding adapters.

### Progressive 4-Tier Autonomy & Security Boundary
- **4-Tier Autonomy (`spec` / `low` / `medium` / `high`):**
  - `spec`: Read-only / planning only; writes and shell require explicit escalation.
  - `low`: Pause for human Allow/Deny on writes and shell execution.
  - `medium`: Auto-approve in-worktree file edits & safe verification commands; pause on destructive, network, or out-of-worktree ops.
  - `high`: Auto-approve inside isolated worktree while hard-blocking secrets/systemDir access and destructive host escapes; pause on out-of-worktree ops.
  - Escalated ACP/CLI permissions suspend on a bounded `120s` Promise resolved via `permission.respond` (`allow_once` | `allow_session` | `deny`).
- **Localhost Defense-in-Depth:**
  - `127.0.0.1` bind only + Origin check + `HttpOnly; SameSite=Strict` `bf_session` cookie / `x-bf-token` authentication on `/ws` and `/api/*`.
  - Per-agent scoped MCP tokens bound server-side to `{ projectId, agentId, sessionId }` (zero spoofable body identity).
  - `serveStaticUi` strict root containment (blocking Windows cross-drive paths), `lstatSync` symlink-escape protection, expanded sensitive-file denylist, and `Content-Security-Policy: sandbox` + `X-Content-Type-Options: nosniff` on served artifacts.

---

## 3. UI Specification (Strictly Light Mode, English, Phase 3.3)

### Navigation Shell (Dual-Layer Devin / Codex Sidebar)
- **Far-Left 44px Icon Rail (`#FAFAFA`):**
  - Top mode switchers using bespoke SVGs: **Main Agent** (Aperture mark) and **Bots** (3-Node Factory Lattice mark + active count badge).
  - Drawer toggle (`Ctrl+B`), Search (`Ctrl+K` across Bots, Subagents, Projects, Artifacts, Repo Files), Escalation Inbox bell with badge, Settings gear, and bottom monochrome dotted `Smoke & Pearl` Thinking Orb.
- **Collapsible 248px Contextual Drawer (`#FAFAFA`):**
  - **Main Agent Context:** `+ New Project` (create or attach existing local Git repo), `Projects`, `Engineering Teams` status rows, `Memory` (`USER.md` / `GLOBAL_MEMORY.md` / `MEMORY.md` + L2 facts count), and `Browser Files` (artifacts, repo files, Git Diff).
  - **Bots Context:** **Pinned Bots** 3-tile grid, active project **`Group Chat`** room, individual bots with Low-Poly Orange Beaver avatars and **collapsible indented Subagents** (`readonly` / `code` + branch), and bottom **Workspace** views (`Task Board`, `Checkpoints & Merge`, `Debates`, `Self-Mod`).

### Main Agent Page (Devin / Codex Aesthetic)
- **Calm Stream (`#FFFFFF`):** Editorial Markdown rendering (headings, code blocks, tables, links), incremental token streaming, subtle `Memory recalled` chips, compact **Delegation Cards**, proactive **Team Lead Briefings**, and **Verified Delivery Cards** with `Review Diff` and `Merge to main` actions.
- **Double-Deck Floating Composer:**
  - Snuggled top Diff Tray (`N files changed +X -Y | View diff | ×`) when uncommitted worktree changes exist.
  - White composer card (`1px solid #E2E2E2`, `16px` radius): `+` quick actions, `/` keyboard-navigable slash menu, 3-bar `Autonomy` selector, live `Model` selector (from `bf.providers`), compact **`Effort · High`** pill opening the tactile 4-stop burnt-orange (`#D95D22`) slider popover (`Low / Medium / High / Max`), circular Context/Memory Ring gauge, and `↑` Send button.

### Bots Page (Grok-Bot Multi-Side Group Chat)
- **Default Landing View:** `Core Team · Group Chat` with physically separated explicit `Pause`, `Resume`, and `Stop` controls in the header.
- **Multi-Side Alignment:** **Operator (`You`)** and **Team Lead (`PM`)** align right; **Specialist Engineering Bots** and **Independent Verifier** align left.
- **Rich Group Chat Primitives:** Circular Low-Poly Orange Beaver / role avatars, reply-quote bars (`↳ Team Lead: ...`), clickable `@Bot` chips, collapsible tool-call & subagent merge trace pills, embedded clickable artifact/diff preview cards, and a **Steer → Team Lead** composer.
- Clicking any individual bot or nested subagent in the drawer opens its focused stream while keeping Group Chat one click away.

### Built-In Browser (Strict Compact 2-Row Chrome)
Shared collapsible, resizable right pane (with full-width expand toggle):
- **Row 1 (Tab Bar):** Open tabs + `+` Quick-Open popover + `Annotate` toggle + `Pins (N)` review popover + Expand/Close.
- **Row 2 (Navigation Bar):** `←` `→` `↻` + breadcrumb/URL omnibox + viewer-specific controls (`75% / 100% / Fit` zoom, `Iso / Front / Top / Wire` 3D camera presets).
- **6 Viewers:**
  1. **Docs:** Rich editorial Markdown + paragraph click-to-pin annotations.
  2. **Images:** Studio dot-grid canvas, zoom & pan, `%`-based pins & drag-rectangle regions (always scaling cleanly on resize), optional comment-only vs immediate fix dispatch.
  3. **3D Models:** Lazy-loaded, render-on-demand Three.js Light-Museum stage (`#F5F5F5` grid), `Iso/Front/Top/Wire`, raycast 3D surface pins with camera-pose restoration and PNG snapshot thumbnails.
  4. **Code:** Line-numbered syntax-tinted file viewer with copy and security filtering.
  5. **Live Git Diff:** Async collapsible unified patches (`+X -Y`) scoped to repo or active bot worktree.
  6. **Loopback Web:** Sandboxed `127.0.0.1` / `localhost` preview iframe with self-embed loop protection.

### Escalation Inbox & Wave 4 Studio Surfaces
- **Escalation Inbox Popover:** Top-right bell/badge showing interactive ACP Allow/Deny requests (with command preview + live countdown), `session.resolve_unknown` crash-recovery cards, and PM conflict escalations — mirrored quietly in Main Agent Chat.
- **Settings & Write-Only Secrets View:** Manage Open BYOS providers/models, per-project routing overrides, verification check commands, guardrails, and write-only API keys (`system/secrets.env` — status + Test Connection, zero read-back).
- **Checkpoints & Merge Panel:** Per-task/bot hidden checkpoint list, one-click Rollback, and human-approved `task.merge` (`Squash` / `Merge Commit`) gated by Verifier `PASS`.
- **Memory L1 Studio:** Char-gauge Markdown editors for `USER.md`, `GLOBAL_MEMORY.md`, and project `MEMORY.md`, manual compaction trigger, and searchable read-only L2 facts table.
