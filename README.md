# Bot-Factory Harness

> **Local-First Multi-Agent Orchestration Control Plane & Light-Mode Studio**
> Bun · TypeScript · SQLite (WAL + FTS5) · React 19 + Vite · Three.js · Hybrid BYOS (Native HTTP + ACP stdio + MCP Bridge)

**Bot-Factory** is a local-first operating hub for running, steering, auditing, and reviewing autonomous AI coding & creative bot teams on your own machine — without drowning the human operator in raw tool-call log spam.

---

## 1. Concept & Core Idea

Multi-agent coding tools usually fail in one of two ways: either they stay single-threaded (too slow for parallel work), or they unleash 5 agents at once and overwhelm the human with noisy terminal streams, colliding file edits, prompt-cache thrashing, and unverified self-edits.

**Bot-Factory solves this through six foundational architectural ideas** (synthesized clean-room from [T3 Code](./docs/research/t3code.md), [Hermes Agent](./docs/research/hermes.md), [Supermemory](./docs/research/supermemory.md), and [Devin Control Plane UX](./docs/research/devin-ux.md)):

1. **Two-Worlds UX (`Agent Chat` vs. `Bot-Teams`)**
   - **World 1 — Agent Chat (Quiet Strategic Channel):** Calm 1-on-1 conversation with the **Meta-Orchestrator**. Consumes only a quiet projection (messages, inline preview cards, aggregated counts, escalations). *Never* receives raw background tool chunks.
   - **World 2 — Bot-Teams (High-Density Group Chat & Control Plane):** Project-scoped team rooms + individual Low-Poly Orange Beaver bot views (`Team lead`, `Builder`, `3D Artist`, `Research`, `Verifier`) with alternating group-chat lanes, quietly collapsed tool traces, a 5-column Task-Board, Conflict Debates, Cross-Family Verifier, and Self-Mod Sandbox.
   - **Strict Transport Separation:** Course corrections go through the **Steer → PM** composer; hard transport controls (**Pause** / **Hard Stop**) are physically separated in the top header and never disguised as chat messages.

2. **Local Control Plane & Single-Writer Event-Sourcing (`state.db`)**
   - *“The client shows the work; the environment performs the work.”*
   - Only the local Bun daemon (`127.0.0.1`) mutates SQLite (`WAL` + `FTS5`). Every `RpcCommand` commits `{events, projections, command_receipt, outbox_effects}` in **one atomic transaction** with zero I/O inside the decider, guarded by a monotonic `runtime_epoch` and PID lockfile.
   - Crash recovery never blindly replays interrupted turns: any `started` turn from a dead epoch becomes `unknown` and blocks subsequent admissions until explicitly resolved.

3. **Hybrid BYOS Runtime (Native HTTP + External ACP CLIs + Local MCP Bridge)**
   - Run direct HTTP models (`Mistral Large 4`, `GLM 5.3`, `GLM 5.3 Flash`, `Gemini 4 Hydrogen/Neon`) alongside local **ACP JSON-RPC stdio** agent CLIs (`devin acp`, `opencode acp`) behind one normalized event stream.
   - External ACP bots receive an injected local **MCP Bridge** (`bf_task_*`, `bf_handoff_write`, `bf_debate_post`, `bf_memory_search`, `bf_fix_tasks_*`) so every agent — internal or external — speaks the same structured coordination protocol.

4. **Workspace-Scoped Git Worktrees & Hidden Checkpoints**
   - Every parallel peer bot operates in its own isolated Git worktree (`worktrees/<short-id>/` on a `bf/*` branch).
   - Per-turn snapshots are stored as hidden Git refs (`refs/bot-factory/checkpoints/<sha1(scope)>/<turn>`) keyed by `root:{agentId}:{normalizedCwd}` so restores can never corrupt another worktree.

5. **3-Tier Frozen System Prompt + Layered Memory (`L1` / `L2` / `L3`)**
   - System prompts are assembled once per session (`stable → cwd-free context → volatile`), hashed, and frozen to maximize provider prefix-cache hits across parallel worktrees.
   - Human-readable **L1 Markdown** (`USER.md`, `GLOBAL_MEMORY.md`, `MEMORY.md` with hard char caps) sits above a **Supermemory-style L2 Temporal Fact Graph** (`updates` / `extends` / `derives`, soft-forget decay, `live_memory_facts` SQL view) and **L3 FTS5 Documents/Chunks**.

6. **Native 2-Row Tabbed In-App Browser & Annotation-to-Fix Loop**
   - Split-view right-hand browser with 6 full-bleed viewers: **Rendered Markdown Plans**, **Images/SVGs** (normalized `0..1` pins & drag-rectangles), **Three.js Light Museum 3D Studio** (`.glb`/`.gltf` with auto-framing, raycast pins, saved camera poses & PNG snapshots), **Live Code**, **Live Git Diff**, and **Loopback-Only Sandboxed Web**.
   - Dropping an annotation on a Doc, Image, or 3D model automatically spawns a linked `FixTask` (routed to coding or vision-fix models) with a retry cap before human escalation.

7. **Phase-3 Governance (Conflict Debates, Fresh Cross-Family Verifier, Sandboxed Self-Mod)**
   - **Conflict Debates:** Strictly capped at 3 rounds before automatic escalation to the Project Manager.
   - **Independent Verifier:** Runs in a fresh, ephemeral session with **zero author history**, **zero L1/project memory**, and a **different model provider family** (`excludeProvider`) using fail-closed verdict parsing (`PASS` / `FAIL` / `NEEDS_HUMAN`).
   - **Self-Mod Sandbox:** Plugins and config patches are staged under `system/staging/`, SHA-256 integrity-checked (TOCTOU-safe single read), secret-scanned, verifier-gated, backed up before atomic promotion, and support one-click rollback.

---

## 2. Repository Structure

```text
bot-factory/
├── AGENTS.md                   # AI-Agent engineering guide, invariants, commands & gotchas
├── HANDOFF.md                  # Brutally honest Product Goal vs. Current UI gap matrix & Wave 3 roadmap
├── DESIGN.md                   # Monochrome Ink Light-Mode design system + Smoke & Pearl Thinking Orbs
├── config.example.json         # Reference HubConfig (providers, routing intents, memory, guardrails)
├── secrets.env.example         # Placeholder env vars for live remote model API keys
├── docs/research/              # Phase-0 clean-room architecture specs (T3, Hermes, Supermemory, Devin UX)
├── packages/
│   └── shared/src/index.ts     # Shared Zod schemas, RpcCommand, WsServerMessage, entity & config types
├── apps/
│   ├── daemon/src/             # Local control plane (Bun.serve HTTP/WS, SQLite, Outbox, Worktrees, Memory, ACP, MCP, Phase 3)
│   └── web/src/                # React 19 + Vite UI (Dual-Rail Shell, Group Chat, Precision Composer, In-App Browser)
├── tests/                      # 25 automated integration & security tests (242 assertions)
└── variants/                   # Archived Gen-1 (20) & Gen-2 (4) Light-Mode HTML design prototypes
```

---

## 3. Current Implementation Status

| Pillar | Daemon Backend | Current Web UI (E2E) | Summary |
|---|---:|---:|---|
| **Annotatable Previews & In-App Browser** | **95%** | **85%** | All 6 viewers live (Doc, Image/SVG, 3D GLB, Code, Diff, Web) + end-to-end pin/rect/3D annotations |
| **Phase-3 Governance** | **90%** | **75%** | Debates, Fresh Cross-Family Verifier & Self-Mod Stage→Verify→Promote→Rollback wired end-to-end |
| **Two-Worlds UI & Chat Isolation** | **90%** | **70%** | Dual-rail shell, Low-Poly Beaver avatars, Burnt-Orange bubbles & quiet traces live; `inboxNotices` not yet rendered |
| **Project & Task Orchestration** | **75%** | **45%** | Worktree provisioning & task dispatch work; UI still lacks custom project/repo modal & rich task spec/assignee editor |
| **Bot Fleet, BYOS & Model Routing** | **80%** | **25%** | Native HTTP + ACP + MCP work in daemon; UI lacks `bot.resume`, provider/model picker & daemon-side `Aufwand`/`Autonomie` wiring |
| **Checkpoints & Scoped Rollback** | **65%** | **10%** | Per-turn hidden Git refs + `restoreCheckpoint()` exist in daemon; rollback RPC & UI timeline missing |
| **Escalations & Crash Recovery** | **75%** | **5%** | `session.resolve_unknown` & ACP permission escalation exist in daemon; UI needs inbox panel, recovery & live human approve/deny |
| **Memory, Fact-Graph & Compaction** | **65%** | **0%** | L1/L2/L3 SQLite engine exists; LLM dreaming, compaction trigger & Memory UI studio not yet wired |
| **Onboarding, Settings & Secrets** | **50%** | **0%** | Config & `secrets.env` work on disk; no Settings/API-key UI yet |

See **[HANDOFF.md](./HANDOFF.md)** for the complete file-and-line gap analysis and prioritized **Wave 3** engineering roadmap.

---

## 4. Quick Start (Local Hub)

### Prerequisites
- [Bun](https://bun.sh/) `v1.4+`
- `git` `2.40+`
- Optional local ACP CLIs: `devin acp`, `opencode acp`

### Install, Test & Build
```bash
bun install
bun run typecheck
bun test tests
bun run build:web
```

### Configure Live Model Keys (Optional)
Without API keys, the daemon runs deterministically in **local simulation mode** (`local-sim`) so you can test the entire UI, worktrees, previews, debates, verifier, and self-mod offline.

For live remote model calls, copy `secrets.env.example` to `~/bot-factory/system/secrets.env` and set your keys (`MISTRAL_API_KEY`, `GEMINI_API_KEY`).

### Run
```bash
# Production single-port mode (Daemon serves built Web UI at http://127.0.0.1:4310)
bun run build:web
bun run start

# Development mode (Daemon watch on :4310 + Vite HMR on :5173)
bun run dev:daemon
bun run dev:web
```

---

## 5. For AI Agents Taking Over This Repo

**Start by reading [`AGENTS.md`](./AGENTS.md) and [`HANDOFF.md`](./HANDOFF.md).**
They contain every non-negotiable invariant, exact entry points, verification commands, protocol contracts, and known footguns so you can immediately implement Wave 3 without breaking security boundaries or rediscovering architecture decisions.
