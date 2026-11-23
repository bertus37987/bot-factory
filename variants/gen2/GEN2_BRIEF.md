# Bot-Factory — Generation 2 Evolution Brief (4 Focused Concepts)

> **Iteration Goal:** Fuse the user's exact Gen-1 winners while radically upgrading **Bot Group-Chat Messaging**, the **In-App Browser Sidebar**, and the **Reasoning Effort (`Aufwand`) Control** — strictly in **Light Mode (`Monochrome Ink`)**.

---

## 1. Locked-In Gen-1 Winners (MUST PRESERVE & REFINE)
1. **Left Sidebar & Bot Management from `C:\Users\willy\bot-factory\system\harness\variants\ui\ui-01.html`:**
   - Far-left `44px` slim custom icon rail (`#FAFAFA`, `1px solid #EBEBEB`) with **2 bespoke Bot-Factory SVG icons at top-left** (Dialogue Aperture for Agent Chat, 3-Node Factory Lattice for Bots — ZERO slider!) + utility icons at bottom.
   - Secondary `248px` drawer (`Sessions` + `+ New session` + collapsible `Projects / Folders` + `Recent` in Chat mode; switches cleanly to Bot Fleet with live mini 2D-canvas Thinking Orbs + Group Rooms in Bots mode).
2. **Chatbar Foundation from `C:\Users\willy\bot-factory\system\harness\variants\ui\ui-03.html`:**
   - `12px` architectural precision card, **3-bar stepped Autonomy control** (`Spec / Low / Medium / High`), `+`, `/`, mic, square-rounded `↑` send button, plus clean lower workspace strip (`Local / Worktree v | Folder v`).
   - Also allow optional dismissible `3 files changed +383 −4 | Quick review | View changes` tray when diff is ready.
3. **NEW Reasoning Effort (`Aufwand`) Control — Replaces Generic Dropdown!**
   - Directly inspired by user attachment `C:\Users\willy\.t3\userdata\attachments\6b7d2a2e-e89a-439e-b12c-73ccd082e7a5-19802102-4dc8-4656-9d81-b4ed215ae366.png`, adapted cleanly into **Light Mode**:
   - **Tactile 4-stop stepped horizontal slider track** (`Niedrig` · `Mittel` · `Hoch` · `Max` — stops 0..3):
     - Thick rounded pill track (`10px` height, `#E7E7EA` unfilled) with **4 crisp visible circular stop dots** (`4px` white dots on filled side, `#A1A1AA` dots on unfilled side).
     - Filled warm burnt-orange track (`#D95D22` / `#E06224`, subtle warm softness — NO harsh neon) up to the active stop.
     - Crisp `20px` circular white thumb (`#FFFFFF`, `1.5px solid rgba(23,23,23,0.14)`, tactile micro-shadow `0 1px 4px rgba(0,0,0,0.18)`) — supports BOTH clicking any stop/track position AND pointer dragging!
     - Clean label row directly underneath: **`Aufwand`** (semibold `#171717`, left) and active value **`Niedrig` / `Mittel` / `Hoch` / `Max`** (`#525252` or `#C24E1A`, right).
   - Wire this custom stepped slider cleanly into the `ui-03` chatbar (either in a crisp popover triggered by clicking the Effort pill in the composer OR subtly expandable directly above/inside the composer footer — and ALWAYS visually reflecting the chosen stop with an orange micro-bar/dot preview on the trigger pill!).

---

## 2. Radical Upgrade #1 — True Group-Chat Bot Messaging
> User critique: *"die Bot Messages müssen neu und mehr group chat Like, also Profilbilder messages auf verschiedenen seiten nicht nur der Human auf einer Seite"*

- **NO more monotonous left-aligned wall of bot logs!**
- **Distinct, Memorable Bot Profile Avatars:** Every bot gets its own custom-crafted circular `30px–34px` bespoke geometric SVG profile portrait/avatar (clean Light-Mode identity tint + crisp geometric face/emblem — zero emojis!):
  - **Architect PM** (Slate/Ink badge), **Builder Bot** (Sage badge), **3D Sculptor** (Terracotta badge), **Verifier Bot** (Cobalt badge), **Du / Human** (Monochrome Ink monogram).
- **Multi-Side Alternating Group-Chat Layout:**
  - Messages live on **BOTH left and right sides** — NOT just Human on the right and all bots dumped on the left!
  - E.g. Coordinator/PM & Human (or alternating speakers in bot-to-bot discussions) align on the right with right-side avatars, while Peer Specialists/Builders/Verifier align on the left with left-side avatars (or true alternating left/right speaker lanes as the conversation bounces between bots!).
  - Consecutive messages from the same speaker group tightly (`3px` gap, avatar only on first/last bubble in group, clean rounded corners `16px` with directional tail corner `4px`).
  - **Group-Chat Polish Details:** Reply-quote bars (`↳ Architect PM: "Update hero-monolith proportions"`), clickable inline `@Bot` mini-avatar mention chips, embedded rich preview cards right inside bubbles (clicking opens that Code/Diff/Plan/Image/3D item directly in the right In-App Browser!), live typing-indicator bubble with avatar + animated 2D-canvas Thinking Orb, and subtle inline expandable tool-call pills (never cluttering the message flow!).

---

## 3. Radical Upgrade #2 — Next-Level In-App Browser Sidebar
> User critique: *"den Browser Akzeptiere ich so auch noch nicht iterieren wir mit dem Selben system weiter"*

- Stop making the right pane feel like a cramped generic dev-inspector! Make it feel like a **genuine, ultra-refined, first-class In-App Browser** (Arc / Safari Compact / Dia / Devin Live Browser caliber in crisp Light Mode) that makes previewing **Code, Diff, Doc/Plan, Image, 3D, and Live Web** effortless and joyful:
  - Authentic, spacious browser chrome (`← → ↻`, clean interactive omni-URL/path bar, crisp viewport/zoom/annotate controls, generous canvas area — minimum chrome clutter!).
  - **Code Preview:** Clean syntax-highlighted line-numbered code, quick file switcher, copy/jump controls.
  - **Diff Preview:** Clean unified/split `+383 −4` diff with per-file jump list & approve/comment hooks.
  - **Doc / Plan Preview:** Beautifully rendered editorial Markdown (headings, checklists, code spans — NOT raw `#` markdown text!) with clean hover-to-annotate block pins.
  - **Image Preview:** Clean light studio canvas with zoom controls (`75% / 100% / Fit`) + clickable numbered annotation pins + drop-new-pin mode.
  - **3D Preview:** High-craft interactive drag-orbit 3D canvas monolith on `#F5F5F5` gallery stage with camera presets (`Iso / Front / Top`), wireframe/shaded toggle, and clickable 3D pins.
  - **Live Web Preview:** Interactive local app mockup inside the browser frame with Desktop/Mobile viewport toggle!

---

## 4. Mandatory Light Mode & Anti-Slop Rules
- Strictly **Light Mode** (`#FFFFFF`, `#FAFAFA`, `#F5F5F5`, `#171717`, `#525252`, `#8A8A8A`, `1px #EBEBEB`).
- Zero purple/indigo gradients, zero neon glows, zero emojis as icons (100% crisp inline `1.5px` SVGs), zero external JS dependencies (self-contained single HTML file, Google Fonts `DM Sans` + `JetBrains Mono` only), `tabular-nums`, `prefers-reduced-motion` respected on all Thinking Orbs.
