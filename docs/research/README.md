# Bot-Factory Phase 0 — Clean-Room Reference Research Index

**Status:** Phase 0 Complete (Reference-Guided, Clean-Room — keine Code-Kopien)  
**Ziel-Stack:** Bun (v1.4+) · TypeScript · SQLite (WAL + FTS5) · React/Vite/Tailwind · Hybrid BYOS (Native HTTP + ACP/CLI)

## Dokumente
1. [`t3code.md`](./t3code.md) — Control-Plane-Ownership, Command/Event/Outbox-Transaktionen, BYOS-Adapter, Workspace-scoped Git-Worktree-Checkpoints & Scoped WebSocket Subscriptions.
2. [`hermes.md`](./hermes.md) — 3-Tier Frozen System-Prompt Caching, ephemerer Turn-Kontext, Single-Writer SQLite (`runtime_epoch`, `session_admissions`, detachierbares FTS5), In-Place Compaction & L1-Markdown-Memory.
3. [`supermemory.md`](./supermemory.md) — Documents vs. Atomic Memories, temporaler Fact-Graph (`UPDATES`/`EXTENDS`/`DERIVES`), Soft-Forget/Decay, Zero-LLM SQL-Profile & debounced Async-Dreaming auf GLM 5.3 Flash.
4. [`devin-ux.md`](./devin-ux.md) — Zwei-Welten-UI (`Chat` vs. `Bots`), Live-Watch-Timeline, Steer-vs-Hard-Stop-Trennung, ACP JSON-RPC stdio Lifecycle, Permission-Policy, lokaler MCP-Bridge & Annotatable Previews (Doc/Image/3D).

## Verifizierte lokale Runtime- & Modell-Basis (Host-Audit)
Beim Phase-0-Bootstrap auf dem lokalen Windows-Hub geprüft:
- **Runtimes:** `bun 1.4.3`, `node v22.14.0`, `git 2.49.0`, `python 3.14.2`, `uv`
- **Lokale ACP-fähige Agent-CLIs:**
  - `devin acp` → verifizierte Modell-ID: `swe-2-max` (`SWE-2 Max`, 262K Context)
  - `opencode acp` → verifizierte Modell-IDs: `opencode/mistral-large-4`, `opencode-go/glm-5.3`, `opencode-go/glm-5.3-flash`, `google/gemini-4-hydrogen`, `google/gemini-4-neon`
- **Direkte HTTP-APIs (NativeHttpRuntime):** Mistral hosted (`Mistral Large 4`, `GLM 5.3`, `GLM 5.3 Flash`) und Google AI / Antigravity (`gemini-4-hydrogen`, `gemini-4-neon`).

## Top-10-Architektur-Invarianten für Phase 1–3 (Synthese)
1. **Single Writer + 1-TX-Atomarität (T3 + Hermes):** Nur der Daemon schreibt `state.db` (WAL). Jeder Command committet `events + projections + command_receipt + outbox_effects` in einer SQLite-Transaktion ohne I/O; jeder Write prüft `runtime_epoch`.
2. **Kein blindes Crash-Replay (T3 + Hermes):** Ein `started`-Turn eines gestorbenen Prozesses wird als `unknown`/retired markiert und blockiert Nachfolger bis zur expliziten Auflösung — niemals blind wiederholen.
3. **Frozen System-Prompt & CWD-Ordering (Hermes):** `stable → context (cwd-frei zuerst!) → volatile`. System-Prompt einmal je Session bauen, hashen, einfrieren. Per-Turn-Recall nur ephemer an den aktuellen User-Turn hängen.
4. **In-Place Compaction statt ID-Rotation (Hermes):** Stabile `session_id` behalten, alte Turns soft-archivieren (`active=0, compacted=1`), neuen System-Prompt-Block einfrieren.
5. **FTS5 ist abgeleitet & abkoppelbar (Hermes):** Kanonische Writes dürfen niemals an einem defekten FTS5-Index scheitern; bei Korruption Trigger lösen + `LIKE`-Fallback, niemals Live-`rebuild`.
6. **Workspace-scoped Hidden Checkpoints (T3):** Git-Checkpoints als versteckte Refs (`refs/bot-factory/checkpoints/...`) mit Scope `(agent/thread, cwd)`. Cross-Worktree-Restore strikt verweigern.
7. **Live-Memory-Prädikat zentralisieren (Supermemory):** `namespace = ? AND is_latest = 1 AND is_forgotten = 0 AND (forget_after IS NULL OR forget_after > now)` gilt einheitlich für FTS, Graph-Traversal und Profil.
8. **Zero-LLM Read-Path & Debounced Dreaming (Supermemory + Hermes):** Profil-Abruf ist reines SQL; `queue_prefetch()` wärmt im Hintergrund vor; Fact-Extraktion läuft asynchron im Batch auf `GLM 5.3 Flash`.
9. **Zwei Projektionen aus einem Event-Stream (T3 + Devin UX):** Ein per-Session-Reducer erzeugt `timeline[]` (dense, Bots-Tab) und `sessionStatus/inbox` (quiet, Chat-Tab). Der Chat-Tab abonniert niemals rohe Tool-Chunks.
10. **Normalisierte / 3D-Kamera-verankerte Annotationen (Devin/Preview UX):** Docs über Block-ID + Content-Hash (nie Zeilennummern), Bilder `0..1` normalisiert, 3D über World-Point + Normal + Camera-Pose; Navigate- und Annotate-Modus strikt trennen.
