# Bot-Factory — Vanta Grid Design System

This document is the locked visual contract for the Phase 3 UI rebuild. The reference aesthetic is **Vanta Black + tactile grainy indigo glow + dark white typography + exposed dashed architectural grid**.

## 1. Non-Negotiable Material Rules

1. **Canvas is black.** The application canvas is `#000000`; surfaces are nearly black rather than blue-gray or purple-gray.
2. **Dark white, not white.** Large typography uses muted dark white `#DFDFE4`; pure white is reserved only for tiny inverted-highlight details when contrast requires it.
3. **Architecture stays visible.** Major layout seams use exposed `1px dashed rgba(255,255,255,0.09)` gridlines. Active frames use `1px solid rgba(255,255,255,0.16)` with square intersection nodes.
4. **Indigo is a signal, not decoration.** The cobalt-indigo grain material marks live activity, selected workspace accents, key progress/timeline bars, and streaming states only. It is never a generic glossy button treatment or halo around every card.
5. **Sharp geometry.** Grid cells and badges use `0px–2px` corners. Inputs and controls may use at most `4px`. No pill-shaped architectural panels, no heavy static shadows, no emoji UI icons.
6. **Precision type.** UI uses bundled Space Grotesk; metadata, identifiers, tool traces, counters, timestamps, and badges use bundled JetBrains Mono. Numeric data must use `font-variant-numeric: tabular-nums`.
7. **Local assets only.** No CDN fonts, images, scripts, or runtime icon dependencies.

## 2. Locked Core Tokens

Canonical values live in `apps/web/src/styles/tokens.css`.

| Role | Token | Value |
| :--- | :--- | :--- |
| Canvas | `--bg-canvas` | `#000000` |
| Surface 1 | `--bg-surface-1` | `#070709` |
| Surface 2 | `--bg-surface-2` | `#0F0F14` |
| Structural grid | `--border-grid` | `rgba(255,255,255,0.09)` |
| Active frame | `--border-active` | `rgba(255,255,255,0.16)` |
| Primary text | `--text-primary` | `#DFDFE4` |
| Secondary text | `--text-secondary` | `#8E8E98` |
| Muted text | `--text-muted` | `#55555F` |
| Inverted badge surface | `--badge-inverted-bg` | `#DCDCE2` |
| Inverted badge text | `--badge-inverted-text` | `#050507` |

### Indigo Grain Material

- Gradient: `#080620 -> #1F1680 -> #4432E8`
- Noise: SVG `feTurbulence` fine film grain
- Noise opacity: `0.16–0.22`
- Blend mode: `overlay`
- Geometry: sharp rectangular panels, normally `0px–2px`

Use the material through `.bf-glow-panel` or focused state-specific selectors. Do not paste one-off neon shadows or generic gradient buttons.

## 3. Layout Grammar

- The shell is an exposed measurement grid: hard black voids, dashed vertical/horizontal seams, and sharp rectangular content cells.
- Active cells receive a solid hairline frame and optional square corner nodes; inactive structure remains dashed and quiet.
- Inverted chips carry high-signal facts: mode, model, cost/credits, verification state, and concise numeric metadata.
- Cards should feel plotted on the grid, not floating above it. Popovers and modals may use restrained elevation because they are temporary layers.
- Empty states are architectural compositions: dashed frame, mono uppercase label, concise action copy, and at most one indigo signal bar.

## 4. Interaction States

Every core view must visibly handle:

- `default` — black surface, dashed or quiet hairline structure
- `hover` — slight surface lift (`#0F0F14`) and stronger hairline, no glow bloom
- `active` / `selected` — solid frame, inverted chip or small indigo grain bar
- `focus-visible` — crisp dark-white outer ring, never browser-default blue
- `loading` / `streaming` — indigo grain shimmer or pulse restricted to the active progress element
- `empty` — dashed architectural frame plus concise mono label and action
- `error` — sharp red-orange signal text/border while preserving grid geometry

All animation must collapse to static state under `@media (prefers-reduced-motion: reduce)`.

## 5. Component Rules

- **Badges/chips:** rectangular, uppercase or small mono text, `0px–2px` radius, inverted fill for highest-signal facts.
- **Buttons:** rectangular or max `4px` controls. Primary actions use inverted dark-white fill; destructive and permission-critical actions may use semantic signal borders. Indigo grain is not a default button fill.
- **Inputs:** black/near-black fields, max `4px` radius, dashed or solid hairline border, visible focus ring.
- **Tables/timelines:** mono tabular numerals, dashed row/column separators, active rows use a narrow indigo grain bar or solid frame.
- **Panels:** near-black surfaces aligned to grid seams; no large blurred neon shadows.
- **Icons:** consistent `1.5px` stroke SVG icons only.

## 6. Themes

Vanta Grid is the default and primary published theme. The legacy light theme remains as an accessibility/alternate theme, but new components must be token-driven so Vanta Grid remains exact.
