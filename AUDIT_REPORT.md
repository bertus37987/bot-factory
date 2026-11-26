# Bot-Factory Publishing & Engineering Audit

Date: 2026-11-25  
Scope: read-only audit of the full repository before publishing hardening and the Vanta Grid UI rebuild. No production source files were modified during this audit.

## Executive Verdict

**Not publishing-ready yet.** The monorepo has a strong architectural foundation, strict TypeScript passes, the production web build succeeds, the daemon boots in isolated mode, and most security invariants are implemented deliberately. However, the current gate fails because:

1. The automated test suite is red on a clean non-Windows machine: **50 pass, 1 skip, 3 fail**.
2. Verification commands inherit almost the entire daemon process environment and can expose provider API keys to untrusted project code.
3. The exposed `high` autonomy mode bypasses meaningful permission boundaries in ACP/Claude execution, and even `medium` auto-approves arbitrary read commands outside the worktree when paths are not modelled as `locations`.
4. Public publishing metadata is incomplete: there is no license file and no configured dependency vulnerability scanner.

Recommended gate decision: **fix P0/P1 first, then rebuild the UI.** Most P0 fixes are small and non-breaking, but the autonomy permission semantics are a product/security decision and should be explicitly approved before implementation.

---

## Verification Snapshot

| Check | Result | Evidence |
|---|---:|---|
| `bun install --frozen-lockfile` | PASS | 94 installs / 152 packages checked, no changes |
| `bun run typecheck` | PASS | strict `tsc --noEmit`; strict mode enabled in `tsconfig.json:6` |
| `bun run lint` | PASS exit code, but noisy | Biome reports **422 warnings + 15 infos** across 75 files |
| `bun run build:web` | PASS with warning | Vite build succeeds; `Model3DViewer` chunk ~596.88 kB and main chunk ~640.97 kB, both over 500 kB |
| `BOT_FACTORY_SKIP_PLAYWRIGHT=1 bun test tests` | **FAIL** | 50 pass, 1 skipped, **3 failed** |
| `bun run doctor` with fresh temp `BOT_FACTORY_ROOT` | PASS | read-only doctor exits 0 |
| Isolated daemon boot | PASS | `.dev-runtime` daemon serves authenticated UI at `127.0.0.1:4310` |
| Dependency license scan | PASS with caveat | 89 packages, permissive licenses only; project itself has no license |
| Dependency vulnerability scan | **NOT CONFIGURED** | `bun pm scan` refuses to run without a scanner in `bunfig.toml` |

---

# 1. Architecture & Code Quality

## What is strong

- The single-writer SQLite design is explicit and enforced with a lock file, runtime epoch, WAL, foreign keys, and busy timeout in `apps/daemon/src/db/database.ts:92-106`.
- Lock acquisition is atomic (`openSync(..., "wx")`) and stale lock recovery validates PID ownership in `apps/daemon/src/db/database.ts:109-210`.
- Command/event/outbox writes are committed atomically in one DB transaction in `apps/daemon/src/core/commandCore.ts:64-79`.
- Outbox dispatch has lane separation, concurrency keys, bounded work concurrency, retry backoff, and dead-letter handling in `apps/daemon/src/core/commandCore.ts:176-270`.
- Shared wire contracts are centralized in Zod schemas in `packages/shared/src/index.ts:5-127`, including a hard-coded localhost-only hub host at `packages/shared/src/index.ts:66-75`.

## Findings

### P1 — Core files are oversized and now carry multiple unrelated responsibilities

Exact sizes measured in this checkout:

- `apps/daemon/src/orchestration/engine.ts` — 3,839 lines
- `apps/web/src/styles/app.css` — 3,824 lines
- `apps/daemon/src/db/database.ts` — 2,208 lines
- `apps/web/src/App.tsx` — 1,969 lines
- `apps/daemon/src/runtimes/nativeHttpRuntime.ts` — 1,913 lines
- `apps/daemon/src/git/worktrees.ts` — 1,738 lines
- `apps/daemon/src/orchestration/agentTools.ts` — 1,541 lines

This is not an immediate correctness bug, but it raises review cost and regression risk. `engine.ts` in particular mixes command handling, orchestration policy, session lifecycle, merge flow, debates, and self-mod wiring. Splitting should happen after publishing blockers are fixed, not as part of the UI rebuild.

### P1 — Biome reports hundreds of warnings while the lint gate still exits zero

`bun x biome check --max-diagnostics=1000 packages apps tests` reports **422 warnings and 15 infos** but exits 0. Warning concentration:

- `tests/phase3_autonomous_subagents_merge.test.ts` — 54
- `tests/phase1_security_parallel_recovery.test.ts` — 45
- `apps/web/src/browser/DocViewer.tsx` — 32
- `tests/phase2_byos_streaming_memory.test.ts` — 29
- `tests/harness_upgrades.test.ts` — 27
- `apps/web/src/client/useBotFactory.ts` — 22
- `apps/web/src/components/MarkdownRenderer.tsx` — 19
- `apps/daemon/src/orchestration/engine.ts` — 18

Examples include non-null assertions (`apps/daemon/src/orchestration/agentTools.ts:1253`, `apps/daemon/src/orchestration/autonomyLoop.ts:112`, `apps/daemon/src/orchestration/autonomyLoop.ts:272`) and type-only imports (`apps/daemon/src/memory/memoryEngine.ts:5`). A publishing gate should either fix the warnings or consciously suppress/rule-configure accepted patterns; currently the signal is noise.

### P1 — Atomic file writes can block the daemon event loop

Two independent atomic-write helpers use `Atomics.wait` for Windows retry behavior:

- `apps/daemon/src/rpc/server.ts:56-82` (`writeArtifactAtomically`, especially lines 59-70)
- `apps/daemon/src/config.ts:60-75` (`renameSyncWithRetry`)

`Atomics.wait` synchronously blocks the JavaScript thread. In the daemon this can stall HTTP/WebSocket handling and outbox progression for up to several hundred milliseconds under file-lock contention. This should be replaced with asynchronous retry/backoff or isolated synchronous startup-only use.

### P2 — Dead/unused React component: `AnnotationOverlay`

`apps/web/src/browser/AnnotationOverlay.tsx` exports `AnnotationOverlay` at `apps/web/src/browser/AnnotationOverlay.tsx:54-70`, but no other source file imports or references that component. The active browser viewers pass annotation data directly through `apps/web/src/browser/InAppBrowser.tsx:344`, `:356`, and `:388`. Either wire the shared overlay in or remove the duplicate/dead implementation.

### P2 — Production bundle has large initial chunks

`bun run build:web` succeeds but warns that chunks exceed 500 kB:

- `dist/assets/Model3DViewer-*.js` — about 596.88 kB minified
- `dist/assets/index-*.js` — about 640.97 kB minified

`Model3DViewer` is already lazy-loaded, so this is not a startup disaster, but the main bundle still deserves route-level code splitting before broad distribution.

---

# 2. Backend & Agent Runtime

## What is strong

- Recovery semantics intentionally mark previous-epoch effects/admissions as retired/unknown instead of blindly replaying them (`apps/daemon/src/db/database.ts:105`, recovery invoked from `apps/daemon/src/index.ts:236-238`).
- ACP and CLI runtime teardown clears pending permissions/requests and has explicit Windows `taskkill /T /F` handling, e.g. `apps/daemon/src/runtimes/acpSubprocessRuntime.ts:914-985` and `apps/daemon/src/runtimes/cliStreamRuntime.ts:1121-1186`.
- Native HTTP provider calls are bounded by request timeouts and central error normalization (`apps/daemon/src/runtimes/nativeHttpRuntime.ts:26-32`, `:688-753`).
- CLI/ACP child environments are built from a small allowlist rather than blindly forwarding all environment variables (`apps/daemon/src/runtimes/acpSubprocessRuntime.ts:110-138`).

## Findings

### P0 — Project verification checks inherit the daemon's full process environment

`buildVerifyCheckEnv` copies `process.env` and deletes only `BOT_FACTORY_TOKEN` in `apps/daemon/src/phase3/verifier.ts:137-140`. Verification commands are then executed through a shell in `apps/daemon/src/phase3/verifier.ts:230-249`.

Verified locally with a canary variable:

```text
TEST_SECRET=supersecret-value
printenv TEST_SECRET -> exit 0: supersecret-value
```

Impact: arbitrary project test/build scripts — including code generated by an agent inside a worktree — can read and exfiltrate exported provider keys such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or cloud credentials if the user exports them before launching the daemon. Output scrubbing does not help because the scrubber cannot know unrelated environment secrets.

Required fix: use a minimal allowlisted environment for verification commands, explicitly pass only non-secret runtime variables, and never inherit API-key-shaped variables by default.

### P0 — `high` autonomy bypasses meaningful containment in both ACP and Claude CLI execution

For ACP, `autonomyLevel === "high"` returns unconditional `allow` after only a narrow destructive-pattern check in `apps/daemon/src/runtimes/acpSubprocessRuntime.ts:274-281`. Unlike medium mode, it does not apply the network-command escalation checks at `apps/daemon/src/runtimes/acpSubprocessRuntime.ts:294-307`.

Verified locally:

```text
curl https://evil.example/x
medium -> escalate network_command_requires_approval
high   -> allow high_autonomy_in_worktree
```

For Claude CLI, high autonomy explicitly launches with `--permission-mode bypassPermissions --allow-dangerously-skip-permissions` in `apps/daemon/src/runtimes/cliStreamRuntime.ts:390-399`. That is not “inside the worktree only”; it delegates unrestricted host access to the model-driven subprocess.

This contradicts the documented claim that high autonomy auto-approves only inside an isolated worktree (`apps/daemon/src/runtimes/acpSubprocessRuntime.ts:194-200`) and is unsafe to publish without an explicit redesign, warning, or OS-level sandbox.

### P0 — `medium` autonomy auto-approves arbitrary read commands outside the worktree when locations are absent

The medium shell allowlist includes generic read commands (`cat`, `head`, `tail`, `rg`, `grep`, `find`) in `apps/daemon/src/runtimes/acpSubprocessRuntime.ts:96-107`. If a shell tool call does not supply structured `locations`, the command text is not parsed for path containment. The medium policy then allows it as a “safe shell command in worktree” at `apps/daemon/src/runtimes/acpSubprocessRuntime.ts:294-307`.

Verified locally:

```text
cat /etc/passwd              -> medium allow safe_shell_command_in_worktree
cat ~/.aws/credentials       -> medium allow safe_shell_command_in_worktree
cat ~/.config/gh/hosts.yml   -> medium allow safe_shell_command_in_worktree
```

This is a real containment bypass. The fact that `cat ~/.ssh/id_rsa` happened to escalate because the string `.ssh` matches the `ssh` network regex does not mitigate the broader issue.

Required fix: parse shell command arguments conservatively, treat unreadable/unparseable shell commands as escalation, remove generic file-read commands from the auto-allow shell list unless every path is proven inside the worktree, and add regression tests for `/etc/passwd`, cloud credentials, SSH, GitHub CLI config, and network exfiltration.

### P1 — POSIX process-tree cleanup is incomplete

Windows cleanup uses `taskkill /T /F`, but POSIX cleanup only calls `proc.kill()` on the direct child:

- ACP: `apps/daemon/src/runtimes/acpSubprocessRuntime.ts:925-941` and `:961-978`
- CLI stream: `apps/daemon/src/runtimes/cliStreamRuntime.ts:1134-1150` and `:1167-1184`
- Verifier: `apps/daemon/src/phase3/verifier.ts:143-164`

Agent CLIs and verification scripts can spawn grandchildren. On macOS/Linux those grandchildren are not reliably terminated because the code does not create or kill a process group/session. This can leak processes after aborts, timeouts, or daemon shutdown.

### P1 — OS-level sandboxing is still roadmap work, while high-risk execution is already exposed

The current handoff explicitly lists “OS-level subprocess sandboxing” as open work in `docs/STUDIO_V2_HANDOFF.md:50-53`. Given the permission bypasses above, publishing before either implementing sandboxing or narrowing autonomy semantics would be misleading.

### P2 — Malformed provider responses mostly degrade to turn errors, but response validation is shallow

`iterSseOrJson` accepts arbitrary JSON/text and parses loose SSE frames in `apps/daemon/src/runtimes/nativeHttpRuntime.ts:592-630`; top-level `sendTurn` catches parser/network exceptions and yields a normalized error at `apps/daemon/src/runtimes/nativeHttpRuntime.ts:744-753`. This prevents daemon crashes, but provider payloads are not schema-validated before being interpreted. This is acceptable for a local power-user tool, but publishing hardening should add stricter shape validation per protocol.

---

# 3. Security & Publishing Hygiene

## What is strong

- Host is schema-constrained to `127.0.0.1` in `packages/shared/src/index.ts:66-75`.
- Host/Origin validation is implemented in `apps/daemon/src/rpc/server.ts:150-165`.
- API routes are authenticated before dispatch at `apps/daemon/src/rpc/server.ts:364-368`.
- Session tokens are HMAC-signed into `HttpOnly; SameSite=Strict` cookies in `apps/daemon/src/rpc/server.ts:123-130` and `:197-199`.
- Secrets API never returns plaintext secret values; GET returns only key presence metadata in `apps/daemon/src/rpc/server.ts:392-397`, while POST validates keys/values at `:399-421`.
- No real hardcoded API keys were found in the repository scan. Matches are test fixtures/canaries such as `tests/memory_acp_mcp.test.ts:248-249` and `tests/ui_e2e_playwright.py:409`.

## Findings

### P0 — No project license file

There is no `LICENSE`, `LICENSE.md`, `COPYING`, or `NOTICE` at the repository root. Dependency licenses themselves are permissive (`MIT`, `Apache-2.0`, `BSD-3-Clause`, `ISC`, `OFL-1.1`, `CC-BY-4.0` for data), but downstream users currently have no explicit right to use, modify, or redistribute Bot-Factory. This is a hard blocker for public source publishing.

### P1 — Personal machine paths and username are embedded in published docs/tests

Examples:

- `README.md:16` — `C:\Users\willy\source\repos\bot-factory`
- `HANDOFF.md:36` — same Windows checkout path
- `docs/ARCHITECTURE_AND_UI_SPEC.md:31` — same checkout path
- `tests/phase1_security_parallel_recovery.test.ts:1120-1123` — `C:\Users\willy\bot-factory\system`

This is both privacy/publishing hygiene noise and a direct test portability failure (see P0 test finding below).

### P1 — Dependency vulnerability scanning is not configured

`bun pm scan` exits with “no security scanner configured” because there is no scanner configuration in a root `bunfig.toml` (file absent). The CI workflow `.github/workflows/ci.yml:23-39` also does not run a dependency vulnerability audit. License inventory is clean, but vulnerability status is unknown.

### P1 — Config schema permits plaintext provider environment values and `/api/config` returns full config

`ProviderConfigSchema` accepts arbitrary `env` records in `packages/shared/src/index.ts:30-55` (especially line 52). `GET /api/config` returns `this.runtimeCfg.config` without redaction in `apps/daemon/src/rpc/server.ts:388-390`. Users should be steered to `apiKeyEnv` + `secrets.env`, but the current shape makes it easy to persist plaintext secrets in `config.json` and then expose them to any authenticated local UI session. At minimum, secret-looking `env` values should be rejected or redacted.

### P1 — Static UI path handling does not fail closed for Windows drive-letter paths on POSIX

`serveStaticUi` strips leading slashes and passes the result to `isPathStrictlyWithinRoot` in `apps/daemon/src/rpc/server.ts:860-881`, especially `:873-875`. On macOS/Linux, `/C:/Windows/win.ini` becomes a relative path inside `apps/web/dist`; because it does not exist, the SPA fallback returns `index.html` with HTTP 200 at `apps/daemon/src/rpc/server.ts:879-882`. The test explicitly expects 403 in `tests/phase1_security_parallel_recovery.test.ts:373-376`.

This does not directly read the target file on POSIX, but it violates the fail-closed contract and leaves platform-dependent behavior in a security boundary.

### P1 — Symlink canonicalization is pathologically false-negative on macOS temp roots

Dangling symlink handling resolves link targets textually in `apps/daemon/src/runtimes/nativeHttpRuntime.ts:91-108` and then validates containment in `:166-197`. On macOS, temp paths commonly exist under `/var/...` while `realpathSync` canonicalizes roots to `/private/var/...`. An in-root dangling symlink created with the unc canonicalized `/var/...` path is therefore incorrectly rejected. This is exactly what the test expects to remain allowed at `tests/phase1_security_parallel_recovery.test.ts:404-414`.

### P2 — `.gitignore` is good but incomplete for common verification artifacts

`.gitignore` correctly excludes dependencies, build output, runtime DB files, tokens, env files, keys, logs, staging, backups, and projects (`.gitignore:1-30`). It does not exclude common local artifacts such as `coverage/`, `test-results/`, `playwright-report/`, or `*.log`. The current biome config mentions `coverage`, so coverage output is a realistic local artifact.

---

# 4. Build, Tests & Developer Experience

## What is strong

- Frozen install works.
- Strict TypeScript passes (`tsconfig.json:6`).
- Production web build works.
- Isolated daemon startup works without touching `~/bot-factory`.
- `doctor` is genuinely read-only against a fresh temp root and exits 0.
- CI exists and runs install, typecheck, lint, build, and tests (`.github/workflows/ci.yml:23-39`).

## Findings

### P0 — Test suite is red on a clean macOS/Linux checkout

Command:

```bash
BOT_FACTORY_SKIP_PLAYWRIGHT=1 bun test tests
```

Result: **50 pass, 1 skip, 3 fail** (54 tests across 10 files).

Failures:

1. Static Windows drive-letter traversal returns HTTP 200 instead of 403. Assertion: `tests/phase1_security_parallel_recovery.test.ts:373-376`; implementation: `apps/daemon/src/rpc/server.ts:873-881`.
2. In-root dangling symlink is rejected on macOS although it should remain allowed. Assertion: `tests/phase1_security_parallel_recovery.test.ts:398-414`; implementation: `apps/daemon/src/runtimes/nativeHttpRuntime.ts:91-108` and `:166-197`.
3. Migration test requires a nonexistent hardcoded personal Windows database. Assertion/setup: `tests/phase1_security_parallel_recovery.test.ts:1120-1123`.

Because CI runs on Ubuntu (`.github/workflows/ci.yml:15`), the first two portability failures are expected to reproduce there; the third always fails anywhere except the original author's Windows machine.

### P1 — Browser UI E2E is effectively absent from CI

CI unconditionally sets `BOT_FACTORY_SKIP_PLAYWRIGHT=1` in `.github/workflows/ci.yml:16-18`. The Playwright test then skips itself through `tests/ui_e2e.test.ts:16-19` and `:52-55`. This means the only end-to-end browser regression test never runs in CI.

### P1 — `bun run check` is not zero-friction on a clean checkout

`package.json:19` runs `typecheck && lint && bun test tests && build:web`, but the Playwright test requires `apps/web/dist/index.html` (`tests/ui_e2e.test.ts:7-9`, `:95-97`). Docs correctly tell users to build first (`README.md:124-127`, `HANDOFF.md:40`), but the single verification command itself remains order-dependent. Build should run before tests inside `check`.

### P1 — Playwright runner assumes a `python` executable

The probe and child process invoke `python` in `tests/ui_e2e.test.ts:21-32` and `:119-124`. This machine has `python3` but no `python` command. On a clean macOS/Linux setup, local browser E2E is therefore harder than documented even if Playwright is installed for Python 3.

### P1 — Documentation currently overstates verification health

`docs/STUDIO_V2_HANDOFF.md:42-48` says the recovery run passed all 54 tests including headless Chromium. That may have been true in the original environment, but the current clean checkout does not reproduce it: three tests fail and Chromium E2E is skipped unless Python Playwright is manually provisioned. Publishing docs should state current reproducible requirements accurately.

### P2 — Optional Factory Droid provider preset is explicitly unverified

`config.example.json:116-127` ships a `factory-droid-acp` preset. The handoff says the probe returned HTTP 402 and no live Droid audit was completed (`docs/STUDIO_V2_HANDOFF.md:27-29`). It should be clearly labelled experimental/unverified in UX/docs or removed from the default publishing example.

---

# 5. UI/UX Audit — Current State

## What is strong

- The UI already boots and renders a coherent dark shell.
- Empty states exist for chat (`apps/web/src/chat/ChatTab.tsx:195-211`), bots (`apps/web/src/bots/BotsTab.tsx:548-550`), and the project drawer (`apps/web/src/App.tsx:942`, `:1152-1153`).
- Error surfaces exist in chat (`apps/web/src/chat/ChatTab.tsx:184-188`), bots (`apps/web/src/bots/BotsTab.tsx:533-540`), settings (`apps/web/src/studio/SettingsView.tsx:436-439`), and reconnect toast/banner logic (`apps/web/src/App.tsx:1366-1367`).
- Streaming states exist for main chat (`apps/web/src/chat/ChatTab.tsx:411-416`) and bot chat (`apps/web/src/bots/BotChatStream.tsx:804-845`).
- Reduced-motion guards exist in `apps/web/src/styles/tokens.css:476-491`, `apps/web/src/styles/app.css:3814-3824`, and `apps/web/src/bots/TodoBoardView.css:1286-1305`.
- Tabular numerals are already used broadly (`apps/web/src/styles/tokens.css:472-474` plus many component rules).

## Findings

### P1 — Current visual system does not match the requested Vanta Grid north star

The current token system is a rounded, orange-accent, multi-color messenger palette:

- Near-white text `--ink-primary: #f5f5f7` instead of the requested muted dark white `#DFDFE4`: `apps/web/src/styles/tokens.css:27-31`
- Burnt-orange accent tokens instead of the indigo signature material: `apps/web/src/styles/tokens.css:39-44`
- Multi-color role bubble palette: `apps/web/src/styles/tokens.css:46-84`
- Rounded geometry scale up to pill radii: `apps/web/src/styles/tokens.css:177-188`
- Modal/popover shadows: `apps/web/src/styles/tokens.css:190-196`
- No `--bg-surface-1`, `--bg-surface-2`, `--border-grid`, `--text-primary`, `--text-secondary`, `--badge-inverted-*`, or cobalt/indigo grain tokens exist in `apps/web/src/styles/tokens.css:6-246`
- No `feTurbulence` usage or `#080620 / #1F1680 / #4432E8` signature gradient exists in `apps/web/src`

The current app is visually black, but not the requested exposed dashed architectural grid with sharp rectangular indigo signal blocks.

### P1 — Geometry and elevation conflict with the target craft rules

Examples of rounded/pill geometry and shadows:

- pill button/checkbox radii in `apps/web/src/styles/app.css:144-161`
- modal/popover shadow usage in `apps/web/src/styles/app.css:720`, `:1281`, `:1504-1510`, `:3437`, `:3531`, `:3685`
- task board glow/pulse shadows in `apps/web/src/bots/TodoBoardView.css:15-42` and card shadow at `:394-404`
- composer pill/progress rounding in `apps/web/src/components/PrecisionComposer.css:33-43`

The target requires sharp architectural geometry (`0–2px`, max `4px` on controls) and no heavy shadows/glossy neon treatment.

### P1 — Loading states are inconsistent and not accessibility-complete

There are textual loading states in viewers (`apps/web/src/browser/Model3DViewer.tsx:142`, `apps/web/src/browser/CodeViewer.tsx:262`, `apps/web/src/browser/DocViewer.tsx:959`), and chat streaming exists, but there is no consistent `aria-busy`/skeleton/shimmer contract across Chat, Bots/Swarms, Task Board, Previews, and Settings. The required grainy indigo loading/active material does not exist yet.

### P2 — Inline ad-hoc styling bypasses the design-token layer in places

Examples:

- `apps/web/src/studio/ProjectModal.tsx:298` uses inline dashed border styling.
- `apps/web/src/browser/DocViewer.tsx:959` uses inline color/font sizing for loading.
- `apps/web/src/browser/ImageViewer.tsx:1018` hardcodes a cyan crop border.

This is not functionally broken, but it will fight token enforcement during the rebuild.

### P2 — Current UI has mixed legacy design documents

`DESIGN.md` is historical Light Mode guidance, while `docs/STUDIO_V2_HANDOFF.md:7-8` says it supersedes older Phase 5 UI status. Before the rebuild, `DESIGN.md` must be replaced or clearly rewritten as the authoritative Vanta Grid spec to prevent agents from implementing the wrong system.

---

# 6. Publishing Blockers Summary

| ID | Severity | Finding | Primary evidence |
|---|---|---|---|
| P0-1 | Must fix | Verification checks inherit full daemon process env and can expose provider secrets | `apps/daemon/src/phase3/verifier.ts:137-140`, `:230-249` |
| P0-2 | Must fix | `high` autonomy bypasses ACP/Claude permission containment | `apps/daemon/src/runtimes/acpSubprocessRuntime.ts:274-281`; `apps/daemon/src/runtimes/cliStreamRuntime.ts:390-399` |
| P0-3 | Must fix | `medium` autonomy auto-approves arbitrary shell reads outside worktree when `locations` are absent | `apps/daemon/src/runtimes/acpSubprocessRuntime.ts:96-107`, `:294-307` |
| P0-4 | Must fix | Test suite red: static traversal, symlink canonicalization, hardcoded personal DB path | `tests/phase1_security_parallel_recovery.test.ts:373-376`, `:398-414`, `:1120-1123` |
| P0-5 | Must fix | No license file for public publishing | repo root; no `LICENSE*` present |
| P1-1 | Should fix | POSIX process cleanup does not kill process trees/grandchildren | `apps/daemon/src/runtimes/acpSubprocessRuntime.ts:925-941`, `:961-978`; `apps/daemon/src/runtimes/cliStreamRuntime.ts:1134-1150`, `:1167-1184`; `apps/daemon/src/phase3/verifier.ts:143-164` |
| P1-2 | Should fix | Browser E2E never runs in CI | `.github/workflows/ci.yml:16-18`; `tests/ui_e2e.test.ts:16-19`, `:52-55` |
| P1-3 | Should fix | `bun run check` order depends on prior web build | `package.json:19`; `tests/ui_e2e.test.ts:95-97` |
| P1-4 | Should fix | 422 Biome warnings create noisy quality gate | examples: `apps/daemon/src/orchestration/agentTools.ts:1253`; `apps/daemon/src/orchestration/autonomyLoop.ts:112`, `:272` |
| P1-5 | Should fix | Personal username/machine paths in docs/tests | `README.md:16`; `HANDOFF.md:36`; `docs/ARCHITECTURE_AND_UI_SPEC.md:31`; `tests/phase1_security_parallel_recovery.test.ts:1120-1123` |
| P1-6 | Should fix | No dependency vulnerability scanner in local/CI workflow | root `bunfig.toml` absent; `.github/workflows/ci.yml:23-39` |
| P1-7 | Should fix | Plaintext provider `env` values can persist/expose secrets through config | `packages/shared/src/index.ts:30-55`; `apps/daemon/src/rpc/server.ts:388-390` |
| P1-8 | Should fix | Static UI path handling is not fail-closed cross-platform | `apps/daemon/src/rpc/server.ts:860-881` |
| P1-9 | Should fix | Dangling symlink containment false-negative on canonicalized macOS paths | `apps/daemon/src/runtimes/nativeHttpRuntime.ts:91-108`, `:166-197` |
| P1-10 | Should fix | OS-level subprocess sandboxing absent while risky execution modes exist | `docs/STUDIO_V2_HANDOFF.md:50-53` |
| P1-11 | Should fix | Atomic writes block daemon event loop with `Atomics.wait` | `apps/daemon/src/rpc/server.ts:56-82`; `apps/daemon/src/config.ts:60-75` |
| P1-12 | Should fix | Current visual system materially conflicts with Vanta Grid target | `apps/web/src/styles/tokens.css:27-44`, `:46-84`, `:177-196` |
| P1-13 | Should fix | Loading/active states lack consistent accessibility + signature material | `apps/web/src/browser/Model3DViewer.tsx:142`; `apps/web/src/browser/CodeViewer.tsx:262`; `apps/web/src/browser/DocViewer.tsx:959` |
| P2-1 | Nice to have | Dead/unused `AnnotationOverlay` component | `apps/web/src/browser/AnnotationOverlay.tsx:54-70` |
| P2-2 | Nice to have | Large browser chunks over 500 kB | Vite build warning; `apps/web/src/browser/Model3DViewer.tsx` lazy chunk + main app chunk |
| P2-3 | Nice to have | Playwright runner assumes `python` rather than `python3` | `tests/ui_e2e.test.ts:21-32`, `:119-124` |
| P2-4 | Nice to have | `.gitignore` misses common coverage/browser-test artifacts | `.gitignore:1-30` |
| P2-5 | Nice to have | Factory Droid preset is unverified but shipped in example config | `config.example.json:116-127`; `docs/STUDIO_V2_HANDOFF.md:27-29` |
| P2-6 | Nice to have | Inline ad-hoc styling bypasses token enforcement | `apps/web/src/studio/ProjectModal.tsx:298`; `apps/web/src/browser/DocViewer.tsx:959`; `apps/web/src/browser/ImageViewer.tsx:1018` |

---

## Recommended Phase 2 Fix Order

1. Security first: verifier environment allowlist; ACP/Claude autonomy containment semantics; regression tests for secret reads/network/high autonomy.
2. Make tests green cross-platform: Windows drive path rejection, symlink canonicalization, remove hardcoded personal DB dependency.
3. Publishing metadata: choose/add license, configure dependency scanning, scrub personal paths.
4. DX/CI: reorder `check`, make browser E2E provisionable in CI or explicitly split it into a required job, reduce warning noise.
5. Stability hardening: POSIX process groups, non-blocking atomic writes.
6. Only then start the Vanta Grid UI rebuild from a locked `DESIGN.md` and `tokens.css`.

## Gate 1 Decision Needed

The test/build fixes are non-breaking, but **the autonomy permission changes intentionally change behavior** (especially `high` mode). Approval is therefore required before applying Phase 2 fixes.
