import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HubConfig, MemoryFactRecord, MemoryKind } from "@bot-factory/shared";
import { SecretScrubber } from "../config";
import type { StateDatabase } from "../db/database";

export interface FrozenPromptInput {
  identity: string;
  toolsBrief: string;
  projectContext?: string;
  cwdIndependentInstructions?: string;
  worktreePath?: string | null;
  skillsIndex?: string;
  pluginBlocks?: Array<{ id: string; content: string }>;
  namespace: string;
  projectRoot?: string;
  modelLabel: string;
}

export interface MemoryProfile {
  namespace: string;
  staticFacts: MemoryFactRecord[];
  dynamicFacts: MemoryFactRecord[];
}

export interface DreamOpBatch {
  newFacts?: Array<{ entity?: string; factText: string; kind: MemoryKind; isStatic?: boolean; forgetAfter?: number | null }>;
  updates?: Array<{ oldId: string; factText: string; entity?: string; kind?: MemoryKind }>;
  extends?: Array<{ targetId: string; factText: string; entity?: string; kind?: MemoryKind }>;
  derives?: Array<{ sourceIds: string[]; factText: string; entity?: string }>;
}

export type DreamExtractor = (input: {
  namespace: string;
  chunks: string[];
  existingFacts: MemoryFactRecord[];
}) => Promise<DreamOpBatch>;

export interface MemoryProvider {
  isAvailable(): boolean;
  buildFrozenSystemPrompt(input: FrozenPromptInput): { systemPrompt: string; hash: string };
  getProfile(namespace: string): MemoryProfile;
  queuePrefetch(namespace: string, queryHint: string): void;
  prefetch(namespace: string): string;
  readL1File(filePath: string, maxChars: number): { content: string; usedChars: number; maxChars: number; gaugeHeader: string };
  writeL1File(filePath: string, content: string, maxChars: number): { usedChars: number; maxChars: number };
  ingestDocument(params: { docId: string; namespace: string; content: string; metadata?: Record<string, unknown>; instant?: boolean }): Promise<void>;
  search(namespace: string, query: string, limit?: number): { facts: MemoryFactRecord[]; messages: Array<{ id: string; agentId: string; content: string; createdAt: number }> };
  sweepExpired(): number;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function chunkTextSemantically(text: string, maxChunkChars = 900, overlapChars = 120): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [];

  const chunks: string[] = [];
  let current = "";
  for (const para of paragraphs) {
    if (current.length + para.length + 2 <= maxChunkChars) {
      current = current ? `${current}\n\n${para}` : para;
    } else {
      if (current) chunks.push(current);
      const tail = current.slice(-overlapChars);
      current = tail ? `${tail}\n\n${para}`.slice(0, maxChunkChars + overlapChars) : para.slice(0, maxChunkChars);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export class LocalSuperHermesMemory implements MemoryProvider {
  private readonly prefetchCache = new Map<string, string>();
  private readonly pendingDreamNamespaces = new Set<string>();
  private dreamTimer: ReturnType<typeof setTimeout> | null = null;
  private decayTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: StateDatabase,
    private readonly config: HubConfig,
    private readonly memoryDir: string,
    private readonly scrubber: SecretScrubber,
    private readonly dreamExtractor?: DreamExtractor,
  ) {
    mkdirSync(memoryDir, { recursive: true });
    this.ensureStarterL1Files();
  }

  public isAvailable(): boolean {
    return true;
  }

  private ensureStarterL1Files(): void {
    const userPath = join(this.memoryDir, this.config.memory.l1Files.globalUser.file);
    const globalPath = join(this.memoryDir, this.config.memory.l1Files.globalMemory.file);
    if (!existsSync(userPath)) {
      writeFileSync(userPath, "# User Profile\n- Prefers concise, clean-room, anti-bloat TypeScript architectures.\n- Local-first workflow under ~/bot-factory/.\n", "utf8");
    }
    if (!existsSync(globalPath)) {
      writeFileSync(globalPath, "# Global Memory\n- Bot-Factory Hub initialized on localhost (127.0.0.1).\n", "utf8");
    }
  }

  public readL1File(filePath: string, maxChars: number): { content: string; usedChars: number; maxChars: number; gaugeHeader: string } {
    const content = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
    const usedChars = content.length;
    const pct = Math.min(100, Math.round((usedChars / maxChars) * 100));
    return {
      content,
      usedChars,
      maxChars,
      gaugeHeader: `[${pct}% — ${usedChars}/${maxChars} chars]`,
    };
  }

  public writeL1File(filePath: string, content: string, maxChars: number): { usedChars: number; maxChars: number } {
    const clean = this.scrubber.scrub(content);
    if (clean.length > maxChars) {
      throw new Error(`l1_capacity_exceeded: ${clean.length}/${maxChars} chars in ${filePath}. Consolidate before saving.`);
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, clean, "utf8");
    return { usedChars: clean.length, maxChars };
  }

  /**
   * Hermes 3-tier Frozen System-Prompt builder:
   * Tier 1 (stable)  -> Identity + Tool guidance
   * Tier 2 (context) -> CWD-independent project context FIRST, worktree hints AFTER
   * Tier 3 (volatile)-> Frozen L1 snapshots + SQL Always-On Profile + bounded plugin blocks + model/env footer
   */
  public buildFrozenSystemPrompt(input: FrozenPromptInput): { systemPrompt: string; hash: string } {
    const userSpec = this.config.memory.l1Files.globalUser;
    const globalSpec = this.config.memory.l1Files.globalMemory;
    const projectSpec = this.config.memory.l1Files.projectMemory;

    const userL1 = this.readL1File(join(this.memoryDir, userSpec.file), userSpec.maxChars);
    const globalL1 = this.readL1File(join(this.memoryDir, globalSpec.file), globalSpec.maxChars);
    const projectL1 = input.projectRoot
      ? this.readL1File(join(input.projectRoot, projectSpec.file), projectSpec.maxChars)
      : null;

    const profile = this.getProfile(input.namespace);
    const profileLines = [
      ...profile.staticFacts.map((f) => `- [static] ${f.factText}`),
      ...profile.dynamicFacts.map((f) => `- [recent] ${f.factText}`),
    ];

    const perBlockCap = this.config.memory.pluginPromptCaps.maxCharsPerBlock;
    const totalCap = this.config.memory.pluginPromptCaps.maxCharsTotal;
    const sortedPlugins = [...(input.pluginBlocks ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    let usedPluginChars = 0;
    const renderedPlugins: string[] = [];
    for (const block of sortedPlugins) {
      const clipped = block.content.slice(0, perBlockCap);
      if (usedPluginChars + clipped.length > totalCap) break;
      usedPluginChars += clipped.length;
      renderedPlugins.push(`### Plugin: ${block.id}\n${clipped}`);
    }

    const tier1Stable = [
      "<!-- TIER:STABLE -->",
      input.identity.trim(),
      input.toolsBrief.trim(),
    ]
      .filter(Boolean)
      .join("\n\n");

    const tier2Context = [
      "<!-- TIER:CONTEXT_CWD_FREE -->",
      input.cwdIndependentInstructions?.trim() ?? "",
      input.projectContext?.trim() ?? "",
      input.worktreePath ? `<!-- TIER:CONTEXT_WORKSPACE -->\nWorkspace CWD: ${input.worktreePath}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const tier3Volatile = [
      "<!-- TIER:VOLATILE_FROZEN_SNAPSHOT -->",
      input.skillsIndex ? `## Skills\n${input.skillsIndex}` : "",
      `## USER.md ${userL1.gaugeHeader}\n${userL1.content}`,
      `## GLOBAL_MEMORY.md ${globalL1.gaugeHeader}\n${globalL1.content}`,
      projectL1 ? `## PROJECT MEMORY.md ${projectL1.gaugeHeader}\n${projectL1.content}` : "",
      profileLines.length > 0 ? `## Always-On Profile (${input.namespace})\n${profileLines.join("\n")}` : "",
      renderedPlugins.length > 0 ? `## Plugins\n${renderedPlugins.join("\n\n")}` : "",
      `Runtime Model: ${input.modelLabel}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const systemPrompt = this.scrubber.scrub(`${tier1Stable}\n\n${tier2Context}\n\n${tier3Volatile}`);
    return { systemPrompt, hash: sha256Hex(systemPrompt) };
  }

  public getProfile(namespace: string): MemoryProfile {
    const staticFacts = this.db.listLiveMemoryFacts(namespace, { isStatic: true, limit: 20 });
    const dynamicFacts = this.db.listLiveMemoryFacts(namespace, { isStatic: false, limit: 12 });
    return { namespace, staticFacts, dynamicFacts };
  }

  public queuePrefetch(namespace: string, queryHint: string): void {
    queueMicrotask(() => {
      try {
        const cleanQuery = this.scrubber.scrub(queryHint);
        const hits = this.db.searchLiveMemoryFacts(namespace, cleanQuery, 6);
        if (hits.length === 0) {
          this.prefetchCache.delete(namespace);
          return;
        }
        const block = hits.map((f) => `- (${f.kind}, v${f.version}) ${f.factText}`).join("\n");
        this.prefetchCache.set(namespace, `<ephemeral_memory_recall namespace="${namespace}">\n${block}\n</ephemeral_memory_recall>`);
      } catch {
        // Fail-open invariant: memory prefetch must never break a turn
      }
    });
  }

  public prefetch(namespace: string): string {
    return this.prefetchCache.get(namespace) ?? "";
  }

  public async ingestDocument(params: {
    docId: string;
    namespace: string;
    content: string;
    metadata?: Record<string, unknown>;
    instant?: boolean;
  }): Promise<void> {
    const clean = this.scrubber.scrub(params.content);
    const chunks = chunkTextSemantically(clean);
    const now = Date.now();

    this.db.runAtomicWrite(() => {
      this.db.db
        .query(
          `INSERT INTO documents (id, namespace, content, metadata_json, status, dream_status, updated_at)
           VALUES (?, ?, ?, ?, 'done', 'pending', ?)
           ON CONFLICT(id) DO UPDATE SET
             content = excluded.content,
             metadata_json = excluded.metadata_json,
             status = 'done',
             dream_status = 'pending',
             updated_at = excluded.updated_at`,
        )
        .run(params.docId, params.namespace, clean, JSON.stringify(params.metadata ?? {}), now);

      this.db.db.query("DELETE FROM chunks WHERE doc_id = ?").run(params.docId);
      for (let i = 0; i < chunks.length; i += 1) {
        this.db.db
          .query("INSERT INTO chunks (doc_id, namespace, position, text) VALUES (?, ?, ?, ?)")
          .run(params.docId, params.namespace, i, chunks[i]!);
      }
    });

    if (params.instant || this.config.memory.dreaming.mode === "instant") {
      await this.runDreamBatch(params.namespace);
    } else {
      this.scheduleDream(params.namespace);
    }
  }

  public scheduleDream(namespace: string): void {
    this.pendingDreamNamespaces.add(namespace);
    if (this.dreamTimer) return;
    this.dreamTimer = setTimeout(() => {
      this.dreamTimer = null;
      const namespaces = [...this.pendingDreamNamespaces];
      this.pendingDreamNamespaces.clear();
      for (const ns of namespaces) {
        void this.runDreamBatch(ns);
      }
    }, this.config.memory.dreaming.debounceSeconds * 1000);
  }

  public async runDreamBatch(namespace: string): Promise<number> {
    const pendingDocs = this.db.db
      .query("SELECT id FROM documents WHERE namespace = ? AND dream_status = 'pending' ORDER BY updated_at ASC LIMIT ?")
      .all(namespace, this.config.memory.dreaming.maxBatchDocs) as Array<{ id: string }>;

    if (pendingDocs.length === 0) return 0;

    const docIds = pendingDocs.map((d) => d.id);
    const chunks: string[] = [];
    for (const id of docIds) {
      const rows = this.db.db
        .query("SELECT text FROM chunks WHERE doc_id = ? ORDER BY position ASC")
        .all(id) as Array<{ text: string }>;
      for (const r of rows) chunks.push(r.text);
    }

    const existingFacts = this.db.listLiveMemoryFacts(namespace, { limit: 30 });
    const extractor = this.dreamExtractor ?? defaultHeuristicDreamExtractor;

    try {
      const ops = await extractor({ namespace, chunks, existingFacts });
      let applied = 0;
      const primaryDocId = docIds[0] ?? null;

      this.db.runAtomicWrite(() => {
        for (const f of ops.newFacts ?? []) {
          this.db.insertMemoryFact({
            namespace,
            docId: primaryDocId,
            entity: f.entity ?? "general",
            factText: this.scrubber.scrub(f.factText),
            kind: f.kind,
            isStatic: f.isStatic ?? f.kind === "preference",
            forgetAfter: f.forgetAfter ?? null,
          });
          applied += 1;
        }
        for (const u of ops.updates ?? []) {
          this.db.insertMemoryFact({
            namespace,
            docId: primaryDocId,
            entity: u.entity ?? "general",
            factText: this.scrubber.scrub(u.factText),
            kind: u.kind ?? "fact",
            supersedesFactId: u.oldId,
          });
          applied += 1;
        }
        for (const e of ops.extends ?? []) {
          this.db.insertMemoryFact({
            namespace,
            docId: primaryDocId,
            entity: e.entity ?? "general",
            factText: this.scrubber.scrub(e.factText),
            kind: e.kind ?? "fact",
            extendsFactId: e.targetId,
          });
          applied += 1;
        }
        for (const d of ops.derives ?? []) {
          this.db.insertMemoryFact({
            namespace,
            docId: primaryDocId,
            entity: d.entity ?? "general",
            factText: this.scrubber.scrub(d.factText),
            kind: "fact",
            isInference: true,
            confidence: 0.7,
            derivedFromFactIds: d.sourceIds,
          });
          applied += 1;
        }
        for (const id of docIds) {
          this.db.db.query("UPDATE documents SET dream_status = 'done', updated_at = ? WHERE id = ?").run(Date.now(), id);
        }
      });

      return applied;
    } catch {
      // Fail-open on dreaming errors
      return 0;
    }
  }

  public search(namespace: string, query: string, limit = 8) {
    const clean = this.scrubber.scrub(query);
    return {
      facts: this.db.searchLiveMemoryFacts(namespace, clean, limit),
      messages: this.db.searchMessages(clean, limit),
    };
  }

  public sweepExpired(): number {
    return this.db.sweepExpiredMemoryFacts();
  }

  public startDecaySweeper(): void {
    if (this.decayTimer) return;
    const ms = this.config.memory.defaultDecaySweepIntervalMinutes * 60_000;
    this.decayTimer = setInterval(() => {
      try {
        this.sweepExpired();
      } catch {
        // ignore
      }
    }, ms);
  }

  public stop(): void {
    if (this.dreamTimer) clearTimeout(this.dreamTimer);
    if (this.decayTimer) clearInterval(this.decayTimer);
    this.dreamTimer = null;
    this.decayTimer = null;
  }
}

async function defaultHeuristicDreamExtractor(input: {
  namespace: string;
  chunks: string[];
  existingFacts: MemoryFactRecord[];
}): Promise<DreamOpBatch> {
  const newFacts: NonNullable<DreamOpBatch["newFacts"]> = [];
  for (const chunk of input.chunks) {
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.replace(/^[-*]\s*/, "").trim();
      if (trimmed.length < 18 || trimmed.length > 240) continue;
      if (/^(decision|prefer|always|never|stack|architecture|rule|fix|steer)/i.test(trimmed)) {
        const isPref = /^prefer|always|never/i.test(trimmed);
        const isDecision = /^decision|stack|architecture|steer/i.test(trimmed);
        const duplicate = input.existingFacts.some((f) => f.factText.toLowerCase() === trimmed.toLowerCase());
        if (!duplicate) {
          newFacts.push({
            entity: input.namespace,
            factText: trimmed,
            kind: isDecision ? "decision" : isPref ? "preference" : "fact",
            isStatic: isPref || isDecision,
          });
        }
      }
    }
  }
  return { newFacts: newFacts.slice(0, 6) };
}
