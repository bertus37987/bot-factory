# Bot-Factory Studio V2 Handoff

Recovered from Antigravity's **Project Planning And Approach** conversation
(`a58f8796-c428-4d4e-a300-9812324437ed`, November 23-24, 2026). The source
checkout's earlier Phase 1-5 work is already in Git (`4afa8a1` through
`a785bba` on top of `ba4439d`). This handoff covers the Studio V2 work
recovered on top of `a785bba`; it supersedes the Phase 5 UI status in
[`HANDOFF.md`](../HANDOFF.md) and [`DESIGN.md`](../DESIGN.md).

## Where To Start

| Area | Current behavior | Entry points |
| --- | --- | --- |
| Studio shell and chat | Vanta Black by default, Light toggle, collapsible/resizable sidebar, split chat, role-attributed chat bubbles and seven bear portraits with an SVG eye layer | [`App.tsx`](../apps/web/src/App.tsx), [`tokens.css`](../apps/web/src/styles/tokens.css), [`BotChatStream.tsx`](../apps/web/src/bots/BotChatStream.tsx), [`BotAvatars.tsx`](../apps/web/src/components/BotAvatars.tsx) |
| Browser and composer | Right, bottom, floating and fullscreen browser modes. Editable Markdown, image markup/crop, and 3D review can feed context into the active chat composer. Preview cards are local UI; submission serializes the attachment context as Markdown, not a native multimodal upload. | [`BrowserWorkspaceShell.tsx`](../apps/web/src/browser/BrowserWorkspaceShell.tsx), [`InAppBrowser.tsx`](../apps/web/src/browser/InAppBrowser.tsx), [`PrecisionComposer.tsx`](../apps/web/src/components/PrecisionComposer.tsx) |
| Team work | Animated task list grouped by all tasks, bot, or status, with inline task actions accessible from the Bots page | [`BotsTab.tsx`](../apps/web/src/bots/BotsTab.tsx), [`TodoBoardView.tsx`](../apps/web/src/bots/TodoBoardView.tsx) |
| Main Agent and artifact contracts | Main Agent config, bot and task controls; `bot.update_model` / `bot.message`; SQLite v3 message sender attribution; authenticated, scoped artifact writes with format and size limits | [`shared/index.ts`](../packages/shared/src/index.ts), [`agentTools.ts`](../apps/daemon/src/orchestration/agentTools.ts), [`database.ts`](../apps/daemon/src/db/database.ts), [`server.ts`](../apps/daemon/src/rpc/server.ts) |
| Harness | Conversation history and compaction, bounded tool loops, verifier retry feedback, independent DAG progress, subagent result envelopes and worktree containment, Codex CLI resume | [`HARNESS_RESEARCH_2026.md`](./HARNESS_RESEARCH_2026.md), [`harness_upgrades.test.ts`](../tests/harness_upgrades.test.ts) |

## Research And Design

The [Bots UX spec](./BOTS_UX.md) records the team organization decision
and the interaction model for the Bots inbox.

The [research archive](./research/antigravity-studio-v2/README.md) contains
the implementation plan, both source-cited browser research briefs, the
pre-V2 internal harness audit, the condensed dossier, the Phase 1-5
walkthrough, design concepts, and the bear art pipeline.

The Factory Droid probe returned HTTP 402 (no active subscription), so no
live Droid audit was completed. The `factory-droid-acp` example is an
optional preset, not a verified provider integration.

## Verification

From the repo root on a clean checkout with Bun and Python Playwright
Chromium installed:

```sh
bun install --frozen-lockfile
bun run build:web
bun run check
```

Build first: Playwright consumes `apps/web/dist`, but `check` invokes
tests before its build step. The recovery run passed TypeScript, Biome
(422 warnings, zero errors), all **54 tests** across 10 files including
headless Chromium, and the web build. Vite still warned about chunks over
500 kB. `bun run doctor` also passed against a fresh temporary runtime
root. Tests used isolated runtimes or a temporary copy of the existing
database; the running daemon was not restarted.

## Open Work

- The [research matrix](./HARNESS_RESEARCH_2026.md#4-implementation-matrix-implemented-now-bot-factory-v2-vs-future-roadmap) tracks DAG goal rehydration across restarts, context-window-aware compaction, bounded memory reads and dreaming retries, and OS-level subprocess sandboxing.
- Live model credentials and subscriptions were not exercised in the recovery checks. Use the existing approval and containment boundaries in [`AGENTS.md`](../AGENTS.md) rather than enabling live providers for routine tests.
