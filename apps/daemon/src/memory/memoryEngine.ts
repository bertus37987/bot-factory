import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

export type EmbedderFn = (text: string) => Promise<{ model: string; vector: number[] } | null>;

export type L1TargetName = "user" | "global" | "project";

export interface L1TargetSnapshot {
  target: L1TargetName;
  filePath: string;
  content: string;
  usedChars: number;
  maxChars: number;
  gaugeHeader: string;
}

export interface HybridSearchResult {
  facts: MemoryFactRecord[];
  relatedFacts: MemoryFactRecord[];
  messages: Array<{ id: string; agentId: string; content: string; createdAt: number }>;
  usedEmbeddings: boolean;
}

const VALID_MEMORY_KINDS = new Set<MemoryKind>(["fact", "preference", "decision", "episode"]);

function normalizeMemoryKind(kind: unknown, fallback: MemoryKind = "fact"): MemoryKind {
  return typeof kind === "string" && VALID_MEMORY_KINDS.has(kind as MemoryKind) ? (kind as MemoryKind) : fallback;
}

export function l2Normalize(vector: number[]): number[] {
  let sumSq = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const v = vector[i]!;
    if (Number.isFinite(v)) sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (!Number.isFinite(norm) || norm <= 0) return vector.slice();
  return vector.map((v) => (Number.isFinite(v) ? v / norm : 0));
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const va = a[i]!;
    const vb = b[i]!;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface MemoryProvider {
  isAvailable(): boolean;
  buildFrozenSystemPrompt(input: FrozenPromptInput): { systemPrompt: string; hash: string };
  getProfile(namespace: string): MemoryProfile;
  queuePrefetch(namespace: string, queryHint: string, scopeKey?: string): void;
  prefetch(namespace: string, scopeKey?: string): string;
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
  private readonly dreamInFlight = new Set<string>();
  private readonly dreamPendingRescan = new Set<string>();
  private readonly dreamPendingInstant = new Set<string>();
  private dreamTimer: ReturnType<typeof setTimeout> | null = null;
  private decayTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: StateDatabase,
    private config: HubConfig,
    private readonly memoryDir: string,
    private readonly scrubber: SecretScrubber,
    private readonly dreamExtractor?: DreamExtractor,
    private readonly embedder?: EmbedderFn,
  ) {
    mkdirSync(memoryDir, { recursive: true });
    this.ensureStarterL1Files();
  }

  public setConfig(newConfig: HubConfig): void {
    this.config = newConfig;
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
    const raw = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
    const usedChars = raw.length;
    const truncated = usedChars > maxChars;
    const content = truncated ? raw.slice(0, maxChars) : raw;
    const pct = Math.min(100, Math.round((usedChars / maxChars) * 100));
    return {
      content,
      usedChars,
      maxChars,
      gaugeHeader: `[${pct}% — ${Math.min(usedChars, maxChars)}/${maxChars} chars${truncated ? " — truncated" : ""}]`,
    };
  }

  public writeL1File(filePath: string, content: string, maxChars: number): { usedChars: number; maxChars: number } {
    const clean = this.scrubber.scrub(content);
    if (clean.length > maxChars) {
      throw new Error(`l1_capacity_exceeded: ${clean.length}/${maxChars} chars in ${filePath}. Consolidate before saving.`);
    }
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmpPath, clean, "utf8");
      renameSync(tmpPath, filePath);
    } catch (err) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // best-effort temp cleanup
      }
      throw err;
    }
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

  private prefetchCacheKey(namespace: string, scopeKey?: string): string {
    return `${namespace}\u001f${scopeKey ?? "shared"}`;
  }

  public queuePrefetch(namespace: string, queryHint: string, scopeKey?: string): void {
    queueMicrotask(() => {
      void this.recallForTurn(namespace, queryHint, 6, scopeKey).catch(() => {
        // Fail-open invariant: memory prefetch must never break a turn
      });
    });
  }

  public prefetch(namespace: string, scopeKey?: string): string {
    return this.prefetchCache.get(this.prefetchCacheKey(namespace, scopeKey)) ?? "";
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
      if (this.dreamInFlight.has(params.namespace)) {
        this.dreamPendingInstant.add(params.namespace);
      }
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

  private async embedFacts(facts: MemoryFactRecord[]): Promise<void> {
    if (!this.embedder || facts.length === 0) return;
    for (const fact of facts) {
      try {
        const res = await this.embedder(fact.factText);
        if (!res || !Array.isArray(res.vector) || res.vector.length === 0) continue;
        const normalized = l2Normalize(res.vector);
        this.db.upsertMemoryEmbedding(fact.id, res.model, normalized);
      } catch {
        // Fail-open invariant: embedding failure must never abort dreaming or writes
      }
    }
  }

  public async runDreamBatch(namespace: string): Promise<number> {
    if (this.dreamInFlight.has(namespace)) {
      this.dreamPendingRescan.add(namespace);
      return 0;
    }

    this.dreamInFlight.add(namespace);
    try {
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
      const ops = await extractor({ namespace, chunks, existingFacts });
      let applied = 0;
      const primaryDocId = docIds[0] ?? null;
      const insertedFacts: MemoryFactRecord[] = [];

      this.db.runAtomicWrite(() => {
        for (const f of ops.newFacts ?? []) {
          const cleanText = this.scrubber.scrub(String(f.factText ?? "")).trim();
          if (!cleanText) continue;
          const kind = normalizeMemoryKind(f.kind, "fact");
          const inserted = this.db.insertMemoryFact({
            namespace,
            docId: primaryDocId,
            entity: this.scrubber.scrub(String(f.entity ?? "general")).trim() || "general",
            factText: cleanText,
            kind,
            isStatic: f.isStatic ?? kind === "preference",
            forgetAfter: f.forgetAfter ?? null,
          });
          insertedFacts.push(inserted);
          applied += 1;
        }
        for (const u of ops.updates ?? []) {
          const cleanText = this.scrubber.scrub(String(u.factText ?? "")).trim();
          if (!cleanText) continue;
          const inserted = this.db.insertMemoryFact({
            namespace,
            docId: primaryDocId,
            entity: this.scrubber.scrub(String(u.entity ?? "general")).trim() || "general",
            factText: cleanText,
            kind: normalizeMemoryKind(u.kind, "fact"),
            supersedesFactId: u.oldId,
          });
          insertedFacts.push(inserted);
          applied += 1;
        }
        for (const e of ops.extends ?? []) {
          const cleanText = this.scrubber.scrub(String(e.factText ?? "")).trim();
          if (!cleanText) continue;
          const targetExists = Boolean(e.targetId && this.db.getMemoryFact(e.targetId));
          const inserted = this.db.insertMemoryFact({
            namespace,
            docId: primaryDocId,
            entity: this.scrubber.scrub(String(e.entity ?? "general")).trim() || "general",
            factText: cleanText,
            kind: normalizeMemoryKind(e.kind, "fact"),
            extendsFactId: targetExists ? e.targetId : undefined,
          });
          insertedFacts.push(inserted);
          applied += 1;
        }
        for (const d of ops.derives ?? []) {
          const cleanText = this.scrubber.scrub(String(d.factText ?? "")).trim();
          if (!cleanText) continue;
          const validSources = (d.sourceIds ?? []).filter((sid) => Boolean(sid && this.db.getMemoryFact(sid)));
          const inserted = this.db.insertMemoryFact({
            namespace,
            docId: primaryDocId,
            entity: this.scrubber.scrub(String(d.entity ?? "general")).trim() || "general",
            factText: cleanText,
            kind: "fact",
            isInference: true,
            confidence: 0.7,
            derivedFromFactIds: validSources,
          });
          insertedFacts.push(inserted);
          applied += 1;
        }
        for (const id of docIds) {
          this.db.db.query("UPDATE documents SET dream_status = 'done', updated_at = ? WHERE id = ?").run(Date.now(), id);
        }
      });

      if (this.embedder && insertedFacts.length > 0) {
        await this.embedFacts(insertedFacts);
      }

      return applied;
    } catch {
      // Fail-open on dreaming errors
      return 0;
    } finally {
      this.dreamInFlight.delete(namespace);
      const shouldRescan = this.dreamPendingRescan.delete(namespace);
      const wasInstant = this.dreamPendingInstant.delete(namespace);
      if (shouldRescan) {
        try {
          const hasMore = this.db.db
            .query("SELECT 1 FROM documents WHERE namespace = ? AND dream_status = 'pending' LIMIT 1")
            .get(namespace);
          if (hasMore) {
            if (wasInstant) {
              void this.runDreamBatch(namespace);
            } else {
              this.scheduleDream(namespace);
            }
          }
        } catch {
          // ignore DB closed during shutdown
        }
      }
    }
  }

  public search(namespace: string, query: string, limit = 8) {
    const clean = this.scrubber.scrub(query);
    return {
      facts: this.db.searchLiveMemoryFacts(namespace, clean, limit),
      messages: this.db.searchMessages(clean, limit),
    };
  }

  public async hybridSearch(namespace: string, query: string, limit = 8): Promise<HybridSearchResult> {
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const clean = this.scrubber.scrub(query).trim();
    const messages = clean ? this.db.searchMessages(clean, safeLimit) : [];

    if (!clean) {
      return {
        facts: this.db.listLiveMemoryFacts(namespace, { limit: safeLimit }),
        relatedFacts: [],
        messages,
        usedEmbeddings: false,
      };
    }

    const ftsHits = this.db.searchLiveMemoryFacts(namespace, clean, safeLimit * 2);
    let vecHits: Array<{ factId: string; sim: number }> = [];
    let usedEmbeddings = false;

    if (this.embedder) {
      try {
        const qEmb = await this.embedder(clean);
        if (qEmb && Array.isArray(qEmb.vector) && qEmb.vector.length > 0) {
          const normQuery = l2Normalize(qEmb.vector);
          const stored = this.db.listMemoryEmbeddingsByNamespace(namespace);
          vecHits = stored
            .filter((row) => row.vector.length === normQuery.length)
            .map((row) => ({ factId: row.factId, sim: cosineSimilarity(normQuery, row.vector) }))
            .filter((row) => row.sim > 0)
            .sort((a, b) => b.sim - a.sim)
            .slice(0, safeLimit * 2);
          usedEmbeddings = true;
        }
      } catch {
        // Gracefully fall back to FTS5-only when embedder fails or is offline
      }
    }

    const RRF_K = 60;
    const fusedMap = new Map<string, { score: number; vecSim: number; fact?: MemoryFactRecord }>();

    for (let i = 0; i < ftsHits.length; i += 1) {
      const fact = ftsHits[i]!;
      const prev = fusedMap.get(fact.id);
      const rrf = 1 / (RRF_K + i + 1);
      if (prev) {
        prev.score += rrf;
        prev.fact = fact;
      } else {
        fusedMap.set(fact.id, { score: rrf, vecSim: 0, fact });
      }
    }

    for (let i = 0; i < vecHits.length; i += 1) {
      const hit = vecHits[i]!;
      const prev = fusedMap.get(hit.factId);
      const rrf = 1 / (RRF_K + i + 1);
      if (prev) {
        prev.score += rrf;
        prev.vecSim = hit.sim;
      } else {
        fusedMap.set(hit.factId, { score: rrf, vecSim: hit.sim });
      }
    }

    const rankedEntries: Array<{ fact: MemoryFactRecord; score: number; vecSim: number }> = [];
    for (const [factId, entry] of fusedMap.entries()) {
      const fact = entry.fact ?? this.db.getMemoryFact(factId);
      if (!fact || fact.namespace !== namespace || !fact.isLatest || fact.isForgotten) continue;
      if (fact.forgetAfter !== null && fact.forgetAfter <= Date.now()) continue;
      rankedEntries.push({ fact, score: entry.score, vecSim: entry.vecSim });
    }

    rankedEntries.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.vecSim !== a.vecSim) return b.vecSim - a.vecSim;
      return b.fact.updatedAt - a.fact.updatedAt;
    });

    const primaryFacts = rankedEntries.slice(0, safeLimit).map((e) => e.fact);
    const primaryIds = new Set(primaryFacts.map((f) => f.id));
    const seedIds = primaryFacts.slice(0, Math.min(4, primaryFacts.length)).map((f) => f.id);

    const relatedFacts =
      seedIds.length > 0
        ? this.db
            .getRelatedFacts(seedIds, this.config.memory.graphMaxHops)
            .filter((f) => f.namespace === namespace && !primaryIds.has(f.id))
            .slice(0, safeLimit)
        : [];

    const facts = primaryFacts.slice();
    for (const rel of relatedFacts) {
      if (facts.length >= safeLimit) break;
      facts.push(rel);
    }

    return { facts, relatedFacts, messages, usedEmbeddings };
  }

  public async recallForTurn(namespace: string, query: string, limit = 6, scopeKey?: string): Promise<string> {
    const cacheKey = this.prefetchCacheKey(namespace, scopeKey);
    try {
      const cleanQuery = this.scrubber.scrub(query).trim();
      if (!cleanQuery) {
        this.prefetchCache.delete(cacheKey);
        return "";
      }
      const res = await this.hybridSearch(namespace, cleanQuery, limit);
      const seen = new Set<string>();
      const lines: string[] = [];

      for (const f of res.facts) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        lines.push(`- (${f.kind}, v${f.version}) ${f.factText}`);
      }
      for (const rf of res.relatedFacts.slice(0, 4)) {
        if (seen.has(rf.id)) continue;
        seen.add(rf.id);
        lines.push(`- (related ${rf.kind}, v${rf.version}) ${rf.factText}`);
      }

      if (lines.length === 0) {
        this.prefetchCache.delete(cacheKey);
        return "";
      }

      const block = this.scrubber.scrub(
        `<ephemeral_memory_recall namespace="${namespace}">\n${lines.join("\n")}\n</ephemeral_memory_recall>`,
      );
      this.prefetchCache.set(cacheKey, block);
      return block;
    } catch {
      return "";
    }
  }

  public rememberFact(params: {
    namespace: string;
    factText: string;
    kind: MemoryKind;
    entity?: string;
    isStatic?: boolean;
    forgetAfter?: number | null;
  }): MemoryFactRecord {
    const cleanText = this.scrubber.scrub(params.factText).trim();
    if (!cleanText) {
      throw new Error("empty_memory_fact");
    }
    const cleanEntity = this.scrubber.scrub(params.entity ?? "general").trim() || "general";
    const kind = normalizeMemoryKind(params.kind, "fact");

    const fact = this.db.runAtomicWrite(() =>
      this.db.insertMemoryFact({
        namespace: params.namespace,
        entity: cleanEntity,
        factText: cleanText,
        kind,
        isStatic: params.isStatic ?? kind === "preference",
        forgetAfter: params.forgetAfter ?? null,
      }),
    );

    if (this.embedder) {
      void this.embedFacts([fact]);
    }
    return fact;
  }

  public forgetFact(factId: string, reason: string): boolean {
    const cleanReason = this.scrubber.scrub(reason || "forgotten_by_user").trim() || "forgotten_by_user";
    return this.db.forgetMemoryFact(factId, cleanReason);
  }

  private resolveL1Spec(target: L1TargetName, projectRoot?: string): { filePath: string; maxChars: number } {
    if (target === "user") {
      const spec = this.config.memory.l1Files.globalUser;
      return { filePath: join(this.memoryDir, spec.file), maxChars: spec.maxChars };
    }
    if (target === "global") {
      const spec = this.config.memory.l1Files.globalMemory;
      return { filePath: join(this.memoryDir, spec.file), maxChars: spec.maxChars };
    }
    if (!projectRoot) {
      throw new Error("project_root_required_for_project_l1");
    }
    const spec = this.config.memory.l1Files.projectMemory;
    return { filePath: join(projectRoot, spec.file), maxChars: spec.maxChars };
  }

  public getL1Target(target: L1TargetName, projectRoot?: string): L1TargetSnapshot {
    const { filePath, maxChars } = this.resolveL1Spec(target, projectRoot);
    const read = this.readL1File(filePath, maxChars);
    return {
      target,
      filePath,
      content: this.scrubber.scrub(read.content),
      usedChars: read.usedChars,
      maxChars: read.maxChars,
      gaugeHeader: read.gaugeHeader,
    };
  }

  public updateL1Target(target: L1TargetName, content: string, projectRoot?: string): L1TargetSnapshot {
    const { filePath, maxChars } = this.resolveL1Spec(target, projectRoot);
    this.writeL1File(filePath, content, maxChars);
    return this.getL1Target(target, projectRoot);
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

export async function defaultHeuristicDreamExtractor(input: {
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
