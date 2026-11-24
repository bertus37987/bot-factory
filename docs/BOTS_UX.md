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
  still steers the Team Lead. Pause, Resume and Stop stay in a retractable
  bear-paw control dock at the conversation edge and explicitly name their
  separate target; the dock opens on hover, focus, or tap so touch and
  keyboard users are not dependent on hover alone.
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

## Conversation-first project drawer

The Main drawer is not a file explorer. Projects expand into their two real
conversation surfaces: Main Agent for decisions and delivery, and Team Chat
for the project-backed team. Selecting a conversation is navigation only.
Artifacts and Git diff remain available as a restrained secondary Files
section; raw repository paths must not crowd out conversations.
