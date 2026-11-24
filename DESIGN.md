# Bot-Factory — Design System (Phase 3.3 Light Mode)

> Historical design reference. [Studio V2](./docs/STUDIO_V2_HANDOFF.md) supersedes the light-only palette, beaver portraits, and fixed-layout guidance in this document.

> **Guiding Principle:** Calm, high-craft *Agentic Light Mode* — generous whitespace, whisper-quiet `1px` hairlines, restrained monochrome ink punctuated sparingly by **Burnt Orange (`#D95D22`)** focus/mascot accents, **Low-Poly Orange Beaver** bot emblems, and **Smoke & Pearl** 2D Thinking Orbs.

---

## 1. Core Principles & Anti-Slop Rules

1. **Calm Through Reduction:** Hierarchy comes from whitespace, typography, surface luminance (`#FFFFFF` -> `#FAFAFA` -> `#F5F5F5`), and `1px` hairlines (`#EBEBEB`), never noisy decoration or heavy box shadows.
2. **Restrained Color:** ~92% monochrome neutral ink. **Burnt Orange (`#D95D22`)** carries active effort/annotation/beaver mascot emphasis; muted semantic tints appear strictly for genuine system states (`PASS`, `Active`, `Needs Human`, `Fail / Stop`).
3. **Presence Without Noise:** Agents feel alive through lightweight 2D-canvas dotted **Thinking Orbs** (`Smoke & Pearl`) rather than generic spinners.
4. **Two Worlds, One Grammar:** `Main Agent` (Devin/Codex airy editorial density) and `Bots` (Grok-Bot compact group-chat & workbench density) share exact tokens and icon craft.

### Strict Bans
- **No** dark mode in Studio canvases (`#FFFFFF` / `#FAFAFA` / `#F5F5F5` only).
- **No** purple/violet/neon gradients or heavy glowing halos.
- **No** heavy drop shadows on static panels (elevation is reserved strictly for floating composer, popovers, modals, and `Ctrl+K` palette).
- **No** emojis as UI icons — use crisp `1.5px–1.6px` stroke SVGs (`lucide-react` + bespoke Aperture/Lattice/Beaver marks).
- **No** external CDN runtime dependencies — bundle fonts (`@fontsource/inter`, `@fontsource/jetbrains-mono`) locally.

---

## 2. Color Palette (`Light Mode — Phase 3.3`)

Canonical CSS variables live in `apps/web/src/styles/tokens.css`.

### Neutrals & Hairlines
| Role | Token | Hex | Usage |
| :--- | :--- | :--- | :--- |
| Canvas | `--bg-canvas` | `#FFFFFF` | Main streams, active tabs, composer card |
| Surface | `--bg-surface` | `#FAFAFA` | 44px icon rail, 248px drawer, 2-row browser chrome |
| Surface Subtle | `--bg-surface-subtle` | `#F5F5F5` | Diff tray, bot bubbles, code/diff headers, 3D Light-Museum stage |
| Hover / Pill | `--bg-hover` / `--bg-pill` | `#F2F2F3` | Hover fills, subtle pills, keycaps |
| Active Fill | `--bg-active` | `#EAEAEB` | Selected list/navigation rows |
| Hairline Subtle | `--border-subtle` | `#F2F2F2` | Internal row dividers |
| Hairline | `--border-hairline` | `#EBEBEB` | Primary `1px` borders across panels and cards |
| Hairline Strong | `--border-strong` | `#D9D9DC` | Hover borders, active inputs, secondary CTAs |

### Ink & Primary Accent
| Role | Token | Hex | Usage |
| :--- | :--- | :--- | :--- |
| Ink Primary | `--ink-primary` | `#171717` | Headings, body text, active navigation, primary buttons |
| Ink Secondary | `--ink-secondary` | `#525252` | Secondary text, descriptions, default icons |
| Ink Muted | `--ink-muted` | `#666666` | WCAG-AA compliant timestamps, metadata, inactive tabs |
| Ink Faint | `--ink-faint` | `#737373` | Placeholders, disabled captions (readable AA on white) |
| Burnt Orange | `--accent-orange` | `#D95D22` | Effort slider fill, active annotation pins/regions, context ring, beaver identity |
| Burnt Orange Soft | `--accent-orange-soft` | `#FFF7F2` | Warm human/PM quote highlight & annotation region fill |

### Semantic Status Accents
| State | Ink | Soft Surface | Hairline | Usage |
| :--- | :--- | :--- | :--- | :--- |
| **Active / Running** | `#1E4E79` | `#F3F6FA` | `#DAE5F0` | Live sync, verification in progress |
| **Success / Pass** | `#166534` | `#F0FDF4` | `#DCFCE7` | `VERDICT: PASS`, clean merge, tests passing |
| **Warning / Approval** | `#8A530B` | `#FFFBEB` | `#FDE68A` | Pending permission request, paused, escalation |
| **Danger / Stop** | `#9E2626` | `#FEF2F2` | `#FECACA` | `VERDICT: FAIL`, blocked, Hard Stop |

---

## 3. Mascots, Thinking Orbs & Typography

- **Bot Avatars:** Custom geometric **Low-Poly Orange Beaver** and role-tinted geometric SVG emblems (`30px–34px` circular portraits in Group Chat, compact tiles in `Pinned Bots`, `18px` chips in nested Subagent trees).
- **Thinking Orbs (`Smoke & Pearl`):** 2D HTML5 Canvas dotted orbs (`20px` inline next to active speakers/subagents, `64px` hero anchor on empty Main Agent state, `8px` static ring when idle), auto-paused offscreen via `IntersectionObserver` and honoring `prefers-reduced-motion`.
- **Bundled Fonts:**
  - `--font-sans`: `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
  - `--font-mono`: `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
  - `font-variant-numeric: tabular-nums` required on all diffs, counters, timers, and timestamps.
- **Dual Density:** `data-density="airy"` on Main Agent Chat (`14px–15px`, generous vertical rhythm); `data-density="compact"` on Bots Workbench (`12px–13px`, dense tabular scannability).
- **Light-Museum 3D Stage:** Three.js renders on demand over `#F5F5F5` with a subtle `#E5E5E5` architectural floor grid, soft studio lighting, camera presets (`Iso / Front / Top / Wire`), and clickable 3D surface pins.
