# Reference Research: Supermemory (`supermemoryai/supermemory`)

**Modus:** Clean-Room Pattern Extraction (keine Code-Kopien)  
**Quellen:** Öffentliche Konzepte & Architektur-Dokumentation (`supermemory.ai/docs/concepts/graph-memory`, `how-it-works`, öffentliche Produkt-/Architektur-Specs).

---

## 1. Strikte Trennung: Raw Documents vs. Atomic Memories
- **Invariante:** Rohe Quellen und extrahierte Fakten niemals vermischen.
  - **Documents (L3):** Roher Input (Chat-Transcripts, Pläne, Handoffs, Dateien) mit **stabilem, vom Aufrufer vergebenem `doc_id`**. Re-Ingestion unter derselben `doc_id` aktualisiert das Dokument statt Duplikate zu erzeugen.
  - **Chunks (L3):** Semantische Abschnitte (nach Absätzen/Überschriften mit leichtem Overlap, nicht blind feste Wortzahl) für FTS5-Grounding.
  - **Memories (L2):** Atomare, eigenständig lesbare Fakten, ausschließlich durch die Konsolidierungs-Pipeline („Dreaming“) erzeugt — ein Dokument ergibt viele atomare Fakten.
- **Zwei getrennte Status-Spuren:** `status` (Chunk-Indexierung fertig → sofort durchsuchbar) und `dream_status` (Fact-Extraktion fertig → Graph aktualisiert).

## 2. Temporaler Fact-Graph (`updates` / `extends` / `derives`)
Kanten verbinden Fakten direkt miteinander (kein starres Triple-Schema pflegen; kanonische SQLite-Enum-Werte strikt kleingeschrieben):

| Relation (`rel`) | Bedeutung | Auswirkung im Retrieval |
|---|---|---|
| `updates` | Neuer Fakt ersetzt überholten Fakt | Alter Fakt bekommt `is_latest = 0` (bleibt für Audit!), Retrieval filtert auf `is_latest = 1` |
| `extends` | Neuer Fakt reichert bestehenden Fakt mit Details an | Beide bleiben `is_latest = 1`; als Nachbarn traversierbar |
| `derives` | Aus mehreren Fakten abgeleitetes Muster / Schlussfolgerung | Markiert mit `is_inference = 1` und niedrigerer `confidence` |

### Versionierungs-Invarianten
- **Kein In-Place-Überschreiben:** Eine Änderung erzeugt immer eine neue `memory_facts`-Zeile (`version + 1`) plus `UPDATES`-Kante; die Vorgängerzeile wechselt nur auf `is_latest = 0`.
- **Graph-Expansion begrenzen:** Rekursive CTE über `memory_edges` auf maximal **3 Hops** deckeln (`parents` = ältere Versionen, `children` = neuere, `siblings` = `EXTENDS`/`DERIVES`).

## 3. Automatisches Vergessen (Soft-Forget & Decay)
Drei Mechanismen — alle **weich** (kein hartes Löschen außer bei explizitem `erase` eines Dokuments):
1. **Zeitablauf (`forget_after`):** Episodische/temporäre Fakten („Sprint-Review morgen“, „Temp-Branch fix-12“) tragen ein Ablaufdatum; nach Ablauf setzt ein leichter SQL-Sweep `is_forgotten = 1, forget_reason = 'expired'`.
2. **Widerspruchsauflösung:** `UPDATES` sorgt dafür, dass immer nur der aktuelle Stand im Default-Retrieval erscheint.
3. **Rauschfilterung bei Extraktion:** Der Dreaming-Prompt weist das Modell explizit an, Smalltalk/Rauschen gar nicht erst als Fakt zu speichern.

**Fakten-Taxonomie:** `fact` (persistent bis `UPDATES`), `preference` (verstärkt sich bei Wiederholung), `decision` (Architektur-/PM-Entscheidungen), `episode` (verfällt über `forget_after`, sofern nicht signifikant).  
**Forget ≠ Erase:** `forget` blendet aus dem Retrieval aus, erhält aber Audit-History; `erase` löscht Dokument + alle abgeleiteten Fakten kaskadierend über `doc_id`-Provenienz.

## 4. Always-On Profile (Zero-LLM Read-Path)
- Strikte **Namespace-Isolation** (`global` vs. `project:<slug>`). Niemals Fakten über Namespace-Grenzen mischen.
- Zwei Profil-Teile:
  - `profile.static` (`is_static = 1`): langlebige Präferenzen, Tech-Stack-Entscheidungen, Arbeitsstil.
  - `profile.dynamic` (jüngste aktive Episoden/Entscheidungen nach `updated_at DESC LIMIT k`): aktueller Kontext.
- **Lokaler Performance-Gewinn:** Das Profil wird beim Session-Start über **reines SQL** zusammengestellt — **0 LLM-Calls im Lesepfad**.

## 5. Lokales Async-Dreaming auf GLM 5.3 Flash
- **`dynamic` (Standard):** Debounced Background-Worker. Neue/aktualisierte Dokumente reihen ihren Namespace ein; nach Idle-Fenster (z. B. 15–30s) oder Session-Ende läuft **ein** strukturierter Batch-Call über **GLM 5.3 Flash**.
- **`instant` (Optional):** Synchrones Durchspülen für sofortige Tests oder explizite „Merk dir das sofort“-Anweisungen.
- **Strukturierter Prompt für günstige Modelle:**
  - Input: neue Chunks + Top-K Kandidaten bestehender `is_latest = 1`-Fakten (per FTS5-Vorfilter).
  - Output: striktes JSON-Op-Array `{ newFacts[], updates[{oldId, text}], extends[{targetId, text}], derives[], forgetAfter? }`.
  - Ranking, Deduplizierung, Ablaufprüfung und Kanten-Updates erfolgen komplett deterministisch in SQLite — niemals im LLM.

## Minimaler SQLite-Kern (für `~/bot-factory/system/state.db`)
```sql
-- Zentrales Live-Memory-Prädikat (in einer SQL-View bündeln!)
CREATE VIEW live_memory_facts AS
SELECT * FROM memory_facts
WHERE is_latest = 1
  AND is_forgotten = 0
  AND (forget_after IS NULL OR forget_after > unixepoch());
```
Kern-Tabellen: `documents (id, namespace, content, status, dream_status)`, `chunks` + `chunks_fts` (FTS5), `memory_facts` (`id, namespace, doc_id, fact_text, kind, version, is_latest, is_forgotten, is_inference, is_static, forget_after, confidence, created_at, updated_at`) + `facts_fts` (FTS5), `memory_edges (src_id, dst_id, rel CHECK(rel IN ('updates','extends','derives')))`.

## Top-5-Fallstricke (Vermeidungsregeln für Bot-Factory)
1. **Fakten in-place mutieren** → zerstört Zeitlinie & Audit. Immer neue Version + `UPDATES`-Kante.
2. **Ein LLM-Call pro Nachricht statt Batch-Dreaming** → fragmentierte Fakten und unnötige Token-Kosten. Immer debounced batchen.
3. **`forget_after`-Filter in einem Pfad vergessen** → abgelaufene Episoden leaken in Profile oder Graph-Expansion. Zentrale SQL-View `live_memory_facts` überall erzwingen.
4. **Fehlende Namespace-Trennung oder instabile `doc_id`s** → Cross-Project-Bleed und doppelte Faktenketten bei Re-Ingestion.
5. **Hard-Delete statt Soft-Forget** → verhindert Nachvollziehbarkeit von Entscheidungen; Hard-Delete nur bei explizitem `erase` über `doc_id`.
