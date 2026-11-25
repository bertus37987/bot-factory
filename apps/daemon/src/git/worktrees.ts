import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  newId,
  type ArtifactEntry,
  type GitDiffFileSummary,
  type GitDiffResponse,
  type RepoFileEntry,
} from "@bot-factory/shared";
import type { StateDatabase } from "../db/database";
import { canonicalRelativePathWithinRoot, isPathStrictlyWithinRoot } from "../runtimes/nativeHttpRuntime";

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

async function runGitRaw(
  args: string[],
  cwd: string,
  opts?: { env?: Record<string, string>; allowFail?: boolean },
): Promise<GitRunResult> {
  let proc;
  try {
    proc = Bun.spawn(["git", "-c", "core.longpaths=true", "-c", "core.quotePath=false", ...args], {
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
  const result = { code, stdout, stderr: stderr.trim() };
  return finishGitResult(result, args, opts?.allowFail);
}

async function runGit(
  args: string[],
  cwd: string,
  opts?: { env?: Record<string, string>; allowFail?: boolean },
): Promise<GitRunResult> {
  const raw = await runGitRaw(args, cwd, opts);
  return { ...raw, stdout: raw.stdout.trim() };
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

function expandUserPath(inputPath: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return join(homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function validateExternalRepoPath(externalRepoPath: string, projectsDir: string): string {
  const trimmed = externalRepoPath.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.startsWith("\\\\") || trimmed.startsWith("//")) {
    throw new Error("invalid_external_repo_path: unsafe_path");
  }
  const expanded = expandUserPath(trimmed);
  if (!existsSync(expanded)) {
    throw new Error("invalid_external_repo_path: path_not_found");
  }
  let st;
  try {
    st = statSync(expanded);
  } catch {
    throw new Error("invalid_external_repo_path: path_unreadable");
  }
  if (!st.isDirectory()) {
    throw new Error("invalid_external_repo_path: not_a_directory");
  }
  const realRepo = realpathSync(expanded);

  // Reject ~/bot-factory/system, the active workspace's sibling system dir, and sensitive home dirs (.ssh, .aws, .gnupg, etc.)
  const home = homedir();
  const forbiddenRoots = [
    join(home, "bot-factory", "system"),
    resolve(projectsDir, "..", "system"),
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".kube"),
  ];
  for (const forbidden of forbiddenRoots) {
    if (isPathStrictlyWithinRoot(forbidden, realRepo).ok) {
      throw new Error("invalid_external_repo_path: forbidden_system_or_secret_dir");
    }
    if (existsSync(forbidden) && isPathStrictlyWithinRoot(realpathSync(forbidden), realRepo).ok) {
      throw new Error("invalid_external_repo_path: forbidden_system_or_secret_dir");
    }
  }

  const segments = realRepo.split(/[\\/]+/).filter(Boolean);
  if (segments.some((seg) => isSensitiveRepoBasename(seg) || seg.toLowerCase() === ".gnupg")) {
    throw new Error("invalid_external_repo_path: sensitive_segment_blocked");
  }

  if (!existsSync(join(realRepo, ".git"))) {
    throw new Error("invalid_external_repo_path: missing_git_dir");
  }

  return realRepo;
}

export function provisionProjectWorkspace(
  params: ProvisionProjectParams,
): { rootPath: string; repoPath: string } {
  let validatedExternalRepo: string | null = null;
  if (params.externalRepoPath !== undefined && params.externalRepoPath.length > 0) {
    validatedExternalRepo = validateExternalRepoPath(params.externalRepoPath, params.projectsDir);
  }

  const rootPath = join(resolve(params.projectsDir), params.slug);
  for (const dir of ["plans", "artifacts", "handoffs", "worktrees"]) {
    mkdirSync(join(rootPath, dir), { recursive: true });
  }

  let repoPath: string;
  if (validatedExternalRepo) {
    repoPath = validatedExternalRepo;
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
  const entropy = `${taskId}:${agentId}:${Date.now()}:${Math.random()}:${randomUUID()}`;
  return createHash("sha1").update(entropy).digest("hex").slice(0, 8);
}

function gitCommitEnv(extra?: Record<string, string>): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: "Bot Factory",
    GIT_AUTHOR_EMAIL: "bot-factory@local",
    GIT_COMMITTER_NAME: "Bot Factory",
    GIT_COMMITTER_EMAIL: "bot-factory@local",
    ...extra,
  };
}

function subagentBaseRefName(branch: string): string {
  const hash = createHash("sha1").update(branch).digest("hex").slice(0, 12);
  return `refs/bot-factory/subagent-base/${hash}`;
}

export function createBotWorktree(params: {
  projectRoot: string;
  repoPath: string;
  agentId: string;
  taskId: string;
}): { worktreePath: string; branch: string } {
  const worktreesRoot = join(params.projectRoot, "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  let shortId = shortWorktreeId(params.agentId, params.taskId);
  let worktreePath = join(worktreesRoot, `wt-${shortId}`);
  while (existsSync(worktreePath)) {
    shortId = shortWorktreeId(params.agentId, params.taskId);
    worktreePath = join(worktreesRoot, `wt-${shortId}`);
  }
  const branch = `bf/${shortId}`;
  runGitSync(["worktree", "add", "-b", branch, worktreePath, "HEAD"], params.repoPath);
  return { worktreePath, branch };
}

export function removeBotWorktree(repoPath: string, worktreePath: string): void {
  let removeError: Error | null = null;
  if (existsSync(worktreePath)) {
    const sab = process.platform === "win32" ? new Int32Array(new SharedArrayBuffer(4)) : null;
    const maxAttempts = process.platform === "win32" ? 5 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const res = runGitSync(["worktree", "remove", "--force", worktreePath], repoPath, { allowFail: true });
      if (res.code === 0 || !existsSync(worktreePath)) {
        removeError = null;
        break;
      }
      const msg = res.stderr || res.stdout;
      removeError = new Error(`git_worktree_remove_failed(${res.code}): ${msg}`);
      if (sab && /permission denied|ebusy|eperm|eacces|used by another process/i.test(msg) && attempt + 1 < maxAttempts) {
        Atomics.wait(sab, 0, 0, 75);
        continue;
      }
      break;
    }
  }
  runGitSync(["worktree", "prune"], repoPath, { allowFail: true });
  if (removeError && existsSync(worktreePath)) {
    throw removeError;
  }
}

const SUBAGENT_SNAPSHOT_MAX_UNTRACKED_BYTES = 10 * 1024 * 1024;
const GIT_ARG_BATCH_SIZE = 50;

/**
 * List changed, staged, and untracked non-sensitive files inside a git worktree.
 */
export async function listWorktreeChangedFiles(worktreePath: string): Promise<string[]> {
  if (!worktreePath || !existsSync(worktreePath)) return [];
  const res = await runGitRaw(
    ["--no-optional-locks", "status", "--porcelain", "-z", "-uall"],
    worktreePath,
    { allowFail: true },
  );
  if (res.code !== 0) return [];
  return parsePorcelainStatusZ(res.stdout)
    .map((entry) => entry.path)
    .sort((a, b) => a.localeCompare(b));
}

async function runGitPathBatches(
  baseArgs: string[],
  paths: string[],
  cwd: string,
  opts?: { env?: Record<string, string>; allowFail?: boolean },
): Promise<void> {
  for (let i = 0; i < paths.length; i += GIT_ARG_BATCH_SIZE) {
    const batch = paths.slice(i, i + GIT_ARG_BATCH_SIZE);
    if (batch.length === 0) continue;
    await runGit([...baseArgs, "--", ...batch], cwd, opts);
  }
}

async function unstageSensitivePaths(cwd: string, env?: Record<string, string>): Promise<void> {
  const staged = await runGitRaw(["diff", "--cached", "--name-only", "-z"], cwd, { env, allowFail: true });
  if (staged.code !== 0 || !staged.stdout) return;
  const sensitive = staged.stdout
    .split("\0")
    .map((p) => p.trim().replace(/\\/g, "/"))
    .filter((p) => p.length > 0 && isSensitiveRepoRelPath(p));
  if (sensitive.length > 0) {
    await runGitPathBatches(["rm", "-r", "--cached", "--ignore-unmatch", "-q"], sensitive, cwd, {
      env,
      allowFail: true,
    });
  }
}

async function captureParentSnapshotCommit(parentWorktreePath: string, parentHeadSha: string): Promise<string> {
  const statusRes = await runGitRaw(
    ["--no-optional-locks", "status", "--porcelain", "-z", "-uall"],
    parentWorktreePath,
    { allowFail: true },
  );
  if (statusRes.code !== 0 || !statusRes.stdout) {
    return parentHeadSha;
  }

  const entries = parsePorcelainStatusZ(statusRes.stdout);
  if (entries.length === 0) {
    return parentHeadSha;
  }

  const gitDirOut = await runGit(["rev-parse", "--absolute-git-dir"], parentWorktreePath);
  const gitDir = resolve(parentWorktreePath, gitDirOut.stdout);
  const realIndexPath = join(gitDir, "index");
  const tmpIndexPath = join(tmpdir(), `bf-subagent-idx-${newId("idx")}-${process.pid}.index`);
  const env = gitCommitEnv({ GIT_INDEX_FILE: tmpIndexPath });

  try {
    if (existsSync(realIndexPath)) {
      copyFileSync(realIndexPath, tmpIndexPath);
    } else {
      await runGit(["read-tree", parentHeadSha], parentWorktreePath, { env });
    }

    // Update tracked/staged entries first, then stage safe non-sensitive untracked files.
    await runGit(["add", "-u"], parentWorktreePath, { env });
    const safeUntracked: string[] = [];
    for (const entry of entries) {
      if (entry.status !== "untracked") continue;
      const safe = isPathStrictlyWithinRoot(parentWorktreePath, entry.path);
      if (!safe.ok) continue;
      try {
        const st = statSync(safe.absTarget);
        if (st.isFile() && st.size <= SUBAGENT_SNAPSHOT_MAX_UNTRACKED_BYTES) {
          safeUntracked.push(entry.path);
        }
      } catch {
        // Ignore vanished/unreadable untracked files
      }
    }
    if (safeUntracked.length > 0) {
      await runGitPathBatches(["add"], safeUntracked, parentWorktreePath, { env });
    }
    await unstageSensitivePaths(parentWorktreePath, env);

    const treeSha = (await runGit(["write-tree"], parentWorktreePath, { env })).stdout;
    const headTreeSha = (await runGit(["rev-parse", `${parentHeadSha}^{tree}`], parentWorktreePath)).stdout;
    if (treeSha === headTreeSha) {
      return parentHeadSha;
    }

    return (
      await runGit(
        ["-c", "commit.gpgsign=false", "commit-tree", treeSha, "-p", parentHeadSha, "-m", "chore(bf): parent snapshot for subagent"],
        parentWorktreePath,
        { env },
      )
    ).stdout;
  } finally {
    try {
      if (existsSync(tmpIndexPath)) unlinkSync(tmpIndexPath);
    } catch {
      // Best-effort temp index cleanup
    }
  }
}

/**
 * Create an isolated child git worktree for a depth-1 coding subagent without
 * mutating the parent worktree's HEAD, index, or working directory.
 */
export async function createSubagentWorktree(params: {
  projectRoot: string;
  parentWorktreePath: string;
  subagentId: string;
}): Promise<{ worktreePath: string; branch: string; baseCommitSha: string }> {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], params.parentWorktreePath, { allowFail: true });
  if (inside.code !== 0) {
    throw new Error(`not_a_git_worktree: ${params.parentWorktreePath}`);
  }
  const headRes = await runGit(["rev-parse", "--verify", "HEAD"], params.parentWorktreePath, { allowFail: true });
  if (headRes.code !== 0) {
    throw new Error("parent_worktree_has_no_commits");
  }
  const parentHeadSha = headRes.stdout;

  const worktreesRoot = join(params.projectRoot, "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  let shortId = shortWorktreeId(params.subagentId, "sub");
  let worktreePath = join(worktreesRoot, `sub-${shortId}`);
  let branch = `bf/sub-${shortId}`;
  while (
    existsSync(worktreePath) ||
    (await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], params.parentWorktreePath, { allowFail: true }))
      .code === 0
  ) {
    shortId = shortWorktreeId(params.subagentId, "sub");
    worktreePath = join(worktreesRoot, `sub-${shortId}`);
    branch = `bf/sub-${shortId}`;
  }

  const startPoint = await captureParentSnapshotCommit(params.parentWorktreePath, parentHeadSha);
  await runGit(["worktree", "add", "-b", branch, worktreePath, startPoint], params.parentWorktreePath);
  const baseCommitSha = (await runGit(["rev-parse", "HEAD"], worktreePath)).stdout;
  await runGit(["update-ref", subagentBaseRefName(branch), baseCommitSha], worktreePath, { allowFail: true });

  return { worktreePath, branch, baseCommitSha };
}

/**
 * Clean up a subagent's child worktree, base tracking ref, and branch.
 */
export async function cleanupSubagentWorktree(params: {
  repoPath: string;
  worktreePath?: string | null;
  branch?: string | null;
}): Promise<void> {
  if (params.worktreePath) {
    removeBotWorktree(params.repoPath, params.worktreePath);
  }
  if (params.branch) {
    await runGit(["update-ref", "-d", subagentBaseRefName(params.branch)], params.repoPath, { allowFail: true });
    await runGit(["branch", "-D", params.branch], params.repoPath, { allowFail: true });
  }
}

function isUnsafePatchRelPath(parentWorktreePath: string, rawPath: string): boolean {
  const cleaned = rawPath.trim().replace(/^"|"$/g, "").replace(/\\/g, "/");
  if (!cleaned || cleaned === "/dev/null") return false;
  if (isAbsolute(cleaned) || /^[A-Za-z]:/.test(cleaned) || cleaned.startsWith("//") || cleaned.includes("\0")) {
    return true;
  }
  const segs = cleaned.split("/");
  if (segs.includes("..")) return true;
  return !isPathStrictlyWithinRoot(parentWorktreePath, cleaned).ok;
}

function validateSubagentDiffRawAndPatch(params: {
  parentWorktreePath: string;
  diffRawStdout: string;
  patchText: string;
}): string | null {
  if (params.diffRawStdout) {
    const tokens = params.diffRawStdout.split("\0");
    let i = 0;
    while (i < tokens.length) {
      const meta = tokens[i] ?? "";
      i += 1;
      if (!meta.startsWith(":")) continue;
      const fields = meta.slice(1).trim().split(/\s+/);
      const oldMode = fields[0] ?? "";
      const newMode = fields[1] ?? "";
      const status = fields[4] ?? "";
      const firstPath = (tokens[i] ?? "").trim().replace(/\\/g, "/");
      i += 1;
      const secondPath =
        status.startsWith("R") || status.startsWith("C") ? (tokens[i] ?? "").trim().replace(/\\/g, "/") : "";
      if (status.startsWith("R") || status.startsWith("C")) {
        i += 1;
      }
      if (oldMode === "120000" || newMode === "120000") {
        return `symlink_not_allowed_in_subagent_patch: ${secondPath || firstPath}`;
      }
      if (firstPath && isUnsafePatchRelPath(params.parentWorktreePath, firstPath)) {
        return `subagent_patch_path_outside_parent_worktree: ${firstPath}`;
      }
      if (secondPath && isUnsafePatchRelPath(params.parentWorktreePath, secondPath)) {
        return `subagent_patch_path_outside_parent_worktree: ${secondPath}`;
      }
    }
  }

  for (const rawLine of params.patchText.split(/\r?\n/)) {
    if (/^(?:old mode|new mode|new file mode|deleted file mode)\s+120000\b/.test(rawLine)) {
      return "symlink_not_allowed_in_subagent_patch";
    }
    if (rawLine.startsWith("--- a/")) {
      const p = rawLine.slice("--- a/".length);
      if (isUnsafePatchRelPath(params.parentWorktreePath, p)) {
        return `subagent_patch_path_outside_parent_worktree: ${p}`;
      }
    } else if (rawLine.startsWith("+++ b/")) {
      const p = rawLine.slice("+++ b/".length);
      if (isUnsafePatchRelPath(params.parentWorktreePath, p)) {
        return `subagent_patch_path_outside_parent_worktree: ${p}`;
      }
    } else if (rawLine.startsWith("rename from ") || rawLine.startsWith("copy from ")) {
      const p = rawLine.replace(/^(?:rename|copy) from /, "");
      if (isUnsafePatchRelPath(params.parentWorktreePath, p)) {
        return `subagent_patch_path_outside_parent_worktree: ${p}`;
      }
    } else if (rawLine.startsWith("rename to ") || rawLine.startsWith("copy to ")) {
      const p = rawLine.replace(/^(?:rename|copy) to /, "");
      if (isUnsafePatchRelPath(params.parentWorktreePath, p)) {
        return `subagent_patch_path_outside_parent_worktree: ${p}`;
      }
    }
  }

  return null;
}

function resolveSubagentDiffBaseSync(
  parentWorktreePath: string,
  childWorktreePath: string,
  childBranch?: string | null,
): string {
  if (childBranch) {
    const baseRef = subagentBaseRefName(childBranch);
    const check = runGitSync(["rev-parse", "--verify", baseRef], childWorktreePath, { allowFail: true });
    if (check.code === 0 && check.stdout) return baseRef;
  }
  const parentHead = runGitSync(["rev-parse", "--verify", "HEAD"], parentWorktreePath, { allowFail: true });
  if (parentHead.code === 0 && parentHead.stdout) {
    const mergeBase = runGitSync(["merge-base", parentHead.stdout, "HEAD"], childWorktreePath, { allowFail: true });
    if (mergeBase.code === 0 && mergeBase.stdout) return mergeBase.stdout;
  }
  return "HEAD";
}

export function computeSubagentWorktreeDiffSummarySync(params: {
  parentWorktreePath: string;
  childWorktreePath: string;
  childBranch?: string | null;
}): { filesTouched: string[]; diffStat: string | null } {
  if (
    !params.childWorktreePath ||
    !existsSync(params.childWorktreePath) ||
    resolve(params.childWorktreePath) === resolve(params.parentWorktreePath)
  ) {
    return { filesTouched: [], diffStat: null };
  }
  const inside = runGitSync(["rev-parse", "--is-inside-work-tree"], params.childWorktreePath, { allowFail: true });
  if (inside.code !== 0) return { filesTouched: [], diffStat: null };

  const diffBase = resolveSubagentDiffBaseSync(params.parentWorktreePath, params.childWorktreePath, params.childBranch);
  const trackedRes = runGitSync(["diff", "--name-only", diffBase], params.childWorktreePath, { allowFail: true });
  const statusRes = runGitSync(["--no-optional-locks", "status", "--porcelain", "-uall"], params.childWorktreePath, {
    allowFail: true,
  });
  const tracked =
    trackedRes.code === 0 && trackedRes.stdout
      ? trackedRes.stdout.split(/\r?\n/).map((p) => p.trim().replace(/\\/g, "/")).filter(Boolean)
      : [];
  const untracked =
    statusRes.code === 0 && statusRes.stdout
      ? statusRes.stdout
          .split(/\r?\n/)
          .filter((line) => line.startsWith("?? "))
          .map((line) => line.slice(3).trim().replace(/^"|"$/g, "").replace(/\\/g, "/"))
          .filter(Boolean)
      : [];
  const filesTouched = [...new Set([...tracked, ...untracked].filter((p) => !isSensitiveRepoRelPath(p)))].sort((a, b) =>
    a.localeCompare(b),
  );
  const statRes = runGitSync(["diff", "--stat", diffBase], params.childWorktreePath, { allowFail: true });
  const statText = statRes.code === 0 && statRes.stdout ? statRes.stdout : "";
  const diffStat =
    statText || (untracked.length > 0 ? `${untracked.length} untracked file(s)` : null);
  return { filesTouched, diffStat };
}

/**
 * Capture the subagent's changes inside its child worktree, verify and apply
 * the patch atomically onto the parent worktree, and clean up on clean apply.
 */
export async function extractAndApplySubagentPatch(params: {
  repoPath: string;
  parentWorktreePath: string;
  childWorktreePath: string;
  childBranch: string;
  skipCleanup?: boolean;
}): Promise<{ ok: boolean; patch: string; changedFiles: string[]; error?: string }> {
  if (!params.childWorktreePath || !existsSync(params.childWorktreePath)) {
    return { ok: false, patch: "", changedFiles: [], error: `child_worktree_missing: ${params.childWorktreePath}` };
  }
  if (!params.parentWorktreePath || !existsSync(params.parentWorktreePath)) {
    return { ok: false, patch: "", changedFiles: [], error: `parent_worktree_missing: ${params.parentWorktreePath}` };
  }

  const baseRef = subagentBaseRefName(params.childBranch);
  const baseCheck = await runGit(["rev-parse", "--verify", baseRef], params.childWorktreePath, { allowFail: true });
  let diffBase = baseCheck.code === 0 ? baseRef : "";
  if (!diffBase) {
    const parentHead = await runGit(["rev-parse", "--verify", "HEAD"], params.parentWorktreePath, { allowFail: true });
    if (parentHead.code === 0 && parentHead.stdout) {
      const mergeBase = await runGit(["merge-base", parentHead.stdout, "HEAD"], params.childWorktreePath, {
        allowFail: true,
      });
      if (mergeBase.code === 0 && mergeBase.stdout) {
        diffBase = mergeBase.stdout;
      }
    }
  }
  if (!diffBase) diffBase = "HEAD";

  // Inspect working tree entries first: reject symlinks or parent-escaping paths before staging.
  const statusRes = await runGitRaw(
    ["--no-optional-locks", "status", "--porcelain", "-z", "-uall"],
    params.childWorktreePath,
    { allowFail: true },
  );
  if (statusRes.code === 0 && statusRes.stdout) {
    const statusEntries = parsePorcelainStatusZ(statusRes.stdout);
    const untrackedSafe: string[] = [];
    for (const entry of statusEntries) {
      if (isUnsafePatchRelPath(params.parentWorktreePath, entry.path)) {
        return {
          ok: false,
          patch: "",
          changedFiles: [],
          error: `subagent_patch_path_outside_parent_worktree: ${entry.path}`,
        };
      }
      const absChildEntry = join(params.childWorktreePath, entry.path);
      try {
        if (lstatSync(absChildEntry).isSymbolicLink()) {
          return {
            ok: false,
            patch: "",
            changedFiles: [],
            error: `symlink_not_allowed_in_subagent_patch: ${entry.path}`,
          };
        }
      } catch {
        // Entry may be deleted
      }
      if (entry.status === "untracked") {
        untrackedSafe.push(entry.path);
      }
    }
    if (untrackedSafe.length > 0) {
      await runGitPathBatches(["add", "-N"], untrackedSafe, params.childWorktreePath);
    }
  }

  const nameRes = await runGitRaw(["diff", "--name-only", "-z", diffBase], params.childWorktreePath, { allowFail: true });
  const rawNames =
    nameRes.code === 0 && nameRes.stdout
      ? nameRes.stdout
          .split("\0")
          .map((p) => p.trim().replace(/\\/g, "/"))
          .filter(Boolean)
      : [];
  const sensitiveNames = rawNames.filter((p) => isSensitiveRepoRelPath(p));
  const changedFiles = [...new Set(rawNames.filter((p) => !isSensitiveRepoRelPath(p)))].sort((a, b) =>
    a.localeCompare(b),
  );

  for (const rel of changedFiles) {
    if (isUnsafePatchRelPath(params.parentWorktreePath, rel)) {
      return {
        ok: false,
        patch: "",
        changedFiles: [],
        error: `subagent_patch_path_outside_parent_worktree: ${rel}`,
      };
    }
  }

  if (changedFiles.length === 0) {
    if (!params.skipCleanup) {
      await cleanupSubagentWorktree({
        repoPath: params.repoPath,
        worktreePath: params.childWorktreePath,
        branch: params.childBranch,
      });
    }
    return { ok: true, patch: "", changedFiles: [] };
  }

  const rawArgs =
    sensitiveNames.length > 0
      ? ["diff", "--raw", "-z", diffBase, "--", ".", ...sensitiveNames.map((p) => `:!${p}`)]
      : ["diff", "--raw", "-z", diffBase];
  const rawDiffRes = await runGitRaw(rawArgs, params.childWorktreePath, { allowFail: true });

  const diffArgs =
    sensitiveNames.length > 0
      ? ["diff", "--binary", diffBase, "--", ".", ...sensitiveNames.map((p) => `:!${p}`)]
      : ["diff", "--binary", diffBase];
  const diffRes = await runGitRaw(diffArgs, params.childWorktreePath, { allowFail: true });
  if (diffRes.code !== 0) {
    return { ok: false, patch: "", changedFiles: [], error: diffRes.stderr || "git_diff_failed" };
  }

  const patch = diffRes.stdout;
  const safetyErr = validateSubagentDiffRawAndPatch({
    parentWorktreePath: params.parentWorktreePath,
    diffRawStdout: rawDiffRes.code === 0 ? rawDiffRes.stdout : "",
    patchText: patch,
  });
  if (safetyErr) {
    return { ok: false, patch: "", changedFiles: [], error: safetyErr };
  }

  if (!patch.trim()) {
    if (!params.skipCleanup) {
      await cleanupSubagentWorktree({
        repoPath: params.repoPath,
        worktreePath: params.childWorktreePath,
        branch: params.childBranch,
      });
    }
    return { ok: true, patch: "", changedFiles: [] };
  }

  const tmpPatchPath = join(tmpdir(), `bf-subagent-${newId("patch")}-${process.pid}.patch`);
  try {
    writeFileSync(tmpPatchPath, patch, "utf8");
    const checkRes = await runGit(["apply", "--check", tmpPatchPath], params.parentWorktreePath, { allowFail: true });
    if (checkRes.code !== 0) {
      return {
        ok: false,
        patch,
        changedFiles: [],
        error: checkRes.stderr || checkRes.stdout || "git_apply_check_failed",
      };
    }

    const applyRes = await runGit(["apply", tmpPatchPath], params.parentWorktreePath, { allowFail: true });
    if (applyRes.code !== 0) {
      return {
        ok: false,
        patch,
        changedFiles: [],
        error: applyRes.stderr || applyRes.stdout || "git_apply_failed",
      };
    }
  } finally {
    try {
      if (existsSync(tmpPatchPath)) unlinkSync(tmpPatchPath);
    } catch {
      // Best-effort temp patch cleanup
    }
  }

  if (!params.skipCleanup) {
    await cleanupSubagentWorktree({
      repoPath: params.repoPath,
      worktreePath: params.childWorktreePath,
      branch: params.childBranch,
    });
  }
  return { ok: true, patch, changedFiles };
}

/**
 * Merge a verified bot worktree branch back into the project's base repository,
 * creating a pre-merge hidden safety ref and aborting cleanly on conflict.
 */
export async function mergeBotWorktree(params: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  strategy: "squash" | "merge_commit";
  commitMessage: string;
}): Promise<{
  ok: boolean;
  mergeCommitSha?: string;
  preMergeRef?: string;
  conflicts?: string[];
  cleanedWorktree: boolean;
  error?: string;
}> {
  if (!params.repoPath || !existsSync(params.repoPath)) {
    return { ok: false, cleanedWorktree: false, error: "repo_path_missing" };
  }

  const baseStatus = await runGitRaw(["--no-optional-locks", "status", "--porcelain"], params.repoPath, {
    allowFail: true,
  });
  if (baseStatus.code !== 0) {
    return { ok: false, cleanedWorktree: false, error: baseStatus.stderr || "base_repo_git_error" };
  }
  if (baseStatus.stdout.trim().length > 0) {
    return { ok: false, cleanedWorktree: false, error: "base_repo_dirty" };
  }

  const env = gitCommitEnv();

  // Persist any uncommitted non-sensitive changes in the bot worktree onto its branch before merging.
  if (params.worktreePath && existsSync(params.worktreePath)) {
    const wtStatus = await runGitRaw(["--no-optional-locks", "status", "--porcelain"], params.worktreePath, {
      allowFail: true,
    });
    if (wtStatus.code !== 0) {
      return { ok: false, cleanedWorktree: false, error: wtStatus.stderr || "bot_worktree_git_error" };
    }
    if (wtStatus.stdout.trim().length > 0) {
      await runGit(["add", "-A"], params.worktreePath, { env });
      await unstageSensitivePaths(params.worktreePath, env);
      const cachedDiff = await runGit(["diff", "--cached", "--quiet"], params.worktreePath, {
        env,
        allowFail: true,
      });
      if (cachedDiff.code === 1) {
        await runGit(
          ["-c", "commit.gpgsign=false", "commit", "-m", "chore(bf): commit bot worktree changes before merge"],
          params.worktreePath,
          { env },
        );
      }
    }
  } else {
    const branchExists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${params.branch}`], params.repoPath, {
      allowFail: true,
    });
    if (branchExists.code !== 0) {
      return { ok: false, cleanedWorktree: false, error: "worktree_and_branch_missing" };
    }
  }

  const baseHead = (await runGit(["rev-parse", "HEAD"], params.repoPath)).stdout;
  const shortId = createHash("sha1")
    .update(`${params.branch}:${baseHead}:${Date.now()}:${randomUUID()}`)
    .digest("hex")
    .slice(0, 8);
  const preMergeRef = `refs/bot-factory/pre-merge/${shortId}`;
  await runGit(["update-ref", preMergeRef, baseHead], params.repoPath);

  const commitMsg = params.commitMessage.trim() || `Merge ${params.branch}`;

  const abortAndInspectConflicts = async (fallbackErr: string) => {
    const unmerged = await runGit(["diff", "--name-only", "--diff-filter=U"], params.repoPath, { allowFail: true });
    const conflicts = unmerged.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    await runGit(["merge", "--abort"], params.repoPath, { allowFail: true });
    await runGit(["reset", "--hard", baseHead], params.repoPath, { allowFail: true });
    await runGit(["clean", "-fd"], params.repoPath, { allowFail: true });
    return {
      ok: false as const,
      preMergeRef,
      conflicts,
      cleanedWorktree: false,
      error: conflicts.length > 0 || /conflict/i.test(fallbackErr) ? "merge_conflict" : fallbackErr || "merge_failed",
    };
  };

  if (params.strategy === "squash") {
    const squashRes = await runGit(["merge", "--squash", params.branch], params.repoPath, { env, allowFail: true });
    if (squashRes.code !== 0) {
      return await abortAndInspectConflicts(squashRes.stderr || squashRes.stdout);
    }
    const hasStaged = await runGit(["diff", "--cached", "--quiet"], params.repoPath, { env, allowFail: true });
    const commitArgs =
      hasStaged.code === 0
        ? ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", commitMsg]
        : ["-c", "commit.gpgsign=false", "commit", "-m", commitMsg];
    const commitRes = await runGit(commitArgs, params.repoPath, { env, allowFail: true });
    if (commitRes.code !== 0) {
      return await abortAndInspectConflicts(commitRes.stderr || commitRes.stdout);
    }
  } else {
    const mergeRes = await runGit(
      ["-c", "commit.gpgsign=false", "merge", "--no-ff", params.branch, "-m", commitMsg],
      params.repoPath,
      { env, allowFail: true },
    );
    if (mergeRes.code !== 0) {
      return await abortAndInspectConflicts(mergeRes.stderr || mergeRes.stdout);
    }
  }

  const mergeCommitSha = (await runGit(["rev-parse", "HEAD"], params.repoPath)).stdout;
  if (params.worktreePath) {
    removeBotWorktree(params.repoPath, params.worktreePath);
  }
  await runGit(["branch", "-D", params.branch], params.repoPath, { allowFail: true });

  return {
    ok: true,
    mergeCommitSha,
    preMergeRef,
    cleanedWorktree: true,
  };
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

const SAFE_REPO_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  "worktrees",
  ".bun",
  ".ssh",
  ".aws",
]);
const SAFE_REPO_MAX_FILE_BYTES = 512 * 1024;
const SAFE_REPO_BINARY_PROBE_BYTES = 4096;
const DIFF_MAX_FILES = 40;
const DIFF_MAX_PATCH_CHARS = 16_000;
const UNTRACKED_PATCH_MAX_BYTES = 64 * 1024;
const UNTRACKED_PATCH_MAX_LINES = 120;

function isSensitiveRepoBasename(name: string): boolean {
  const lower = name.toLowerCase().trim();
  return (
    lower === ".daemon-token" ||
    lower === ".ssh" ||
    lower === ".aws" ||
    lower === ".npmrc" ||
    lower === "config.json" ||
    lower === "secrets.env" ||
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower.endsWith(".pem") ||
    lower.startsWith(".pem") ||
    lower.endsWith(".key") ||
    lower.startsWith(".key") ||
    lower.endsWith(".db") ||
    lower.endsWith(".db-wal") ||
    lower.endsWith(".db-shm") ||
    lower.endsWith(".sqlite") ||
    lower === "id_rsa" ||
    lower.startsWith("id_rsa.") ||
    lower === "id_ed25519" ||
    lower.startsWith("id_ed25519.")
  );
}

function isSensitiveRepoRelPath(relPath: string): boolean {
  return relPath
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((segment) => {
      const lower = segment.toLowerCase().trim();
      return (
        lower === ".git" ||
        lower === "node_modules" ||
        lower === ".ssh" ||
        lower === ".aws" ||
        isSensitiveRepoBasename(segment)
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
        if (SAFE_REPO_SKIP_DIRS.has(entry.name.toLowerCase()) || isSensitiveRepoBasename(entry.name)) continue;
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
  const posixRel = canonicalRelativePathWithinRoot(targetRoot, check.absTarget);
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

function parsePorcelainStatusZ(stdout: string): GitStatusEntry[] {
  const out: GitStatusEntry[] = [];
  if (!stdout) return out;
  const records = stdout.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    if (!rec || rec.length < 4) continue;
    const code = rec.slice(0, 2);
    const pathPart = rec.slice(3).replace(/\\/g, "/");
    let origPath = "";
    if (code.includes("R") || code.includes("C")) {
      // With `git status --porcelain -z`, renames/copies emit `XY dest\0orig\0`.
      origPath = (records[i + 1] ?? "").replace(/\\/g, "/");
      i += 1;
    }
    if (!pathPart || isSensitiveRepoRelPath(pathPart) || (origPath && isSensitiveRepoRelPath(origPath))) {
      continue;
    }
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

async function readNumstatAsync(targetRoot: string): Promise<Map<string, { added: number; removed: number }>> {
  const map = new Map<string, { added: number; removed: number }>();
  let res = await runGit(["diff", "--numstat", "HEAD"], targetRoot, { allowFail: true });
  if (res.code !== 0) {
    res = await runGit(["diff", "--numstat"], targetRoot, { allowFail: true });
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

function parseUnifiedDiffMap(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!stdout) return map;
  const normalized = stdout.replace(/\r\n/g, "\n");
  const chunks = normalized.split(/^diff --git /m);
  for (const rawChunk of chunks) {
    if (!rawChunk.trim()) continue;
    const fullPatch = `diff --git ${rawChunk}`.trimEnd();
    const lines = fullPatch.split("\n");
    let minusPath = "";
    let plusPath = "";
    let renameToPath = "";
    for (const line of lines) {
      if (line.startsWith("@@ ")) break;
      if (line.startsWith("rename to ")) {
        renameToPath = line.slice("rename to ".length);
      } else if (line.startsWith("--- a/")) {
        minusPath = line.slice("--- a/".length);
      } else if (line.startsWith("+++ b/")) {
        plusPath = line.slice("+++ b/".length);
      }
    }
    let filePath = renameToPath || plusPath || minusPath;
    if (!filePath) {
      const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[0] ?? "");
      if (header) filePath = header[2]!;
    }
    filePath = filePath.replace(/^"|"$/g, "").replace(/\\/g, "/");
    if (!filePath || isSensitiveRepoRelPath(filePath)) continue;
    map.set(filePath, fullPatch);
  }
  return map;
}

async function readUnifiedDiffMapAsync(targetRoot: string): Promise<Map<string, string>> {
  let res = await runGitRaw(["diff", "--unified=3", "HEAD"], targetRoot, { allowFail: true });
  if (res.code !== 0) {
    res = await runGitRaw(["diff", "--unified=3"], targetRoot, { allowFail: true });
  }
  if (res.code !== 0) return new Map();
  return parseUnifiedDiffMap(res.stdout);
}

async function buildSyntheticUntrackedPatchAsync(
  absPath: string,
  relPath: string,
): Promise<{ patch: string; added: number }> {
  try {
    const st = await stat(absPath);
    if (!st.isFile() || st.size > UNTRACKED_PATCH_MAX_BYTES) {
      return { patch: "", added: 0 };
    }
    const buf = await readFile(absPath);
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

export async function computeWorkspaceGitDiff(
  repoOrWorktreePath: string,
  scrub?: (text: string) => string,
): Promise<GitDiffResponse> {
  const empty: GitDiffResponse = { branch: "main", filesChanged: 0, insertions: 0, deletions: 0, files: [] };
  if (!repoOrWorktreePath || !existsSync(repoOrWorktreePath)) return empty;

  const statusRes = await runGitRaw(["--no-optional-locks", "status", "--porcelain", "-z", "-uall"], repoOrWorktreePath, {
    allowFail: true,
  });
  const [branchRes, numstat, unifiedPatches] = await Promise.all([
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoOrWorktreePath, { allowFail: true }),
    readNumstatAsync(repoOrWorktreePath),
    readUnifiedDiffMapAsync(repoOrWorktreePath),
  ]);

  const branch =
    branchRes.code === 0 && branchRes.stdout && branchRes.stdout !== "HEAD" ? branchRes.stdout : "main";
  const entries = statusRes.code === 0 ? parsePorcelainStatusZ(statusRes.stdout) : [];
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
      const safe = isPathStrictlyWithinRoot(repoOrWorktreePath, entry.path);
      const synth = safe.ok
        ? await buildSyntheticUntrackedPatchAsync(safe.absTarget, entry.path)
        : { patch: "", added: 0 };
      patch = synth.patch;
      added = synth.added;
      untrackedInsertions += synth.added;
    } else {
      patch = unifiedPatches.get(entry.path) ?? "";
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
