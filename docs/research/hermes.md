# Reference Research: Nous Research Hermes Agent

**Modus:** Clean-Room Pattern Extraction (keine Code-Kopien)  
**Quellen:** Öffentliche Developer- & User-Guides (`hermes-agent.nousresearch.com`: Prompt Assembly, Session Storage, Agent Loop, State DB Recovery, Memory Provider Plugin).

---

## 1. 3-Tier Frozen System Prompt (Prefix-Caching-Invariante)
Der System-Prompt wird genau **einmal bei Session-Start** deterministisch aus drei Ebenen zusammengesetzt:

1. **`stable`:** Agent-Identität/Rolle, Tool-Definitionen, Grundregeln.
2. **`context`:** Projekt-Kontextdateien (`AGENTS.md`, Projekt-Spezifikation) — **alle `cwd`-unabhängigen Inhalte strikt vor worktree-spezifischen Pfaden!**  
   *Caching-Vorteil:* Mehrere parallele Peer-Bots in verschiedenen Git-Worktrees desselben Projekts teilen sich denselben cachebaren Provider-Prefix.
3. **`volatile`:** Skills-Index, eingefrorener `MEMORY.md`- & `USER.md`-Snapshot, statischer Block externer Memory-Provider, Session-/Modell-Header und Laufzeit-Pfade **ganz am Ende**.

### Frozen System-Prompt Invariant
- Nach Erstellung wird der fertige System-Prompt gehasht (`system_prompt_hash`), byte-identisch an der Session gespeichert und **während der gesamten Session nie mehr verändert**.
- Mid-Session-Schreibvorgänge in `MEMORY.md` / `USER.md` landen sofort auf Disk, werden aber erst in der nächsten Session (oder nach Compaction) in den System-Prompt aufgenommen.
- Plugin-Prompt-Blöcke sind strikt gedeckelt (z. B. ≤4.000 Zeichen pro Block, ≤8.000 Zeichen gesamt), deterministisch nach ID sortiert und bleiben über Resume hinweg eingefroren.

## 2. Ephemere Per-Turn-Injektion & Boundary Scrubbing
- Dynamischer Kontext pro Turn (Memory-`prefetch()`, Steer-Hinweise, Task-Board-Deltas, Budget-Warnungen) wird **erst beim API-Call temporär an die letzte User-Nachricht angehängt**.
- Die persistierte User-Nachricht in `messages` bleibt unverändert → der gesamte vorherige Prefix bleibt byte-identisch (hohe Prompt-Cache-Hitrate) und die Session-Historie wird nicht mit transienten Blöcken zugemüllt.
- **Non-Blocking Prefetch:** `queue_prefetch()` startet am Ende von Turn `N` im Hintergrund und füllt einen kleinen Cache; `prefetch()` in Turn `N+1` liest nur aus dem Cache — kein Turn wartet jemals auf Memory-I/O.
- **Fail-Open & Secret-Scrubbing:** Fehlerhafte/langsame Memory- oder Plugin-Hooks werden übersprungen (nie Session-Abbruch). Alle Daten an externe Provider oder Memory-Backends durchlaufen einen zentralen Secret-Scrubber (Redaction von Keys/Tokens aus `secrets.env`).

## 3. Single-Writer SQLite (`state.db` — WAL + FTS5)
- **Ein kanonischer Writer (der Daemon):** UI, CLI und ACP-Bots schreiben niemals direkt in `state.db`, sondern ausschließlich über Daemon-RPC oder den lokalen MCP-Bridge.
- **Zentrale Sicherheits- & Recovery-Tabellen:**
  - `runtime_epoch` (1 Zeile): Beim Daemon-Start geladen (abgesichert durch Prozess-Lockfile). **Jeder Schreibvorgang** prüft den aktuellen Epoch → verhindert Split-Brain durch veraltete Prozesse.
  - `session_admissions` (durabler per-Session-FIFO): Zustände `queued → started → terminal | unknown`. Stirbt der Daemon während eines `started`-Turns, wird dieser beim Neustart als **`unknown`** markiert — **niemals automatisch wiederholt** — und blockiert nachfolgende Eingaben bis zur expliziten Auflösung (`resolve_unknown` mit `execution_generation`).
  - `delivery_obligations` (Outbox): Ehrliches At-least-once. Starb ein Versand vor Start → normal erneut senden; starb er mitten im Versand → nur mit sichtbarem Hinweis *„may be duplicate“* (max. 3 Versuche, 24h-Fenster).
- **FTS5-Fehlerisolierung (sehr wichtig):**
  - FTS5-Tabellen (`messages_fts`) sind **abgeleitete Indizes**, niemals Quelle der Wahrheit.
  - Tritt ein FTS-Korruptionsfehler auf: Flag `fts_stale` setzen, Sync-Trigger in derselben Transaktion droppen, kanonischen Write ohne FTS wiederholen und Suche temporär über `LIKE` bedienen.
  - **Niemals `INSERT INTO ... VALUES('rebuild')` im Live-Schreibpfad ausführen** — Rebuild nur kontrolliert beim Daemon-Start unter exklusivem Lock.
  - Bei echter Hauptdatei-Korruption (`SQLITE_CORRUPT`): Handle sofort unter Quarantäne stellen, weitere Writes fail-fast ablehnen, WAL-Checkpoint beim Close überspringen.

## 4. In-Place Compaction & Session-Lineage
- **Standard = In-Place Compaction:** Die `session_id` bleibt stabil! Mittlere Turns werden zusammengefasst, alte Rohturns soft-archiviert (`active = 0, compacted = 1` — weiterhin über FTS5 durchsuchbar, nie gelöscht), und der System-Prompt wird kontrolliert neu eingefroren.
  - Vermeidet verwaiste Sessions, gebrochene UI-Links und Suchlücken über Compaction-Grenzen hinweg.
- `compression_locks` verhindert parallele Compaction derselben Session; Transcript, neue Generation und Receipt committen in einer Transaktion.
- Vor der Compaction feuert `on_pre_compress`, damit der Memory-Provider wichtige Fakten sichern kann, bevor Rohtext komprimiert wird.

## 5. L1 Markdown-Memory & `MemoryProvider`-Vertrag
- Menschenlesbare Dateien unter `~/bot-factory/system/memory/` (`USER.md`, `GLOBAL_MEMORY.md`) und `projects/<slug>/MEMORY.md`.
- **Harte Kapazitätsgrenze mit Gauge-Header** (z. B. `[67% — 1,474/2,200 chars]`): Überlaufende Writes werden mit klarem Fehler abgewiesen → Agent muss im selben Turn konsolidieren statt unbegrenzt anzuhängen.
- **Sauberes TypeScript-Interface (`MemoryProvider`):**
  - `isAvailable(): boolean` (strikt ohne Netzwerk-Call)
  - `initialize(sessionId)`
  - `systemPromptBlock(scope)` (statisch für L0/volatile Tier)
  - `queuePrefetch(scope, hint)` / `prefetch(scope)` (non-blocking Cache-Read)
  - `syncTurn(sessionId, userMsg, assistantMsg)`
  - `onPreCompress(sessionId, messages)` / `onSessionEnd(sessionId)`

## Top-5-Fallstricke (Vermeidungsregeln für Bot-Factory)
1. **System-Prompt mid-session mutieren** (z. B. aktuelle Uhrzeit, laufende Task-Counts, neue Memory-Einträge) → zerstört Prefix-Caching (~75% Einsparung verloren).
2. **Abgebrochene `started`-Turns nach Crash blind neu ausführen** → doppelte Tool-Nebenwirkungen; immer als `unknown` markieren und FIFO sperren.
3. **FTS5-`rebuild` im Live-Pfad** → blockiert den Daemon minutenlang; stattdessen Trigger abkoppeln + `LIKE`-Fallback.
4. **Zwei Prozesse schreiben gleichzeitig in DB oder `MEMORY.md`** → `runtime_epoch` + Lockfile erzwingen Single-Writer.
5. **Synchrone Memory-Latenz im Turn-Pfad** → `prefetch()` liest nur vorgewärmten Cache; Fehler in Memory-Hooks sind immer fail-open.
