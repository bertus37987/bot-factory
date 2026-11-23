# Reference Research: Devin Control Plane UX, ACP & Annotatable Previews

**Modus:** Clean-Room Pattern Extraction (keine Code-Kopien)  
**Quellen:** Agent Client Protocol (ACP v1/v2 Spec, `agentclientprotocol.com`), Devin UX-Docs, Antigravity Workspace-Muster, Three.js Raycasting / 3D-Annotation-Konventionen.

---

## 1. Zwei-Welten-UI (Antigravity-Chat vs. Devin-Bots-Tab)
Das zentrale UX-Problem von Multi-Agent-Systemen ist **Log-Spam**: Wer strategisch arbeiten will, darf nicht von 5 parallelen Tool-Streams erschlagen werden — wer debuggen will, braucht sofort volle Tiefe.

- **Welt 1 — Chat-Tab (Antigravity-Stil, ruhig & artefakt-zentriert):**
  - Hauptgespräch ausschließlich mit dem Meta-Orchestrator / Life-Manager.
  - Konsumiert nur eine **Quiet-Projection** (`sessionStatus`, aggregierte Projekt-/Bot-Zähler, Inbox-Eskalationen, klickbare Plan-/Artefakt-Karten).
  - Empfängt **niemals** rohe `tool_call`- oder `*_chunk`-Streams von Hintergrund-Bots.
- **Welt 2 — Bots-Tab (Devin-inspiriert, eigenständig gebaut):**
  - **Zweistufige Sidebar:** Projekt → Project Manager + Peer-Bots (und hierarchisch darunter Sidekicks via `parent_agent_id`).
  - **Schnelles Umschalten (<100ms):** Beide Tabs bleiben gemountet / State-warm; `Ctrl+E` wechselt die Welt, `Ctrl+K` springt direkt zu jedem Projekt/Bot.
  - **Status-Chips je Bot:** `idle`, `working`, `waiting_review`, `debating`, `requires_action`, `paused`, `stopped`, `error` + Modell-Badge + Worktree-Branch.
  - **Default-Dense Live-Watch-Timeline:**
    - `plan` / `thought`: einklappbarer Block bzw. Checkliste (`pending | in_progress | completed | cancelled`).
    - `tool_call`: **kompakte 1-Zeilen-Zusammenfassung** (Icon nach Typ, Dateipfad, Status-Dot, rotes `✕` bei Exit ≠ 0), erst per Klick/Shortcut aufklappbar; lange Diffs standardmäßig gekürzt.
    - `terminal`: eingebetteter Output-Block.
  - **Read-Only während Aktivität:** Ein laufendes Bot-Transcript ist im Bots-Tab strikt schreibgeschützt.

### Steer-Prinzip vs. Sicherheits-Kontrollen
- **Steer-Kanal (Kurskorrektur):** Geht ausschließlich über die klar markierte **Steer-Box an den Project Manager** (oder im Chat-Tab an den Meta-Orchestrator). Nachrichten an einen laufenden Manager können gequeued und vor Ausführung noch bearbeitet werden.
- **Harte Transport-Kontrollen am Einzel-Bot:** Physisch getrennte Buttons **Pause** (`session/cancel` / Abort am nächsten Safe-Point) und **Hard Stop** (Prozess-Tree-Kill + `session/close`). Niemals „Stop“ als Chat-Nachricht tarnen.
- **Benachrichtigungen:** Maximal eine Desktop-/Inbox-Meldung pro Session bei Abschluss oder `requires_action` — kein Spam pro Tool-Call.

## 2. ACP (Agent Client Protocol) Lifecycle & MCP-Bridge
Beide lokal vorhandenen CLIs (`devin acp` für `swe-2-max` und `opencode acp` für Mistral/GLM/Gemini) sprechen **JSON-RPC 2.0 über stdio** (Newline-delimited UTF-8, keine eingebetteten `\n` innerhalb einer Nachricht).

### Verbindungs- & Session-Lebenszyklus
1. Daemon spawnt Subprozess (`Bun.spawn`): `stdin`/`stdout` = reines ACP-JSON-RPC; `stderr` = ausschließlich in rotierendes Logfile.
2. **Bidirektionale Request-Map:** Beide Seiten können Requests stellen; Request-IDs sind **pro Richtung** eindeutig (niemals kollidieren lassen, nie `null`).
3. Ablauf: `initialize` → `session/new { cwd: worktreePath, mcpServers: [...] }` → `session/prompt` → Streaming über `session/update` (`agent_message_chunk`, `agent_thought_chunk`, `plan`, `tool_call` / `tool_call_update` als idempotenter Upsert nach `toolCallId`, `state_update`) → Turn-Ende oder `session/cancel` / `session/close`.
4. **Wichtige Pflicht:** Bei `session/cancel` oder Disconnect müssen alle offenen `session/request_permission`-Requests explizit mit `{ outcome: "cancelled" }` beantwortet werden — sonst hängt der Subprozess.

### Permission-Policy für autonome Hintergrund-Bots
- `session/request_permission` ist ein Agent→Client-Request, der **immer** eine Antwort erwartet (`allow_once | allow_always | reject_once | reject_always` oder `cancelled`).
- **Deterministischer Resolver (`resolvePermission`):**
  - Reads/Edits strikt innerhalb des zugewiesenen Bot-Worktrees (`cwd`) → Auto-Approve (gemäß Projekt-Policy).
  - Schreibzugriffe außerhalb des Worktrees, Secret-Pfade oder destruktive Shell-Befehle → Eskalation in UI-Inbox (`requires_action`) mit Timeout → Auto-Deny (`cancelled`) bei Ablauf.
  - Leere `options` oder kein `allow`-Eintrag → immer `cancelled`.

### Lokaler Bot-Factory MCP-Bridge
- Über `session/new { mcpServers: [{ name: "bot-factory", command: "bun", args: ["run", ".../mcp-bridge.ts", "--agent", agentId] }] }` erhält jeder externe ACP-Bot (z. B. `devin` mit `SWE-2-max`) sofort nativen Zugriff auf:
  - `bf_task_list`, `bf_task_claim`, `bf_task_update`
  - `bf_handoff_write`
  - `bf_debate_post`
  - `bf_memory_search`
  - `bf_fix_tasks_list` / `bf_fix_task_resolve`
- Vorteil: Kein fragiles Prompt-Parsing — externe ACP-Bots sprechen dasselbe strukturierte Protokoll wie interne `NativeHttpRuntime`-Bots.

## 3. Annotierbare Previews → Comment-to-Fix-Loop (Phase 2)
Einheitliches `Annotation`- & `FixTask`-Modell über alle drei Medientypen:

```ts
type AnnotationAnchor =
  | { kind: "doc";   filePath: string; blockId: string; contentHash: string; quote: string }
  | { kind: "image"; filePath: string; pin?: { x: number; y: number }; rect?: { x: number; y: number; w: number; h: number } }
  | { kind: "model_3d"; filePath: string; meshName: string; point: [number, number, number];
      normal: [number, number, number]; camera: { pos: [number, number, number]; target: [number, number, number]; fov: number } };
```

- **Pläne / Docs (Markdown):** Stabile Block-IDs (`heading-slug` + `contentHash` statt fragiler Zeilennummern). Klick auf Absatz öffnet Inline-Kommentar.
- **Bilder (PNG/JPG/WebP):** Normalisierte Koordinaten (`0..1`), damit Pins/Boxen über alle Zoomstufen & DPRs stabil bleiben. Optionaler Crop-Export für multimodale Fix-Bots.
- **3D-Assets (`.glb`/`.gltf` via Three.js):**
  - `Raycaster.setFromCamera(ndc, camera).intersectObject(root, true)` liefert `point`, `face.normal` und `object.name` (`meshName`).
  - Pin leicht entlang der Normale versetzen (`+0.05..0.1`), Billboard-Marker mit `depthTest: false`, plus HTML-Overlay-Label.
  - **Kamera-Pose speichern (`pos`, `target`, `fov`)** + optionaler Viewport-PNG-Snapshot → Klick auf Pin fliegt Kamera exakt zurück, und multimodale Modelle (Hydrogen/Neon) sehen exakt das Problem.
- **Strikte Modus-Trennung:** Expliziter Umschalter **Navigate** (Zoom/Pan/Orbit) vs. **Annotate** (Klick setzt Pin/Box) verhindert versehentliche Pins beim Drehen.
- **Loop:** Annotation speichern (`open`) → Event `annotation.created` → Project Manager erzeugt verlinkten `FixTask` → zuständiger Bot fixt im Worktree → Verifier prüft → Status `resolved_pending_review` (Vorher/Nachher) → Mensch bestätigt (`approved`) oder öffnet neu (gedeckt auf max. 2 Auto-Retries vor Menschen-Eskalation).

## Top-5-Fallstricke (Vermeidungsregeln für Bot-Factory)
1. **`stdout`-Verschmutzung im ACP-Kanal:** Jedes verirrte `console.log` zerstört JSON-RPC → Logs strikt nach `stderr`/Datei, jede Zeile strikt validieren.
2. **Unbeantwortete `session/request_permission`-Requests:** Blockieren den Subprozess dauerhaft → Timeout + Pflicht-`cancelled`-Flush bei Abbruch.
3. **Rohe Tool-Chunks im Chat-Tab:** Zerstören die ruhige Oberfläche → harter Reducer-Split in `timeline[]` (Bots-Tab) vs. `sessionStatus/inbox` (Chat-Tab).
4. **Pixel-Koordinaten oder rohe Zeilennummern als Annotations-Anker:** Brechen bei Resize oder kleinstem Edit → nur normalisierte `0..1`-Koordinaten, 3D-World+Camera-Pose und Block-ID+Hash.
5. **Windows-Prozess-Waisen beim Hard-Stop:** `child.kill()` allein tötet unter Windows oft keine Kindprozesse eines ACP-Subprozesses → Process-Tree-Termination (`taskkill /PID <pid> /T /F` als Fallback) einbauen.
