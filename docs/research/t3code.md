# Reference Research: T3 Code (`pingdotgg/t3code`)

**Modus:** Clean-Room Pattern Extraction (keine Code-Kopien)  
**Quellen:** Öffentliche Architektur-Docs (`AGENTS.md`, `docs/internals/overview.md`, `docs/internals/remote.md`), öffentliche PR-Analysen.

---

## 1. Control-Plane-Ownership & Remote-Boundary
- **Leitprinzip:** *„The client shows the work; the environment performs the work.“*
- Ein **Environment** ist ein laufender Server plus die Maschine, das Dateisystem, Git, Terminals, Provider-Prozesse und Credentials, die er besitzt.
- Selbst eine lokale Desktop-UI spricht über dieselbe typisierte, authentifizierte WebSocket-RPC-Grenze wie ein Remote-Client — kein Client greift direkt auf Dateien, Secrets oder Provider-Prozesse zu.
- **Authentifizierung ≠ Autorisierung:** Ein authentifizierter Socket autorisiert nicht pauschal jede RPC-Methode; sensible Methoden werden explizit geprüft.
- **Stabile Environment-ID (relevant ab Phase 4):** Identität ist unabhängig vom Transportweg (LAN, Tailscale, SSH, Relay). Niemals still auf `localhost` zurückfallen; gespeicherte Remote-Endpunkte vor Credential-Versand gegen einen öffentlichen Descriptor verifizieren.
- **Settings-Trennung:** UI-Präferenzen liegen beim Client; Provider-Defaults und Projekt-Overrides liegen beim Daemon.

## 2. Command → Event → Projection → Outbox-Pattern
Transaktionale Event-Sourcing-Pipeline für nebenläufige Multi-Bot-Steuerung:

```text
Typed RPC Command → serialisierte Command-Queue
  → Pure Decider (0 I/O!) erzeugt Domain-Events
  → EventSink committet {events + projections + command_receipt + outbox_effects} in 1 SQLite-TX
  → Post-Commit Notifier pusht an Scoped WS-Subscriber
  → EffectWorker arbeitet Outbox asynchron ab (Provider I/O, Git Checkpoints)
  → Ergebnisse kommen als neue Commands zurück
```

### Verbindliche Invarianten
- **Pure Decider:** Entscheidungslogik führt weder Dateisystem- noch Netzwerk-I/O aus.
- **Idempotenz über Receipts:** Vor Ausführung prüft der Core `command_receipt` — Client-Retries sind sichere No-Ops.
- **ACK ≠ Fertig:** Eine Command-Antwort bestätigt nur den durablen Intent, nicht das Ende eines Bot-Turns.
- **Zwei getrennte Meilensteine:** „Turn beendet“ (Session verlässt `running`) ist getrennt von „Checkpoint/Diff fertig“. Langsame Git-Diffs dürfen die UI nicht fälschlich weiter als „Bot arbeitet“ zeigen.
- **Crash-Recovery für verlorene Provider-Prozesse:** Outbox-Effects eines toten Subprozesses dürfen niemals blind auf einer neuen Session wiederholt werden. Recovery überführt verwaiste Runs über einen atomaren Status-Guard in `interrupted`/`cancelled`, verschiebt fehlgeschlagene Effects nach gedeckeltem Backoff (~30s Cap) in `dead_letter` und weckt den Agenten höchstens einmal idempotent. Bewusste Stops setzen vorher `stopping`, damit sie nicht als Absturz gewertet werden.

## 3. BYOS Provider Adapter Model
- Provider laufen als isolierte Subprozesse; pro Runtime übersetzt ein dünner Adapter das native Protokoll (ACP, CLI NDJSON, SDK, HTTP Stream) in **normalisierte Orchestration-Events**.
- **Domain-Isolation:** Orchestrator, Task-Board und UI kennen nur normalisierte Events — neue Provider erfordern keine `if (provider === ...)`-Verzweigungen im Kern oder Frontend.
- **Provider-Instanzen statt nur Provider-Typen:** Mehrere Profile/Accounts pro Provider sind First-Class (`config.json` referenziert benannte Provider-Instanzen).
- **Revert-Kopplung:** Kann ein Provider seinen Konversationszustand nicht zurückrollen, lehnt er ein Revert ab, *bevor* Dateien im Worktree verändert werden.

## 4. Git Worktrees & Hidden-Ref Checkpoints
- Jeder parallele Peer-Bot arbeitet in einem eigenen Git-Worktree (`~/bot-factory/projects/<slug>/worktrees/<short-id>/`).
- **Versteckte Checkpoints:** Pro Turn werden versteckte Refs angelegt (`refs/bot-factory/checkpoints/<scope>/<turn>`), niemals sichtbare User-Commits.
  - Ref `0` = Pre-Turn-Baseline (lazy bei `turn.started`, falls noch nicht vorhanden).
  - Ref `N` = Snapshot bei Turn-Ende; Untracked Files werden über Index-Plumbing (`git write-tree` / `git commit-tree` / `git update-ref`) erfasst, ohne den Working Tree zu verändern.
- **Kritische Regel (Workspace-Scope statt Thread-Scope):** Alle Worktrees eines Repos teilen sich denselben `refs/`-Namensraum. Der Checkpoint-Scope-Key **muss** `root:{threadOrBotId}:{normalizedCwd}` sein!
  - Ein Restore auf einen Checkpoint aus einem anderen Worktree wird hart verweigert (verhindert Datenverlust durch Überschreiben branch-eigener Dateien).
  - Beim Rollback werden nachfolgende Checkpoints über alle Scopes bereinigt und Refs gelöscht, damit ein neu erzeugtes Worktree nie eine veraltete Baseline erbt.

## 5. Typed WebSocket RPC & Scoped Subscriptions
- Ein WebSocket mit typisiertem RPC-Contract (shared Zod/TS-Schemas in `packages/shared`).
- **Refcounted Scoped Subscriptions:** Clients abonnieren gezielt `global:status`, `chat:meta` oder `bot:<id>:timeline`. Endet die letzte Ansicht eines Bots, endet das Streaming-Abo automatisch.
- **User-Anchored Windowing:** Bei langen Subagent-/Tool-Bursts nicht naiv „letzte N Events“ abschneiden, sondern die letzten ~10 *User-/Steer-Turns* (mit Hard-Cap ~150 Raw-Events) + Cursor-Pagination liefern.
- **Reconnect-Resync:** Kurze Lücken (≤1.000 Events) per Replay schließen; größere Lücken mit frischem Projection-Snapshot ersetzen (Live-Updates vorher coalescen).

## Top-5-Fallstricke (Vermeidungsregeln für Bot-Factory)
1. **Thread-statt-Workspace-Key für Git-Checkpoints** → Phantom-Diffs und Datenverlust über Worktrees hinweg. Immer `(botId, cwd)` als Scope-Key.
2. **ACK mit Turn-Ende verwechseln** → Run-Status und Checkpoint-Finalisierung als getrennte Events modellieren.
3. **Outbox-Replay auf totem Subprozess** → Verwaiste Effects über `runtime_epoch` + Status-Guard retiren, nie gegen neue PID abspielen.
4. **Unbegrenztes Full-History-Streaming** → Immer Scoped Subscriptions + User-Anchored Windows + Snapshot-Reset bei großer Reconnect-Lücke.
5. **Direkte I/O im Command-Handler** → Jede Nebenwirkung läuft strikt über die post-commit Outbox.

## Schlanke Bun-Adaption (Anti-Bloat)
- Kein schweres Framework (kein Effect-TS, kein Broker): `bun:sqlite` (WAL) mit `events`, `command_receipts`, `outbox_effects` + reine `decide(state, cmd): Event[]`-Funktion + serialisierte per-Entity-Queue.
- `Bun.serve` (HTTP Static + WebSocket) mit schlanken Zod-Contracts aus `packages/shared`.
- Git-Checkpoints via `Bun.spawn(["git", ...])` auf Hidden Refs; Phase 1 startet strikt lokal (Multi-Environment-Routing erst in Phase 4).
