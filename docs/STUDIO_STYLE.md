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

## One-click workspace actions

- Keep Split and Browser directly available in the header. Label the panes
  locally. Focus is a keyboard and composer cue, not a global status pill.
- Show named draft destinations on the artifact action itself. In split
  view both visible conversations are direct choices. A click only adds
  context; the composer has a separate, explicit send action.
- Use live bear motion for real activity or a brief hover/focus response.
  Older messages and team clusters stay still. Click the live header
  portrait to read the agent's role, status, and model.
