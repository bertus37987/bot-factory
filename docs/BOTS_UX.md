# Bots Team Inbox

The Main Orchestrator decides whether teams work in separate projects or
share one. Switching conversations is navigation, not a reassignment or
an instruction to an agent. Today the API exposes one team per project;
multiple teams in one project require real team identifiers, membership,
lead routing, and team-scoped feeds and boards. Do not infer teams from
names or role labels.

- One Team switcher selects an existing project team and opens its Group
  Chat. The drawer lists the selected team's conversations and workspace
  tools. Archived projects are not switch targets.
- Individual bot conversations show that bot's activity. The composer
  still steers the Team Lead. Bot Pause, Resume and Stop explicitly name
  their separate target.
- Drafts and attachments belong to the conversation in which they were
  entered. Switching does not send them and a failed send preserves them.
- Vanta Black remains the default; Light and the existing Bear Crew stay.
  Use rounded neutral surfaces, human messages on the right, bot messages
  on the left, and role color in attribution rather than whole bubbles.
  Keep technical traces collapsed and don't move the transcript while the
  operator is reading older messages.
- Team portrait clusters represent actual membership. One- and two-member
  teams use balanced compact portraits instead of empty grid positions;
  any remaining seat space is transparent background rather than hollow
  placeholder boxes. Teams with more than four members show the first
  three portraits and a fourth overflow seat such as `+2`; the accessible
  label uses the true team size.
