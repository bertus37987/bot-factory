# Bot-Factory Generation 1 — Visual Reference Synthesis & Quality Standard

> **Mandatory Quality Floor:** Every prototype (`ui-01`..`ui-10` and `chatbar-01`..`chatbar-10`) MUST match or exceed the visual craft, calm restraint, spacing discipline, and interactive depth of the 8 reference screenshots below — strictly translated into **Light Mode (`Monochrome Ink`)**.

---

## 1. Visual Pattern Synthesis from the 8 Reference UIs

### A. Devin Desktop (Light Mode Reference — Primary Light Baseline)
- **Far-left slim icon rail (`44px`, `#FAFAFA`, `1px solid #EBEBEB`)**: Clean small custom icon triggers pinned top-left (Home/Agent, Bots/Swarm, Search, Reviews/Checks, More) and bottom utilities (Help, Plugins, Settings, User initial badge).
- **Secondary session sidebar (`240px`, `#FAFAFA`)**: `Sessions` header with `...` and inbox icons, full-width `+ New session` subtle pill button (`#F2F2F3`), chronological `Recent` list with tiny local/cloud glyph + relative timestamps (`40 minutes ago`, `yesterday`).
- **Window chrome (`38px`, `#FAFAFA`)**: Left workspace dropdown (`Agents v`), history `← →`, sidebar toggle, browser-like session tab (`Home`, `+`).
- **Signature Double-Deck Floating Composer**:
  - **Attached Diff/Review Tray** snuggled flush on top (`#F5F5F5`, `18px` outer radius): pencil icon + `3 files changed` + `+383` (`#16803C`) `-4` (`#DC2626`) on left; `Quick review`, `View changes` (`#2563EB` or `#171717` link), `×` dismiss on right.
  - **White Composer Card (`#FFFFFF`, `16px` radius, `1px solid #E5E5E5`)**: Clean prompt textarea (`Tip: Start a new session (Ctrl N)` with inline `<kbd>` chips), bottom utility bar with `+`, `/` boxed slash-chip, `Bypass Permissions` shield toggle, active folder `Mixar_Tests_01` on left; Model selector (`SWE-2 High` / `DeepSeek V4.1`), **circular orange/amber Context Ring gauge**, mic icon, and circular `↑` Send button (`#171717` active / `#9A9A9A` empty) on right.
  - **Optional lower shelf** (`#F5F5F5`): `Local v` | `Folder` | `Branch / Worktree` + `Your Bots` compact cards underneath when in empty state.

### B. Antigravity Desktop
- **Sidebar**: `+ New Conversation` prominent subtle pill, `Automations`, `Customizations`, `Projects` folder groups with nested threads (`3mo`), `Conversations` flat recent list (`21h`, `4d`), bottom `Settings`.
- **Top-right action**: Clean `Open IDE` / `Browser` toggle button — zero cluttered top-bar pills.
- **Composer with Top Context Strip**: Top slim shelf (`No Project v` on left, In-App Browser/Preview monitor toggle on right), inner input (`Ask anything, @ to mention, / for actions`), bottom bar (`+`, bordered pill `Orchestrator · Model + Effort v`, `Shield Turbo v`, mic, circular live voice/send orb).

### C. Factory Desktop
- **Sidebar**: `+ Neue Session`, `Automatisierungen`, `Suchen`, `Mehr` (subtle orange dot), `Workstreams (Beta)`, `Projekte` collapsible folder trees, bottom onboarding/status widget (`2/3` circular green progress + `Tools verbinden`).
- **Center Hero & Composer**: Minimal geometric emblem + `Woran sollen wir arbeiten?`, crisp composer (`12px` radius) with **3-bar Autonomy Level indicator** (`||| Medium Autonomy` — Low/Medium/High/Spec), right side **Model + Reasoning Effort** (`deepseek-v4.1 High`), mic, square-rounded `↑` send; beneath it a clean workspace strip (`Local v | Folder v`).
- **Top-right**: Single minimalist right-sidebar toggle icon (In-App Browser / Inspector).

### D. Codex / ChatGPT Work Desktop
- **Dual-layer left navigation**: Ultra-slim `44px` icon rail (Home, Automations, Bots/Agents, More, Settings) paired with `236px` drawer (`Bot-Factory v`, `New Chat`, `Projects` folder tree, `Recent`).
- **Double-Deck Composer**: Main card (`+`, `Ask permission` / autonomy pill on left; `Model · Reasoning Effort` + circular `↑` on right) with a neatly nested lower pill tray (`Select project | Plugins` on left, right-side viewport/browser icon on right).

### E. T3 Code Desktop
- **True 3-Column Agent Workbench**: Left project-grouped threads with provider mark + git branch + `Settled` collapse; Center rich markdown + compact expandable subagent/tool-call status rows (`Research 1/3 ... Completed 18:15 >`); **Right Collapsible Inspector Sidebar** (top-right 3 panel toggles, workspace actions, git branch, `Changes Uncommitted +X -Y`, `Lineage`, `Previous agents` counter).

### F. Grok Bot (Dedicated Bot Management — Single & Multi-Bot Group Rooms)
- **Pinned Bot Grid (top of Bot Sidebar)**: 3 crisp pinned Bot tiles (`Launch Bot`, `Inbox Manager`, `Mktg Data`) with distinct minimalist geometric bot marks (in Light Mode: refined monochrome/soft-tinted geometric emblems — never garish neon or emoji!).
- **Bot Roster & Multi-Bot Group Rooms**: Vertical list of individual bots + collaborative **Bot Group Rooms** (e.g., `Core Team (+3)` with clustered mini-avatars, unread dot, role tag `PM`, timestamp, last update snippet).
- **Multi-Bot Conversation Stream**: Bots mention each other inline with crisp miniature badge chips (`[●] Architect Bot`, `[●] Verifier Bot`), plus compact inline check-list outcome cards (`✓ Product page → updated`, `✓ Tests → 24/24 passing`).

---

## 2. Mandatory Light Mode & Anti-Slop Rules

- **Palette (Light Mode ONLY):**
  - Canvas: `#FFFFFF`
  - Surfaces / Sidebars / Trays: `#FAFAFA` and `#F5F5F5`
  - Subtle Hover / Pill: `#F2F2F3`, Active: `#EAEAEB`
  - Hairline Borders: `1px solid #EBEBEB` (strong `#DCDCE0`)
  - Ink Primary: `#171717`, Secondary: `#525252`, Muted: `#8A8A8A`, Faint: `#A8A8A8`
  - Primary Action: `#171717` (text `#FFFFFF`), Hover `#2B2B2B`
  - Whisper Semantic Accents ONLY for genuine state:
    - Added / Pass / Online: `#166534` on `#F0FDF4` (border `#DCFCE7`)
    - Active / Link / Info: `#1D4ED8` / `#1E4E79` on `#F2F6FA` (border `#D7E4F0`)
    - Autonomy / Context Ring / Review: `#B45309` / `#D97706` on `#FFFBEB` (border `#FDE68A`)
    - Removed / Danger / Stop: `#B91C1C` on `#FEF2F2` (border `#FECACA`)
- **Strict Bans (ZERO tolerance):**
  - ZERO dark mode! Light mode only.
  - ZERO purple/violet/indigo gradients or rainbow AI glows.
  - ZERO heavy drop shadows on normal cards (elevation ONLY on floating composer / popovers / modals: `0 1px 2px rgba(0,0,0,0.04), 0 8px 24px -6px rgba(0,0,0,0.06)`).
  - ZERO emojis as icons! Every icon MUST be a crisp inline `<svg>` (`stroke="currentColor"`, `stroke-width="1.5"`, `stroke-linecap="round"`, `stroke-linejoin="round"`).
  - **Custom Bot-Factory Mode Icons:** Avoid generic slider toggles for switching between **Agent Chat** and **Bots**. Use **two bespoke, handcrafted geometric SVG icons** in the top-left corner (or slim left rail) tailored to Bot-Factory (e.g., an architectural Dialogue Aperture mark for Agent Chat + a precision 3-Node Factory Lattice mark for Bots).
- **Typography:** Load `Plus Jakarta Sans` or `DM Sans` or `Geist` + `JetBrains Mono` from Google Fonts (with clean system fallback, tight heading tracking `-0.02em`, `font-variant-numeric: tabular-nums` on all counters/diffs/timestamps).
- **Alive "Thinking Orb" (2D Canvas or Precision SVG Dot-Orb):** Every prototype MUST include a subtle, real animated dotted/smoke-pearl **Thinking Orb** (inspired by `Jakubantalik/thinking-orbs` — monochrome `#171717` rotating/breathing dotted 2D `<canvas>` inside a whisper-thin pearl ring, respecting `prefers-reduced-motion`) showing active vs. idle agent states.

---

## 3. Mandatory Interactive Requirements

Every standalone HTML file MUST work cleanly when opened directly in any browser (self-contained single `.html` file with inline `<style>` and `<script>`, zero build step, zero external JS deps beyond Google Fonts):
- **Full-UI Variants (`variants/ui/ui-01.html` .. `ui-10.html`)** must allow REAL interactive clicking of:
  1. Switching between **Agent Chat** and **Bot Management** (including Grok-Bot-style pinned bots + multi-bot group room + individual bot streams).
  2. Switching **Sessions** and expanding/selecting **Folders / Projects**.
  3. Opening, resizing/toggling, and switching tabs inside the **In-App Browser Sidebar**: **Code Preview** (line-numbered syntax-tinted code + file switcher), **Diff Preview** (`+383 -4`), **Document / Plan Preview** (annotatable markdown plan!), **Image Preview** (with clickable pin markers!), **3D Preview** (interactive CSS/2D-Canvas/SVG wireframe 3D monolith orbit stage with 3D pins!), and **Live Web Preview**.
  4. Interacting with the **Chatbar**: typing & sending a realistic simulated agent turn (with animated Thinking Orb + expandable tool-call trace!), switching **Model**, **Reasoning Effort** (`Low`/`Medium`/`High`/`Max`), **Autonomy Level** (`Ask`/`Scoped`/`Medium`/`Auto-High`), toggling **Diff Tray (`Quick review` / `View changes`)**, and opening `/` slash command menu.
  5. Clicking **Approvals / Tool-Call accordions / Steer-to-PM / Pause & Stop** states.
- **Chatbar Variants (`variants/chatbars/chatbar-01.html` .. `chatbar-10.html`)** must present a focused interactive Light-Mode showcase stage where the user can test every control of that composer concept live (typing, switching model/reasoning/autonomy, attaching files/context chips, toggling diff tray, switching project/folder, slash menu, voice/orb live state toggle between `Idle`, `Thinking`, `Streaming`, `Needs Approval`).
