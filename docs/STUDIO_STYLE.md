# Rounded Studio Theme

Vanta Black is the default; Light keeps the same visual hierarchy. Reuse
`--studio-*` tokens from `apps/web/src/styles/tokens.css` for raised panels,
selection, chat bubbles and their radii. Keep the canvas neutral, use warm
color for outgoing messages, and use role color for attribution. Bears
represent agents and teams, not form controls.

- Main Agent and Bots share the chat palette and composer geometry. Main
  Agent stays editorial and free of raw team activity. Keep artifact,
  delivery, and review actions readable as cards, not chat bubbles.
- Browser tabs, Quick Open, Quick Jump and the project drawer use quiet
  rounded selections. Code, diffs, and media stay visually distinct.
- Task Board, Checkpoints and Merge, and Escalation Inbox use the same
  neutral surfaces with text and semantic colors for decisions and status.
  Visual changes do not alter approval or merge eligibility.
- Shared dialogs, settings fields, notifications and the unlock card use
  the same geometric scale. Do not use global button or radius overrides.

Review both themes at desktop, split and phone widths. Keep keyboard
focus visible, respect reduced motion, and test with the offline runtime.

## Seamless navigation and one-click workspace actions

- Use the labeled destination rail for Main, Teams, Browser, Search, Inbox,
  Memory, Settings and Theme. Tasks are a workspace surface inside a team,
  not a separate top-level destination. Destinations open their contextual
  panel; the panel close control must never cover header content. Split Chat
  is disabled: Main Agent and Teams are separate destinations rather than
  simultaneous panes.
- Show the named draft destination on the artifact action itself. A click
  only adds context; the composer has a separate, explicit send action.
- Use the vector Feltworks bear crew: head-only round plush bears with
  ears, expressive white eyes, contrasting muzzles, and vivid role colors
  that read sharply against Vanta Black (yellow Team Lead, dark-blue
  Builder, light-purple 3D Artist, light-green Research, and light-pink
  Verifier). Each role wears a large legible hat or tool accessory contained
  inside the portrait, sitting high between the ears. Rounded highlights,
  lower-face shading, and a restrained role-colored glow give the heads a
  dimensional vinyl-plush presence on black. Live bears blink on seeded
  individual timing; hover/focus and working states run role-specific pupil motion (scanning,
  crossing, darting, or asymmetrical glances). Working bears also get a
  three-dot loading indicator directly underneath the portrait. Older
  messages and team clusters stay still. Empty bot timelines introduce the
  bot as a large bear portrait rather than a generic thinking orb. Click
  the live header portrait to read the agent's role, status, and model.

- Prefer the handcrafted Bot-Factory geometric icon set for shell
  navigation. Use familiar control glyphs only where recognition matters
  (pause, stop, close); do not fill the shell with generic stock icons.
- Slash commands are composer content, not low-resolution popup labels.
  Recognized commands render as bold warm tokens inline in the composer,
  and the command menu uses larger command typography with readable
  descriptions. `/goal` remains inline so the operator can write the goal
  after the token; action commands still execute directly.

## Model target picker

The model selector is a keyboard-accessible route picker, not a flat
provider dump. It uses a fixed search field, provider sections, large
two-line rows, runtime badges, a clear selected route, and a footer with
keyboard affordances. Do not invent latency, cost, or quality metadata.
