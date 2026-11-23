import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  newId,
  type ArtifactEntry,
  type GitDiffFileSummary,
  type GitDiffResponse,
  type RepoFileEntry,
} from "@bot-factory/shared";
import type { StateDatabase } from "../db/database";
import { isPathStrictlyWithinRoot } from "../runtimes/nativeHttpRuntime";

// --- Low-level git runners ---

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function gitEnv(extra?: Record<string, string>): Record<string, string | undefined> {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extra };
}

function finishGitResult(result: GitRunResult, args: string[], allowFail?: boolean): GitRunResult {
  if (result.code !== 0 && !allowFail) {
    throw new Error(`git_${args[0]}_failed(${result.code}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function runGitSync(
  args: string[],
  cwd: string,
  opts?: { env?: Record<string, string>; allowFail?: boolean },
): GitRunResult {
  let proc;
  try {
    proc = Bun.spawnSync(["git", "-c", "core.longpaths=true", ...args], {
      cwd,
      env: gitEnv(opts?.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git_spawn_failed: ${msg} (git ${args.join(" ")})`);
  }
  const result = {
    code: proc.exitCode,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
  };
  return finishGitResult(result, args, opts?.allowFail);
}

async function runGit(
  args: string[],
  cwd: string,
  opts?: { env?: Record<string, string>; allowFail?: boolean },
): Promise<GitRunResult> {
  let proc;
  try {
    proc = Bun.spawn(["git", "-c", "core.longpaths=true", ...args], {
      cwd,
      env: gitEnv(opts?.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git_spawn_failed: ${msg} (git ${args.join(" ")})`);
  }
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
  return finishGitResult(result, args, opts?.allowFail);
}

function truncate(input: string, max: number): string {
  return input.length > max ? `${input.slice(0, max)}\n…` : input;
}

function normalizeCwd(cwd: string): string {
  let n = normalize(cwd);
  if (n.length > 1 && (n.endsWith("\\") || n.endsWith("/"))) {
    n = n.slice(0, -1);
  }
  return n;
}

function toPosixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

// --- Project provisioning ---

export interface ProvisionProjectParams {
  projectsDir: string;
  slug: string;
  name: string;
  externalRepoPath?: string;
  seedDemoArtifacts?: boolean;
}

export function provisionProjectWorkspace(
  params: ProvisionProjectParams,
): { rootPath: string; repoPath: string } {
  const rootPath = join(resolve(params.projectsDir), params.slug);
  for (const dir of ["plans", "artifacts", "handoffs", "worktrees"]) {
    mkdirSync(join(rootPath, dir), { recursive: true });
  }

  let repoPath: string;
  if (params.externalRepoPath && existsSync(params.externalRepoPath)) {
    repoPath = resolve(params.externalRepoPath);
  } else {
    repoPath = join(rootPath, "repo");
    mkdirSync(repoPath, { recursive: true });
    ensureProjectRepo(repoPath, params.name);
  }

  const projectJsonPath = join(rootPath, "project.json");
  if (!existsSync(projectJsonPath)) {
    const manifest = {
      version: "1.0",
      slug: params.slug,
      name: params.name,
      createdAt: Date.now(),
      repoPath,
      dirs: { plans: "plans", artifacts: "artifacts", handoffs: "handoffs", worktrees: "worktrees" },
    };
    writeFileSync(projectJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  const memoryPath = join(rootPath, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    writeFileSync(memoryPath, renderStarterMemory(params.name), "utf8");
  }

  if (params.seedDemoArtifacts) {
    seedDemoArtifacts(rootPath, params.name);
  }

  return { rootPath, repoPath };
}

function ensureProjectRepo(repoPath: string, name: string): void {
  const inside = runGitSync(["rev-parse", "--is-inside-work-tree"], repoPath, { allowFail: true });
  if (inside.code !== 0) {
    const init = runGitSync(["init", "-b", "main"], repoPath, { allowFail: true });
    if (init.code !== 0) {
      runGitSync(["init"], repoPath);
      runGitSync(["symbolic-ref", "HEAD", "refs/heads/main"], repoPath);
    }
  }
  runGitSync(["config", "core.longpaths", "true"], repoPath);
  runGitSync(["config", "core.autocrlf", "false"], repoPath);
  runGitSync(["config", "user.name", "Bot Factory"], repoPath);
  runGitSync(["config", "user.email", "bot-factory@local"], repoPath);
  runGitSync(["config", "commit.gpgsign", "false"], repoPath);

  const readmePath = join(repoPath, "README.md");
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, `# ${name}\n\nManaged by Bot Factory.\n`, "utf8");
  }
  const head = runGitSync(["rev-parse", "--verify", "HEAD"], repoPath, { allowFail: true });
  if (head.code !== 0) {
    runGitSync(["add", "-A"], repoPath);
    runGitSync(["commit", "-m", "chore: scaffold project repository"], repoPath);
  }
}

function renderStarterMemory(name: string): string {
  const maxChars = 3000;
  const body = [
    "## Decisions",
    "- (none yet)",
    "",
    "## Facts",
    "- (none yet)",
    "",
    "## Open Loops",
    "- (none yet)",
  ].join("\n");
  const estimatedUsed = body.length + 140;
  const pct = Math.min(100, Math.round((estimatedUsed / maxChars) * 100));
  const filled = Math.round(pct / 5);
  const gauge = "█".repeat(filled) + "░".repeat(20 - filled);
  return [
    `# Project Memory — ${name}`,
    "",
    `> Capacity gauge: \`${gauge}\` ${pct}% of ${maxChars} chars (L1 budget)`,
    `> Last sweep: ${new Date().toISOString()}`,
    "",
    body,
    "",
  ].join("\n");
}

function seedDemoArtifacts(rootPath: string, name: string): void {
  const roadmapPath = join(rootPath, "plans", "roadmap.md");
  if (!existsSync(roadmapPath)) {
    writeFileSync(roadmapPath, renderDemoRoadmap(name), "utf8");
  }
  const svgPath = join(rootPath, "artifacts", "ui-mockup.svg");
  if (!existsSync(svgPath)) {
    writeFileSync(svgPath, DEMO_UI_MOCKUP_SVG, "utf8");
  }
  const glbPath = join(rootPath, "artifacts", "hero-monolith.glb");
  if (!existsSync(glbPath)) {
    writeFileSync(glbPath, buildHeroMonolithGlb());
  }
}

function renderDemoRoadmap(name: string): string {
  return `# ${name} — Project Roadmap

## Vision

${name} is managed end-to-end by Bot Factory. Every plan, artifact and handoff in this workspace is previewable in the hub console and can carry annotations that convert directly into tasks.

## Phase 1 — Foundation

Provision the workspace, stand up the managed git repository and seed the first previewable artifacts. The daemon owns all bot worktrees under \`worktrees/\` so the human repo is never touched by autonomous agents.

- Workspace layout: plans, artifacts, handoffs, worktrees
- Managed repo on \`main\` with long-path support enabled
- Hidden-ref checkpoints captured per agent turn

## Phase 2 — Annotatable Previews

Docs, images and 3D models listed under \`plans/\`, \`artifacts/\` and \`handoffs/\` are surfaced as previews. Users drop pins, rects and doc anchors; each annotation can spawn a fix task for a bot.

- \`plans/roadmap.md\` — this document (Doc annotations)
- \`artifacts/ui-mockup.svg\` — dark-mode architecture diagram (Image annotations)
- \`artifacts/hero-monolith.glb\` — minimal glTF 2.0 binary mesh (3D annotations)

## Phase 3 — Orchestration

Bots run inside their own \`bf/*\` worktree branches, write task handoffs back into \`handoffs/\`, and rely on scoped checkpoint refs for safe turn-level rollback.

## Success Metrics

Every task completes with a markdown + JSON handoff, a clean checkpoint trail, and zero mutations outside the bot's own worktree scope.
`;
}

const DEMO_UI_MOCKUP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 560" font-family="Segoe UI, system-ui, -apple-system, sans-serif">
  <defs>
    <marker id="bf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#58a6ff"/>
    </marker>
  </defs>
  <rect width="960" height="560" fill="#0d1117"/>
  <g stroke="#21262d" stroke-width="1">
    <path d="M0 80H960 M0 160H960 M0 240H960 M0 320H960 M0 400H960 M0 480H960"/>
    <path d="M80 0V560 M160 0V560 M240 0V560 M320 0V560 M400 0V560 M480 0V560 M560 0V560 M640 0V560 M720 0V560 M800 0V560 M880 0V560"/>
  </g>
  <text x="40" y="52" fill="#e6edf3" font-size="26" font-weight="600">Bot Factory — System Architecture</text>
  <text x="40" y="76" fill="#8b949e" font-size="13">Annotatable UI mockup · daemon hub, bot worktrees and state plane</text>
  <rect x="60" y="120" width="200" height="88" rx="10" fill="#161b22" stroke="#58a6ff" stroke-width="1.5"/>
  <text x="160" y="158" fill="#e6edf3" font-size="16" font-weight="600" text-anchor="middle">Web Console</text>
  <text x="160" y="180" fill="#8b949e" font-size="11" text-anchor="middle">board · previews · timeline</text>
  <rect x="380" y="110" width="220" height="108" rx="10" fill="#161b22" stroke="#3fb950" stroke-width="1.5"/>
  <text x="490" y="150" fill="#e6edf3" font-size="16" font-weight="600" text-anchor="middle">Daemon Hub</text>
  <text x="490" y="172" fill="#8b949e" font-size="11" text-anchor="middle">RPC core · outbox effects</text>
  <text x="490" y="190" fill="#8b949e" font-size="11" text-anchor="middle">routing · guardrails</text>
  <rect x="700" y="120" width="200" height="88" rx="10" fill="#161b22" stroke="#d29922" stroke-width="1.5"/>
  <text x="800" y="158" fill="#e6edf3" font-size="16" font-weight="600" text-anchor="middle">Worktree Runner</text>
  <text x="800" y="180" fill="#8b949e" font-size="11" text-anchor="middle">bf/* branches · ACP bots</text>
  <rect x="80" y="360" width="220" height="96" rx="10" fill="#161b22" stroke="#bc8cff" stroke-width="1.5"/>
  <text x="190" y="398" fill="#e6edf3" font-size="16" font-weight="600" text-anchor="middle">SQLite State DB</text>
  <text x="190" y="420" fill="#8b949e" font-size="11" text-anchor="middle">agents · tasks · checkpoints</text>
  <rect x="660" y="360" width="220" height="96" rx="10" fill="#161b22" stroke="#f85149" stroke-width="1.5"/>
  <text x="770" y="398" fill="#e6edf3" font-size="16" font-weight="600" text-anchor="middle">Model Providers</text>
  <text x="770" y="420" fill="#8b949e" font-size="11" text-anchor="middle">mistral · gemini · devin-acp</text>
  <line x1="260" y1="164" x2="380" y2="164" stroke="#58a6ff" stroke-width="1.5" marker-end="url(#bf-arrow)"/>
  <line x1="600" y1="164" x2="700" y2="164" stroke="#58a6ff" stroke-width="1.5" marker-end="url(#bf-arrow)"/>
  <path d="M430 218 V300 Q430 330 400 330 H300 V360" fill="none" stroke="#8b949e" stroke-width="1.2" marker-end="url(#bf-arrow)"/>
  <path d="M550 218 V300 Q550 330 580 330 H770 V360" fill="none" stroke="#8b949e" stroke-width="1.2" marker-end="url(#bf-arrow)"/>
  <text x="60" y="520" fill="#8b949e" font-size="11">Generated demo artifact · safe to overwrite</text>
</svg>
`;

// --- Minimal glTF 2.0 binary (GLB) builder ---

// Per-face corner table for an axis-aligned box. Each entry maps to
// [xIndex, yIndex, zIndex] where 0 selects the min corner and 1 the max.
// Corners are ordered CCW when viewed from outside the box.
const BOX_FACES: Array<{ n: [number, number, number]; v: Array<[number, number, number]> }> = [
  { n: [1, 0, 0], v: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { n: [-1, 0, 0], v: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { n: [0, 1, 0], v: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { n: [0, -1, 0], v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [0, 0, 1], v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: [0, 0, -1], v: [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]] },
];

function buildHeroMonolithGlb(): Uint8Array {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  const pushBox = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): void => {
    const mn = [cx - sx / 2, cy - sy / 2, cz - sz / 2];
    const mx = [cx + sx / 2, cy + sy / 2, cz + sz / 2];
    for (const face of BOX_FACES) {
      const base = positions.length / 3;
      for (const c of face.v) {
        positions.push(c[0] ? mx[0] : mn[0], c[1] ? mx[1] : mn[1], c[2] ? mx[2] : mn[2]);
        normals.push(face.n[0], face.n[1], face.n[2]);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  };

  // Stepped monolith: base slab -> plinth -> tower -> cap
  pushBox(0, 0.2, 0, 2.4, 0.4, 2.4);
  pushBox(0, 0.7, 0, 1.6, 0.6, 1.6);
  pushBox(0, 2.0, 0, 0.9, 2.0, 0.9);
  pushBox(0, 3.15, 0, 0.55, 0.3, 0.55);

  const posF32 = new Float32Array(positions);
  const nrmF32 = new Float32Array(normals);
  const idxU16 = new Uint16Array(indices);
  const posBytes = new Uint8Array(posF32.buffer, posF32.byteOffset, posF32.byteLength);
  const nrmBytes = new Uint8Array(nrmF32.buffer, nrmF32.byteOffset, nrmF32.byteLength);
  const idxBytes = new Uint8Array(idxU16.buffer, idxU16.byteOffset, idxU16.byteLength);

  const bin = new Uint8Array(posBytes.length + nrmBytes.length + idxBytes.length);
  bin.set(posBytes, 0);
  bin.set(nrmBytes, posBytes.length);
  bin.set(idxBytes, posBytes.length + nrmBytes.length);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], positions[i + a]);
      max[a] = Math.max(max[a], positions[i + a]);
    }
  }

  const vertCount = positions.length / 3;
  const gltf = {
    asset: { version: "2.0", generator: "bot-factory worktrees.ts" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "HeroMonolith" }],
    meshes: [
      {
        name: "HeroMonolith",
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0, mode: 4 },
        ],
      },
    ],
    materials: [
      {
        name: "MonolithMetal",
        pbrMetallicRoughness: {
          baseColorFactor: [0.16, 0.18, 0.24, 1],
          metallicFactor: 0.9,
          roughnessFactor: 0.35,
        },
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertCount, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count: vertCount, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: indices.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.length },
      { buffer: 0, byteOffset: posBytes.length, byteLength: nrmBytes.length },
      { buffer: 0, byteOffset: posBytes.length + nrmBytes.length, byteLength: idxBytes.length },
    ],
    buffers: [{ byteLength: bin.length }],
  };

  const jsonRaw = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonChunkLen = jsonRaw.length + ((4 - (jsonRaw.length % 4)) % 4);
  const binChunkLen = bin.length + ((4 - (bin.length % 4)) % 4);
  const total = 12 + 8 + jsonChunkLen + 8 + binChunkLen;

  const glb = new Uint8Array(total);
  const dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonChunkLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  glb.set(jsonRaw, 20);
  glb.fill(0x20, 20 + jsonRaw.length, 20 + jsonChunkLen);
  const binHeader = 20 + jsonChunkLen;
  dv.setUint32(binHeader, binChunkLen, true);
  dv.setUint32(binHeader + 4, 0x004e4942, true); // "BIN\0"
  glb.set(bin, binHeader + 8);
  return glb;
}

// --- Bot worktrees ---

function shortWorktreeId(agentId: string, taskId: string): string {
  const basis = (taskId || agentId || "bot").toLowerCase();
  const tail = basis.replace(/[^a-z0-9]/g, "").slice(-8);
  if (tail) return tail;
  return createHash("sha1").update(`${agentId}:${taskId}`).digest("hex").slice(0, 8);
}

export function createBotWorktree(params: {
  projectRoot: string;
  repoPath: string;
  agentId: string;
  taskId: string;
}): { worktreePath: string; branch: string } {
  const shortId = shortWorktreeId(params.agentId, params.taskId);
  const worktreesRoot = join(params.projectRoot, "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  const worktreePath = join(worktreesRoot, `wt-${shortId}`);
  const branch = `bf/${shortId}`;
  runGitSync(["worktree", "add", "-b", branch, worktreePath, "HEAD"], params.repoPath);
  return { worktreePath, branch };
}

export function removeBotWorktree(repoPath: string, worktreePath: string): void {
  let removeError: Error | null = null;
  if (existsSync(worktreePath)) {
    const res = runGitSync(["worktree", "remove", "--force", worktreePath], repoPath, { allowFail: true });
    if (res.code !== 0) {
      removeError = new Error(`git_worktree_remove_failed(${res.code}): ${res.stderr || res.stdout}`);
    }
  }
  runGitSync(["worktree", "prune"], repoPath, { allowFail: true });
  if (removeError && existsSync(worktreePath)) {
    throw removeError;
  }
}

// --- Workspace-scoped hidden-ref checkpoints ---

export function makeCheckpointScopeKey(agentId: string, cwd: string): string {
  return `root:${agentId}:${normalizeCwd(cwd).toLowerCase()}`;
}

export async function captureCheckpoint(
  db: StateDatabase,
  params: { agentId: string; cwd: string; turnNum: number },
): Promise<{ refName: string; commitSha: string; diffStat: string }> {
  const cwdNorm = normalizeCwd(params.cwd);
  const scopeKey = makeCheckpointScopeKey(params.agentId, params.cwd);
  const safeScope = createHash("sha1").update(scopeKey).digest("hex").slice(0, 16);
  const refName = `refs/bot-factory/checkpoints/${safeScope}/${params.turnNum}`;

  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], params.cwd, { allowFail: true });
  if (inside.code !== 0) {
    throw new Error(`not_a_git_repo: ${params.cwd}`);
  }
  const gitDirOut = await runGit(["rev-parse", "--absolute-git-dir"], params.cwd);
  const gitDir = resolve(params.cwd, gitDirOut.stdout);
  const realIndexPath = join(gitDir, "index");
  const tmpIndexPath = join(tmpdir(), `bf-checkpoint-${newId("idx")}-${process.pid}.index`);

  const env = {
    GIT_INDEX_FILE: tmpIndexPath,
    GIT_AUTHOR_NAME: "Bot Factory",
    GIT_AUTHOR_EMAIL: "bot-factory@local",
    GIT_COMMITTER_NAME: "Bot Factory",
    GIT_COMMITTER_EMAIL: "bot-factory@local",
  };

  try {
    if (existsSync(realIndexPath)) {
      copyFileSync(realIndexPath, tmpIndexPath);
    }
    await runGit(["add", "-A"], params.cwd, { env });
    const treeSha = (await runGit(["write-tree"], params.cwd, { env })).stdout;
    const head = await runGit(["rev-parse", "--verify", "HEAD"], params.cwd, { allowFail: true });
    const parentArgs = head.code === 0 ? ["-p", head.stdout] : [];
    const commitSha = (
      await runGit(
        ["commit-tree", treeSha, ...parentArgs, "-m", `checkpoint turn ${params.turnNum}`],
        params.cwd,
        { env },
      )
    ).stdout;
    await runGit(["update-ref", refName, commitSha], params.cwd);

    const stat = await runGit(["show", "--stat", "--format=", commitSha], params.cwd, { allowFail: true });
    const diffStat = stat.code === 0 ? truncate(stat.stdout, 2000) : "";

    db.upsertCheckpoint({
      id: newId("ckp"),
      scopeKey,
      agentId: params.agentId,
      cwd: cwdNorm,
      turnNum: params.turnNum,
      refName,
      commitSha,
      createdAt: Date.now(),
    });

    return { refName, commitSha, diffStat };
  } finally {
    try {
      if (existsSync(tmpIndexPath)) unlinkSync(tmpIndexPath);
    } catch {
      // Temp index cleanup is best-effort
    }
  }
}

export async function restoreCheckpoint(
  db: StateDatabase,
  params: { agentId: string; currentCwd: string; checkpointId: string },
): Promise<void> {
  const row = db.getCheckpoint(params.checkpointId);
  if (!row) {
    throw new Error(`checkpoint_not_found: ${params.checkpointId}`);
  }
  const scopeKey = makeCheckpointScopeKey(params.agentId, params.currentCwd);
  if (row.scopeKey !== scopeKey) {
    throw new Error("cross_worktree_restore_refused");
  }
  // Sync index + worktree to the checkpoint tree: read-tree resets the index
  // (and restores tracked files), checkout-index -f then force-writes every
  // entry so files captured while untracked are also overwritten, and clean
  // removes worktree files the checkpoint does not know about.
  const sha = row.commitSha;
  await runGit(["read-tree", "--reset", "-u", sha], params.currentCwd);
  await runGit(["checkout-index", "-f", "-a"], params.currentCwd);
  await runGit(["clean", "-fd"], params.currentCwd);
}

// --- Project artifacts & handoffs ---

function inferArtifactKind(relativePosixPath: string): ArtifactEntry["kind"] {
  if (relativePosixPath.startsWith("handoffs/")) return "handoff";
  const ext = extname(relativePosixPath).toLowerCase();
  if (ext === ".md" || ext === ".txt") return "doc";
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".svg") {
    return "image";
  }
  if (ext === ".glb" || ext === ".gltf") return "model_3d";
  return "other";
}

function* walkFiles(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

export function listProjectArtifacts(projectId: string, projectRoot: string): ArtifactEntry[] {
  const out: ArtifactEntry[] = [];
  for (const dir of ["plans", "artifacts", "handoffs"]) {
    const base = join(projectRoot, dir);
    for (const file of walkFiles(base)) {
      const st = statSync(file);
      const relPosix = toPosixRelative(projectRoot, file);
      out.push({
        projectId,
        relativePath: relPosix,
        name: basename(file),
        kind: inferArtifactKind(relPosix),
        sizeBytes: st.size,
        updatedAt: Math.floor(st.mtimeMs),
      });
    }
  }
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return out;
}

export function writeTaskHandoff(
  projectRoot: string,
  taskId: string,
  payload: { title: string; summary: string; changedFiles: string[]; testsRun: string[]; notes?: string },
): string {
  const handoffsDir = join(projectRoot, "handoffs");
  mkdirSync(handoffsDir, { recursive: true });
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "-") || newId("task");

  const bulletList = (items: string[], empty: string): string =>
    items.length ? items.map((i) => `- \`${i}\``).join("\n") : `- ${empty}`;

  const md = [
    `# Task Handoff — ${payload.title}`,
    "",
    `- Task: \`${taskId}\``,
    `- Generated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    "",
    payload.summary,
    "",
    "## Changed Files",
    "",
    bulletList(payload.changedFiles, "none"),
    "",
    "## Tests Run",
    "",
    bulletList(payload.testsRun, "none"),
    "",
    "## Notes",
    "",
    payload.notes?.trim() ? payload.notes : "(none)",
    "",
  ].join("\n");

  const relMd = `handoffs/${safeTaskId}.md`;
  writeFileSync(join(projectRoot, relMd), md, "utf8");
  writeFileSync(
    join(handoffsDir, `${safeTaskId}.json`),
    `${JSON.stringify(
      {
        taskId,
        title: payload.title,
        summary: payload.summary,
        changedFiles: payload.changedFiles,
        testsRun: payload.testsRun,
        notes: payload.notes ?? null,
        createdAt: Date.now(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return relMd;
}

// --- Read-only in-app browser: repo files & workspace diff ---

const SAFE_REPO_SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next", "worktrees", ".bun"]);
const SAFE_REPO_MAX_FILE_BYTES = 512 * 1024;
const SAFE_REPO_BINARY_PROBE_BYTES = 4096;
const DIFF_MAX_FILES = 40;
const DIFF_MAX_PATCH_CHARS = 16_000;
const UNTRACKED_PATCH_MAX_BYTES = 64 * 1024;
const UNTRACKED_PATCH_MAX_LINES = 120;

function isSensitiveRepoBasename(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "secrets.env" ||
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower.endsWith(".pem") ||
    lower.endsWith(".key")
  );
}

function isSensitiveRepoRelPath(relPath: string): boolean {
  return relPath
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((segment) => {
      const lower = segment.toLowerCase();
      return (
        lower === ".git" ||
        lower === "node_modules" ||
        isSensitiveRepoBasename(segment) ||
        lower.startsWith(".pem") ||
        lower.startsWith(".key")
      );
    });
}

export function listSafeRepoFiles(targetRoot: string, maxFiles = 500): RepoFileEntry[] {
  const out: RepoFileEntry[] = [];
  if (!targetRoot || !existsSync(targetRoot) || maxFiles <= 0) return out;

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SAFE_REPO_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.toLowerCase() === ".git" || isSensitiveRepoBasename(entry.name)) continue;
      const full = join(dir, entry.name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      out.push({
        relativePath: toPosixRelative(targetRoot, full),
        name: entry.name,
        sizeBytes: st.size,
        ext: extname(entry.name).toLowerCase(),
      });
    }
  };

  walk(targetRoot);
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return out.slice(0, maxFiles);
}

export function readSafeRepoFile(
  targetRoot: string,
  relPath: string,
  scrub?: (s: string) => string,
): { relativePath: string; content: string; sizeBytes: number; truncated: boolean } {
  if (
    !relPath ||
    isAbsolute(relPath) ||
    relPath.startsWith("\\\\") ||
    relPath.startsWith("//") ||
    relPath.includes("\0")
  ) {
    throw new Error("path_traversal_blocked");
  }
  const check = isPathStrictlyWithinRoot(targetRoot, relPath);
  if (!check.ok) {
    throw new Error("path_traversal_blocked");
  }
  const posixRel = relative(resolve(targetRoot), check.absTarget).split(sep).join("/");
  if (posixRel && isSensitiveRepoRelPath(posixRel)) {
    throw new Error("sensitive_path_blocked");
  }
  const abs = check.absTarget;
  if (!posixRel || !existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error("file_not_found");
  }
  if (statSync(abs).size > SAFE_REPO_MAX_FILE_BYTES) {
    throw new Error("file_too_large");
  }
  const buf = readFileSync(abs);
  if (buf.subarray(0, SAFE_REPO_BINARY_PROBE_BYTES).includes(0)) {
    throw new Error("binary_file_not_previewable");
  }
  const text = buf.toString("utf8");
  return {
    relativePath: posixRel,
    content: scrub ? scrub(text) : text,
    sizeBytes: buf.byteLength,
    truncated: false,
  };
}

interface GitStatusEntry {
  path: string;
  status: GitDiffFileSummary["status"];
}

function parsePorcelainStatus(stdout: string): GitStatusEntry[] {
  const out: GitStatusEntry[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    // Note: runGitSync trims leading whitespace on stdout, so the first line of
    // `git status --porcelain` (" M README.md") can arrive as "M README.md".
    const match = /^\s*([MADRCU?!]{1,2})\s+(.+)$/.exec(rawLine);
    if (!match) continue;
    const code = match[1]!;
    let pathPart = match[2]!.trim();
    if (!pathPart) continue;
    const arrow = pathPart.lastIndexOf(" -> ");
    if (arrow !== -1) pathPart = pathPart.slice(arrow + 4).trim();
    pathPart = pathPart.replace(/^"|"$/g, "").replace(/\\/g, "/");
    if (!pathPart || isSensitiveRepoRelPath(pathPart)) continue;
    const status: GitDiffFileSummary["status"] = code.includes("?")
      ? "untracked"
      : code.includes("R")
        ? "renamed"
        : code.includes("A")
          ? "added"
          : code.includes("D")
            ? "deleted"
            : "modified";
    out.push({ path: pathPart, status });
  }
  return out;
}

function parseNumstatPath(raw: string): string {
  let p = raw.trim();
  const braceRename = /^(.*)\{(.*?) => (.*?)\}(.*)$/.exec(p);
  if (braceRename) {
    p = `${braceRename[1]}${braceRename[3]}${braceRename[4]}`;
  } else if (p.includes("=>")) {
    p = p.slice(p.lastIndexOf("=>") + 2).trim();
  }
  return p.replace(/^"|"$/g, "").replace(/\\/g, "/");
}

function readNumstat(targetRoot: string): Map<string, { added: number; removed: number }> {
  const map = new Map<string, { added: number; removed: number }>();
  let res = runGitSync(["diff", "--numstat", "HEAD"], targetRoot, { allowFail: true });
  if (res.code !== 0) {
    res = runGitSync(["diff", "--numstat"], targetRoot, { allowFail: true });
  }
  if (res.code !== 0) return map;
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [rawAdded, rawRemoved, ...rest] = line.split("\t");
    if (!rawAdded || !rawRemoved || rest.length === 0) continue;
    const filePath = parseNumstatPath(rest.join("\t"));
    if (!filePath || isSensitiveRepoRelPath(filePath)) continue;
    map.set(filePath, {
      added: rawAdded === "-" ? 0 : Number.parseInt(rawAdded, 10) || 0,
      removed: rawRemoved === "-" ? 0 : Number.parseInt(rawRemoved, 10) || 0,
    });
  }
  return map;
}

function buildSyntheticUntrackedPatch(absPath: string, relPath: string): { patch: string; added: number } {
  try {
    if (!existsSync(absPath) || !statSync(absPath).isFile() || statSync(absPath).size > UNTRACKED_PATCH_MAX_BYTES) {
      return { patch: "", added: 0 };
    }
    const buf = readFileSync(absPath);
    if (buf.subarray(0, SAFE_REPO_BINARY_PROBE_BYTES).includes(0)) {
      return { patch: "", added: 0 };
    }
    const lines = buf.toString("utf8").replace(/\r\n/g, "\n").split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const capped = lines.slice(0, UNTRACKED_PATCH_MAX_LINES);
    const body = capped.map((line) => `+${line}`).join("\n");
    return {
      patch: `--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${capped.length} @@\n${body}`,
      added: capped.length,
    };
  } catch {
    return { patch: "", added: 0 };
  }
}

export function computeWorkspaceGitDiff(targetRoot: string, scrub?: (s: string) => string): GitDiffResponse {
  const empty: GitDiffResponse = { branch: "main", filesChanged: 0, insertions: 0, deletions: 0, files: [] };
  if (!targetRoot || !existsSync(targetRoot)) return empty;

  const branchRes = runGitSync(["rev-parse", "--abbrev-ref", "HEAD"], targetRoot, { allowFail: true });
  const branch =
    branchRes.code === 0 && branchRes.stdout && branchRes.stdout !== "HEAD" ? branchRes.stdout : "main";

  const statusRes = runGitSync(["status", "--porcelain"], targetRoot, { allowFail: true });
  const entries = statusRes.code === 0 ? parsePorcelainStatus(statusRes.stdout) : [];
  const numstat = readNumstat(targetRoot);
  const seen = new Set(entries.map((entry) => entry.path));
  for (const filePath of numstat.keys()) {
    if (seen.has(filePath)) continue;
    entries.push({ path: filePath, status: "modified" });
    seen.add(filePath);
  }

  const files: GitDiffFileSummary[] = [];
  let untrackedInsertions = 0;
  for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path)).slice(0, DIFF_MAX_FILES)) {
    const counts = numstat.get(entry.path) ?? { added: 0, removed: 0 };
    let patch = "";
    let added = counts.added;
    if (entry.status === "untracked") {
      const safe = isPathStrictlyWithinRoot(targetRoot, entry.path);
      const synth = safe.ok ? buildSyntheticUntrackedPatch(safe.absTarget, entry.path) : { patch: "", added: 0 };
      patch = synth.patch;
      added = synth.added;
      untrackedInsertions += synth.added;
    } else {
      let res = runGitSync(["diff", "HEAD", "--", entry.path], targetRoot, { allowFail: true });
      if (res.code !== 0 || !res.stdout) {
        res = runGitSync(["diff", "--", entry.path], targetRoot, { allowFail: true });
      }
      patch = res.code === 0 ? res.stdout : "";
    }
    if (scrub) patch = scrub(patch);
    if (patch.length > DIFF_MAX_PATCH_CHARS) {
      patch = patch.slice(0, DIFF_MAX_PATCH_CHARS);
    }
    files.push({ path: entry.path, status: entry.status, added, removed: counts.removed, patch });
  }

  let insertions = untrackedInsertions;
  let deletions = 0;
  for (const counts of numstat.values()) {
    insertions += counts.added;
    deletions += counts.removed;
  }

  return { branch, filesChanged: files.length, insertions, deletions, files };
}
