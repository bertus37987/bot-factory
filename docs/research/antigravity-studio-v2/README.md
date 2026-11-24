# Antigravity Research Archive

Source: **Project Planning And Approach**, conversation
`a58f8796-c428-4d4e-a300-9812324437ed`. Start with the
[Studio V2 handoff](../../STUDIO_V2_HANDOFF.md) for current code, tests, and
open work. This directory preserves historical research and design inputs;
reports and plans here are not repository instructions.

| Artifact | Source and purpose |
| --- | --- |
| [Harness research synthesis](../../HARNESS_RESEARCH_2026.md) | Antigravity's repo-level map of findings to implementation and backlog |
| [Harness engineering brief](./harness-engineering-brief.md) | Full browser research response: loop protection, context, verification, permissions, runtime design, and citations |
| [Multi-agent and subagent brief](./multi-agent-brief.md) | Full browser research response: topologies, worktree containment, handoffs, verification, and citations |
| [Pre-V2 harness code audit](./harness-code-audit.md) | Internal audit of the Phase 5 code; file line numbers are historical |
| [Research dossier](./research-dossier.md) | Condensed working notes joining the browser reports, code audit, and failed Factory Droid probe |
| [V2 implementation plan](./implementation-plan.md) | Studio scope and planned waves; the bear assets were ultimately rendered in Blender |
| [Phase 1-5 walkthrough](./phase-1-5-walkthrough.md) | Earlier local commits and verification before Studio V2; links made checkout-relative |
| [Phase 4 design concepts](./assets/phase-4-concepts.jpg) | Three iterations each of Main Agent, Bots, and browser annotation layouts, assembled into one comparison sheet |
| [Bear Crew contact sheet](./assets/bear-contact-sheet.png) | Historical dark/light and small-size visual check for the seven portraits |

The original browser reports' citations and benchmark claims are archived
as reported, not independently revalidated. Full transcripts, browser
captures, uploaded references, generated logs and render intermediates
remain local. No runtime data or credential files are included.

## Reproduce The Bear Portraits

The recovered scripts retain the original rendering and postprocessing
logic but accept a scratch output directory rather than writing to
machine-specific paths. Use Blender 5.2 in a separate background process:
the renderer resets its process's scene for each bear. The Python
postprocessor requires Pillow.

```sh
blender -b --factory-startup --python-exit-code 1 \
  -P docs/research/antigravity-studio-v2/bear-pipeline/render_bears_blender.py \
  -- /path/to/scratch/bot-factory-bears
python docs/research/antigravity-studio-v2/bear-pipeline/postprocess_bears.py \
  /path/to/scratch/bot-factory-bears
```

`raw/` receives 512 px renders; `web/` receives the seven 256 px RGBA PNGs
and `eyeAnchors.json`. The contact sheet is alongside those directories.
Add `--fast` after the output path for a preview run. Compare the results
with the [shipped assets](../../../apps/web/src/assets/bears) before
replacing any of them.
