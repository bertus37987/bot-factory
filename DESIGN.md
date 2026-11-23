# Bot-Factory Harness — Design System (`Monochrome Ink`)

> **Phase 3.2 Design Specification**
> **Leitbild:** Extrem ruhiger, aufgeräumter *Agentic Light Mode* — viel Weißraum, flüsterleise `1px`-Hairlines, nahezu keine dekorative Farbe, kombiniert mit lebendigen, präzisen **Thinking Orbs** (inspiriert von [`Jakubantalik/thinking-orbs`](https://github.com/Jakubantalik/thinking-orbs)) in *Smoke & Pearl*-Ästhetik.

---

## 1. Design-Prinzipien & Anti-AI-Slop-Regeln

Das Interface soll sich anfühlen wie ein hochwertiges, ruhiges Instrument für konzentrierte Arbeit mit autonomen Agenten — nicht wie ein lautes Sci-Fi-Dashboard.

### Kernprinzipien
1. **Ruhe durch Reduktion:** Hierarchie entsteht über Weißraum, Typografie, Flächen-Luminanz (`#FFFFFF` → `#FAFAFA` → `#F5F5F5`) und `1px`-Hairlines (`#EBEBEB`), nicht über Farbe oder schwere Schatten.
2. **Farbe trägt Bedeutung, niemals Dekoration:** Das System ist zu ~95 % monochrom. Farbe erscheint ausschließlich als gedämpfter semantischer Hinweis (Status, Verifier-Urteil, Safety-Stop) oder als hauchfeiner Schimmer in einem aktiven Thinking Orb.
3. **Präsenz ohne Lärm (*Leicht, aber vorhanden*):** Agenten fühlen sich lebendig an durch subtile, organisch atmende 2D-Dot-Orbs statt hektischer Spinner oder blinkender Badges.
4. **Zwei Welten, eine Sprache:** Chat-Tab und Bots-Tab teilen exakt dieselbe Farb-, Typografie- und Formensprache, unterscheiden sich aber bewusst in ihrer **Informationsdichte** (`airy` vs. `compact`).

### Strikte Verbote (Anti-AI-Slop)
- **Keine** lila, violetten, blauen oder Neon-Verläufe (weder auf Buttons, noch auf Hintergründen, noch auf Text).
- **Keine** lauten Glow-Effekte (`box-shadow: 0 0 16px ...`) und keine pulsierenden Alarm-Lichter.
- **Keine** schweren Drop-Shadow-Cards — Flächen liegen flach auf der Ebene; Elevation ist ausschließlich Overlays (Popover, Modal, Command Palette) vorbehalten.
- **Keine** Emojis als UI-Icons — ausschließlich präzise `lucide-react`-Icons (`strokeWidth={1.6}`) oder minimalistische SVGs.
- **Keine** generischen CSS-Spinner für Agenten-Denkprozesse — immer die Thinking-Orb-Komponente verwenden.

---

## 2. Farbpalette (`Monochrome Ink — Light`)

Alle Werte sind verbindlich in [`apps/web/src/styles/tokens.css`](./apps/web/src/styles/tokens.css) definiert.

### Neutrale Flächen & Linien
| Rolle | Token | Hex | Verwendung |
| :--- | :--- | :--- | :--- |
| Canvas | `--bg-canvas` | `#FFFFFF` | Hauptarbeitsfläche, Chat-Hintergrund, Eingabefelder, aktive Tabs |
| Surface | `--bg-surface` | `#FAFAFA` | Sidebar, Nebenpanels, Inspector-Flächen |
| Surface Subtle | `--bg-surface-subtle` | `#F5F5F5` | Gruppen-Header, Kanban-Spalten, Code-Blöcke, 3D-Studio-Stage |
| Hover / Pill | `--bg-hover` / `--bg-pill` | `#F2F2F3` | Sanfter Hover-Zustand, neutrale Chips, Keycap-Flächen |
| Active Fill | `--bg-active` | `#EAEAEB` | Gedrückter Zustand, ausgewählte Listen-Zeile |
| Hairline Subtle | `--border-subtle` | `#F2F2F2` | Feine interne Trennlinien (z. B. zwischen Timeline-Zeilen) |
| Hairline | `--border-hairline` | `#EBEBEB` | Primäre `1px`-Trennlinie zwischen Regionen, Cards und Inputs |
| Hairline Strong | `--border-strong` | `#D9D9DC` | Hover-Ränder, aktive Eingabefelder, abgesetzte Sekundär-Buttons |

### Typografie & Aktionen (Ink Scale)
| Rolle | Token | Hex | Kontrast auf `#FFFFFF` | Verwendung |
| :--- | :--- | :--- | :--- | :--- |
| Ink Primary | `--ink-primary` | `#171717` | 17.9 : 1 | Haupttext, Titel, aktive Navigation, Zahlen |
| Ink Secondary | `--ink-secondary` | `#525252` | 7.9 : 1 | Sekundärtext, Beschreibungen, Standard-Icons |
| Ink Muted | `--ink-muted` | `#8A8A8A` | 3.5 : 1 | Metadaten, Timestamps, ruhige Labels, inaktive Tabs |
| Ink Faint | `--ink-faint` | `#A8A8A8` | — | Placeholder, deaktivierte Hinweise |
| Primary Action BG | `--action-primary-bg` | `#171717` | — | Primäre CTAs (`Senden`, `Freigeben`, `Promote`) |
| Primary Action Hover | `--action-primary-hover` | `#2B2B2B` | — | Hover für Primär-CTAs |
| Primary Action FG | `--action-primary-fg` | `#FFFFFF` | 17.9 : 1 | Text/Icons auf Primär-CTAs |

### Semantische Akzente (flüsterleise & entsättigt)
Nur für echte Systemzustände (Status-Pills, Verifier-Urteile, Eskalationen, Hard-Stop, Orb-Schimmer):

| Zustand | Ink (`--status-*-ink`) | Soft Surface (`--status-*-bg`) | Hairline (`--status-*-border`) | Einsatz |
| :--- | :--- | :--- | :--- | :--- |
| **Active / Running** | `#1E4E79` | `#F3F6FA` | `#DAE5F0` | Laufende Verifikation, aktive Verbindung, laufende Synchronisation |
| **Success / Pass** | `#165E3D` | `#F2F8F5` | `#D6EAE0` | `VERDICT: PASS`, Promotion erfolgreich, Test bestanden |
| **Warning / Needs Human** | `#8A530B` | `#FBF7F0` | `#EFE0C6` | `NEEDS_HUMAN`, pausiert, offene Debatte, Warnung |
| **Danger / Blocked** | `#9E2626` | `#FCF4F4` | `#F1D6D6` | `VERDICT: FAIL`, blockiert, Fehler, **Hard-Stop** |

---

## 3. Thinking Orbs (`Smoke & Pearl` × `thinking-orbs`)

Die **Thinking Orbs** sind das zentrale lebendige Detail des Interfaces. Sie orientieren sich direkt an [`Jakubantalik/thinking-orbs`](https://github.com/Jakubantalik/thinking-orbs): ein extrem leichtgewichtiger **2D-HTML5-Canvas-Dot-Renderer** (nur `arc`-Primitives, DPR auf `2` begrenzt, kein WebGL, keine schweren SVG-/Blur-Filter), eingebettet in eine hauchfeine **Smoke & Pearl**-Schale.

### Material & Optik (`Smoke & Pearl`)
- **Kern (Canvas):** Präzise, fein gerasterte monochrome Tinte-Punkte (`#171717` mit weicher Alpha-Abstufung) auf hellem Untergrund (`theme="light"`).
- **Schale:** Hauchzarte kreisförmige Pearl-Fassung (`--orb-shell-bg`, `1px solid var(--orb-shell-border)`) mit subtilem innerem Lichtreflex (`inset 0 1px 0 rgba(255, 255, 255, 0.9)`) und einem flüsterleisen semantischen Schimmer (`rgba(..., 0.10–0.14)`), der beim aktiven Denken langsam atmet.
- **Kein Neon-Halo:** Der Schimmer bleibt weich innerhalb oder hauchdünn an der Kontur der Schale (`max. 3px` weiche Ausbreitung).

### Präsenz & Lebenszyklus (*Aktiv-Fokus — leicht, aber vorhanden*)
| Kontext | Größe | Darstellung |
| :--- | :--- | :--- |
| **Aktiv im laufenden Agent-Turn / Streaming** | `20px` (Inline-Preset) | Animierter 2D-Dot-Orb in Smoke-&-Pearl-Schale neben dem sprechenden/arbeitenden Agenten |
| **Aktive Bots / Threads in Sidebar & Live-Watch** | `20px` (Inline-Preset) | Ruhiger Mini-Orb an jedem aktiv arbeitenden Agenten/Thread |
| **Meta-Orchestrator Fokus / Ruhiger Leerzustand** | `64px` (Focus-Preset) | Großer, fein aufgelöster Dot-Orb als ruhiger Fokus-Anker bei leerem Chat oder tiefer Synthese |
| **Idle / Ruhezustand** | `8px` Ruhe-Punkt / `1px`-Ring | Stiller, unbewegter `1px`-Hairline-Ring (`--orb-idle-ring`) mit hellem Kern — sichtbar genug als Anker, ohne Aufmerksamkeit zu ziehen |

> **Wichtig:** Größen werden **niemals** per CSS `transform: scale()` gestreckt; `20` und `64` nutzen jeweils ihre dediziert abgestimmten Punktanzahlen und Radien aus `thinking-orbs`.

### Zustands-Mapping (Bot-Factory Lifecycle → Orb State)
| Bot-Factory Zustand | `thinking-orbs` State | Schimmer-Token | Verhalten |
| :--- | :--- | :--- | :--- |
| `idle` / `done` | *(kein Canvas, statischer Ring)* | `--orb-shimmer-neutral` | Stiller Ruhe-Ring (`--orb-idle-ring`), keine Bewegung |
| `thinking` / `running` | `"working"` | `--orb-shimmer-neutral` | Langsames organisches Atmen (`5.2s`), Graphit/Pearl |
| `researching` / `memory` | `"searching"` | `--orb-shimmer-active` | Hauchfeiner kühler Schiefer-Schimmer |
| `verifying` / `debating` | `"solving"` | `--orb-shimmer-active` | Ruhiger, konzentrierter Tinte-Blau-Schimmer |
| `streaming` / `composing` | `"composing"` | `--orb-shimmer-neutral` | Fließende Punkt-Bewegung, rein monochrom Pearl |
| `building` / `self_mod` / `preview` | `"shaping"` | `--orb-shimmer-success` | Hauchfeiner Salbei-Schimmer |
| `listening` / `awaiting_steer` | `"listening"` | `--orb-shimmer-warning` | Sanfter warmer Pergament-/Amber-Hauch |
| `paused` | *(statisches Frame)* | `--orb-shimmer-warning` | Eingefrorenes Frame + ruhiger `1px`-Amber-Ring |
| `blocked` / `error` / `needs_human` | *(statisches Frame / 5.2s Atem)* | `--orb-shimmer-danger` | Ruhiger semantischer Hairline-Ring — niemals hektisches Blinken |

### Performance & Barrierefreiheit (Pflicht)
- Automatisches Pausieren via `IntersectionObserver` außerhalb des Viewports sowie bei `document.hidden === true`.
- `role="img"` mit präzisem deutschen/technischen `aria-label` (z. B. `"Verifier prüft Ergebnis"`).
- Bei `@media (prefers-reduced-motion: reduce)`: statisches repräsentatives Canvas-Frame und deaktiviertes Schimmer-Atmen.

---

## 4. Bewegungscharakter (`Meditativ-organisch`)

Bewegung vermittelt Ruhe, Kontinuität und Präzision — sie drängt sich nie in den Vordergrund.

| Kategorie | Token | Dauer | Kurve | Verwendung |
| :--- | :--- | :--- | :--- | :--- |
| Sofort | `--duration-instant` | `0ms` | — | Welt-Wechsel (`Chat` ↔ `Bots`, beide Tabs bleiben gemountet `<100ms`) |
| Mikro-Interaktion | `--duration-fast` | `150ms` | `--ease-out-quiet` | Hover-Fills, Hairline-Übergänge, Button-Feedback, Fokus-Ring |
| Standard-UI | `--duration-base` | `200ms` | `--ease-out-quiet` | Popover, Tooltips, Accordion/Disclosure, Command Palette |
| Langsam / Panel | `--duration-slow` | `260ms` | `--ease-out-quiet` | Drawer/Inspector-Einblendung, sanfte Statuswechsel |
| Orb-Atmen | `--duration-orb-breath` | `5200ms` | `--ease-organic` | Meditativer Atemzyklus der Smoke-&-Pearl-Schale |
| Orb-Drift | `--duration-orb-drift` | `6000ms` | `--ease-organic` | Subtile Lichtverschiebung im Pearl-Schimmer |

- **Kurven:**
  - `--ease-out-quiet`: `cubic-bezier(0.22, 1, 0.36, 1)` (sanftes, präzises Auslaufen ohne Nachfedern)
  - `--ease-organic`: `cubic-bezier(0.37, 0, 0.63, 1)` (weiche Sinus-Welle für Orb-Atmung)
- **Reduced Motion:** `@media (prefers-reduced-motion: reduce)` setzt alle UI-Transitions auf `0.01ms` und stoppt dekorative Keyframes global.

---

## 5. Typografie (`Neo-Grotesk Präzision`)

### Schrift-Stacks
- **UI & Fließtext (`--font-sans`):** `"Geist", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- **Code, IDs, Pfade, Logs (`--font-mono`):** `"Geist Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
- **Numerik:** `font-variant-numeric: tabular-nums` verpflichtend für Timestamps, Token-/Kosten-Zähler, Task-Counts, Zeilennummern und Versionsnummern.

### Typo-Skala
| Token | Größe | Line-Height | Tracking | Einsatz |
| :--- | :--- | :--- | :--- | :--- |
| `--text-2xs` | `11px` (`0.6875rem`) | `1.35` | `+0.02em` | Section-Eyebrows (Uppercase/Smallcaps), Keycaps (`Ctrl+K`), Micro-Badges |
| `--text-xs` | `12px` (`0.75rem`) | `1.4` | `0` | Metadaten, Timestamps, Status-Pills, kompakte Labels |
| `--text-sm` | `13px` (`0.8125rem`) | `1.45` | `-0.003em` | Standard-UI im **Bots-Tab** (Timeline, Kanban, Inspector, Controls) |
| `--text-base` | `14px` (`0.875rem`) | `1.55` | `-0.006em` | Standard-UI im **Chat-Tab**, Inputs, Modals |
| `--text-prose` | `15px` (`0.9375rem`) | `1.65` | `-0.008em` | Chat-Antworten & Plan-Dokumente (max. Zeilenlänge `--measure-prose: 68ch`) |
| `--text-lg` | `16px` (`1rem`) | `1.35` | `-0.015em` | Panel- und Modal-Titel |
| `--text-xl` | `20px` (`1.25rem`) | `1.25` | `-0.02em` | Ruhige Ansichts-Überschriften (z. B. Chat-Startzustand) |

### Gewichte
- `--weight-regular: 400` (Fließtext, Logs)
- `--weight-medium: 500` (Buttons, Tabs, Labels, Listentitel)
- `--weight-semibold: 600` (Überschriften, aktive Abschnitte — **kein** `700` Bold im Fließ-UI)

---

## 6. Ecken, Hairlines & Tiefe (`Hybrid-Balance`)

### Radien
| Token | Wert | Einsatz |
| :--- | :--- | :--- |
| `--radius-xs` | `4px` | Keycaps (`⌘K`), Micro-Tags, Inline-Code |
| `--radius-sm` | `6px` | Buttons, Text-Inputs, Selects, kompakte Status-Chips |
| `--radius-md` | `8px` | Listen-Zeilen, Kanban-Karten, Sub-Panels, Artifact-Pre-Cards |
| `--radius-lg` | `10px` | Große Container, Composer-Box, Modals, Command Palette |
| `--radius-pill` | `9999px` | Status-Pills, World-Switch-Indikatoren, Thinking-Orb-Schale |

### Hairlines & Fokus
- Primäre Abgrenzung ist stets `1px solid var(--border-hairline)` (`#EBEBEB`).
- **Fokus-Ring (Tastatur):** `--focus-ring: 0 0 0 2px #FFFFFF, 0 0 0 3.5px #171717` — kristallklarer Doppelring in reinem Ink, ausschließlich über `:focus-visible`.

### Elevation (nur Overlays)
- `--shadow-none`: Standard für **alle** Panels, Cards, Sidebars und Buttons.
- `--shadow-popover`: Hauchfeiner, mehrschichtiger Hairline-Schatten für Dropdowns & Tooltips.
- `--shadow-modal`: Dezente Tiefenstaffelung ausschließlich für Modals & `Ctrl+K`-Command-Palette.

---

## 7. Duale Informationsdichte (`Bewusster Kontrast`)

Beide Welten nutzen dasselbe Token-Fundament, schalten jedoch über ein semantisches Attribut (`data-density="airy"` vs. `data-density="compact"`) automatisch die ergonomisch passenden Abstände und Schriftgrößen:

| Eigenschaft | `data-density="airy"` (**Chat-Tab**) | `data-density="compact"` (**Bots-Tab**) |
| :--- | :--- | :--- |
| Charakter | Editorial, ruhig, viel Weißraum, dokumenten- & artefaktzentriert | Präzise Werkbank für Live-Watch, Kanban, Previews, Debates & Self-Mod |
| Basis-Schrift | `14px` UI / `15px` Prose (`1.65` LH) | `13px` UI / `12px` Meta (`1.45` LH) |
| Panel-Padding | `24px` (`--density-pad-lg`) | `12px` (`--density-pad-lg`) |
| Element-Gap | `16px` (`--density-gap`) | `8px` (`--density-gap`) |
| Zeilenhöhe (Listen/Controls) | `36px` (`--density-row-h`) | `30px` (`--density-row-h`) |
| Lärmschutz | Strenge Quiet-Projection: nur finale Antworten, Artefakte & ruhiger Orb | Vollständige Telemetrie, aber visuell geordnet durch Hairlines & Mono-Spalten |

---

## 8. Komponenten-Konventionen (Leitplanken für Phase 3.2)

*(Bewusst ohne starre Layout-Vorgabe — nur Oberflächen- und Interaktionsregeln für den späteren Umbau.)*

- **Buttons:**
  - *Primary:* `#171717` BG, `#FFFFFF` Text, `6px` Radius, keine Schatten.
  - *Secondary:* `#FFFFFF` BG, `1px solid #EBEBEB` Border, `#171717` Text, Hover `#F2F2F3`.
  - *Ghost:* Transparenter Hintergrund, `#525252` Text, Hover `#F2F2F3` + `#171717`.
  - *Danger / Hard-Stop:* Ruhiger `#FCF4F4` BG, `1px solid #F1D6D6`, `#9E2626` Ink (physisch getrennt vom Steer-to-PM-Dock).
- **Icons (`lucide-react`):** `14px` in kompakten Controls, `16px` in Navigation/Headern, `strokeWidth={1.6}`, Standardfarbe `--ink-secondary` (`#525252`).
- **Code & Diffs:** Helle `#FAFAFA`/`#F5F5F5` Fläche, `1px solid #EBEBEB`, `--font-mono`, dezente gedämpfte Diff-Zeilen (`#F2F8F5` / `#FCF4F4`) ohne grelles Grün/Rot.
- **3D Preview Studio (Three.js):** Statt eines schwarzen Lochs erhält die 3D-Bühne im Light Mode eine neutrale Museums-/Studio-Stage (`--stage-3d-bg: #F5F5F5` mit feinem `#E5E5E5`-Bodenraster und ausgewogener Studio-Beleuchtung), sodass 3D-Assets und Annotations-Pins organisch mit der Monochrome-Ink-Oberfläche verschmelzen.
- **Scrollbars:** Ultrafein (`6px`), transparent im Ruhezustand, dezentes `#D4D4D8` bei Hover.
