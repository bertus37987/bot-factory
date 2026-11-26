import { z } from "zod";
import { MemoryKindSchema, newId, type HubConfig } from "@bot-factory/shared";
import { loadHubConfig, SecretScrubber, type LoadedRuntimeConfig } from "./config";
import { CommandCore } from "./core/commandCore";
import { StateDatabase } from "./db/database";
import {
  defaultHeuristicDreamExtractor,
  LocalSuperHermesMemory,
  type DreamExtractor,
  type DreamOpBatch,
  type EmbedderFn,
} from "./memory/memoryEngine";
import { OrchestrationEngine } from "./orchestration/engine";
import { DaemonServer } from "./rpc/server";
import { AcpSubprocessRuntime } from "./runtimes/acpSubprocessRuntime";
import { CliStreamRuntime } from "./runtimes/cliStreamRuntime";
import { NativeHttpRuntime } from "./runtimes/nativeHttpRuntime";
import { ModelRouter } from "./runtimes/router";

export interface BotFactoryApp {
  url: string;
  port: number;
  db: StateDatabase;
  core: CommandCore;
  memory: LocalSuperHermesMemory;
  engine: OrchestrationEngine;
  server: DaemonServer;
  cliStreamRuntime: CliStreamRuntime;
  stop: () => void;
}

const DreamOpBatchResponseSchema = z.object({
  newFacts: z
    .array(
      z.object({
        entity: z.string().optional(),
        factText: z.string().min(1),
        kind: MemoryKindSchema.default("fact"),
        isStatic: z.boolean().optional(),
        forgetAfter: z.number().nullable().optional(),
      }),
    )
    .optional(),
  updates: z
    .array(
      z.object({
        oldId: z.string().min(1),
        factText: z.string().min(1),
        entity: z.string().optional(),
        kind: MemoryKindSchema.optional(),
      }),
    )
    .optional(),
  extends: z
    .array(
      z.object({
        targetId: z.string().min(1),
        factText: z.string().min(1),
        entity: z.string().optional(),
        kind: MemoryKindSchema.optional(),
      }),
    )
    .optional(),
  derives: z
    .array(
      z.object({
        sourceIds: z.array(z.string().min(1)).min(1),
        factText: z.string().min(1),
        entity: z.string().optional(),
      }),
    )
    .optional(),
});

export function parseDreamOpBatchJson(rawText: string): DreamOpBatch | null {
  if (!rawText.trim()) return null;
  const unfenced = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    const parsedJson = JSON.parse(unfenced.slice(firstBrace, lastBrace + 1));
    const validated = DreamOpBatchResponseSchema.safeParse(parsedJson);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

export function resolveEmbeddingTarget(
  config: HubConfig,
  secrets: Record<string, string>,
): { provider: string; model: string } | null {
  const explicit = config.memory.embeddings;
  if (explicit) {
    const providerCfg = config.providers[explicit.provider];
    if (
      providerCfg &&
      providerCfg.runtime === "native_http" &&
      (!providerCfg.apiKeyEnv || Boolean(secrets[providerCfg.apiKeyEnv]))
    ) {
      return { provider: explicit.provider, model: explicit.model };
    }
  }

  let keylessFallback: { provider: string; model: string } | null = null;
  for (const [providerName, providerCfg] of Object.entries(config.providers)) {
    if (providerCfg.runtime !== "native_http" || !providerCfg.embeddingModel) continue;
    if (!providerCfg.apiKeyEnv) {
      keylessFallback ??= { provider: providerName, model: providerCfg.embeddingModel };
      continue;
    }
    if (secrets[providerCfg.apiKeyEnv]) {
      return { provider: providerName, model: providerCfg.embeddingModel };
    }
  }
  return keylessFallback;
}

function createLlmDreamExtractor(params: {
  runtimeCfg: LoadedRuntimeConfig;
  router: ModelRouter;
  nativeRuntime: NativeHttpRuntime;
  scrubber: SecretScrubber;
}): DreamExtractor {
  const { runtimeCfg, router, nativeRuntime, scrubber } = params;
  return async ({ namespace, chunks, existingFacts }) => {
    if (chunks.length === 0) return {};
    if (process.env.BOT_FACTORY_OFFLINE_MOCK === "1") {
      return defaultHeuristicDreamExtractor({ namespace, chunks, existingFacts });
    }

    let route;
    try {
      route = router.resolveIntent(runtimeCfg.config.memory.dreaming.modelIntent);
    } catch {
      return defaultHeuristicDreamExtractor({ namespace, chunks, existingFacts });
    }

    const providerCfg = runtimeCfg.config.providers[route.provider];
    if (!providerCfg || providerCfg.runtime !== "native_http") {
      return defaultHeuristicDreamExtractor({ namespace, chunks, existingFacts });
    }
    if (providerCfg.apiKeyEnv && !runtimeCfg.secrets[providerCfg.apiKeyEnv]) {
      return defaultHeuristicDreamExtractor({ namespace, chunks, existingFacts });
    }
    nativeRuntime.setConfig(runtimeCfg.config);
    nativeRuntime.updateSecrets(runtimeCfg.secrets);

    const systemPrompt = [
      "You are the Bot-Factory Supermemory Consolidation Engine.",
      `Extract durable facts, preferences, decisions, and inferences for namespace "${namespace}".`,
      "Reply with ONLY raw valid JSON (no markdown fences, no commentary) matching:",
      '{"newFacts":[{"entity":"string","factText":"string","kind":"fact|preference|decision|episode","isStatic":false}],"updates":[{"oldId":"fact_id","factText":"string","entity":"string","kind":"fact|preference|decision|episode"}],"extends":[{"targetId":"fact_id","factText":"string","entity":"string","kind":"fact|preference|decision|episode"}],"derives":[{"sourceIds":["fact_id"],"factText":"string","entity":"string"}]}',
      "Only reference IDs listed under Existing Facts for updates/extends/derives. Never include secrets or tokens.",
    ].join("\n");

    const existingBlock = existingFacts
      .slice(0, 30)
      .map((f) => `- [${f.id}] (${f.kind}, ${f.entity}) ${scrubber.scrub(f.factText)}`)
      .join("\n");
    const chunksBlock = scrubber.scrub(chunks.join("\n\n---\n\n")).slice(0, 16_000);
    const userText = `## Existing Facts\n${existingBlock || "(none)"}\n\n## New Document Chunks\n${chunksBlock}`;

    const sessionId = newId("dream");
    const handle = await nativeRuntime.startSession({
      agentId: "system_memory_dreamer",
      sessionId,
      provider: route.provider,
      model: route.model,
      cwd: runtimeCfg.memoryDir,
      systemPrompt,
    });

    try {
      let rawText = "";
      let streamError = false;
      for await (const evt of nativeRuntime.sendTurn(handle, {
        userText,
        history: [],
        maxToolSteps: 0,
      })) {
        if (evt.type === "text_delta") {
          rawText += evt.text;
        } else if (evt.type === "done") {
          rawText = evt.finalText || rawText;
        } else if (evt.type === "error") {
          streamError = true;
        }
      }

      if (!streamError) {
        const parsed = parseDreamOpBatchJson(rawText);
        if (parsed) return parsed;
      }
    } catch {
      // Fall back gracefully to deterministic extractor below
    } finally {
      await nativeRuntime.closeSession(handle).catch(() => {});
    }

    return defaultHeuristicDreamExtractor({ namespace, chunks, existingFacts });
  };
}

function createEmbedderFn(params: {
  runtimeCfg: LoadedRuntimeConfig;
  nativeRuntime: NativeHttpRuntime;
}): EmbedderFn {
  const { runtimeCfg, nativeRuntime } = params;
  return async (text: string) => {
    const cleanText = text.trim();
    if (!cleanText || process.env.BOT_FACTORY_OFFLINE_MOCK === "1") return null;
    const target = resolveEmbeddingTarget(runtimeCfg.config, runtimeCfg.secrets);
    if (!target) return null;
    nativeRuntime.setConfig(runtimeCfg.config);
    nativeRuntime.updateSecrets(runtimeCfg.secrets);
    const vector = await nativeRuntime.embedText(target.provider, target.model, cleanText);
    if (!vector || vector.length === 0) return null;
    return { model: `${target.provider}/${target.model}`, vector };
  };
}

export function startBotFactoryDaemon(overrides?: {
  configPath?: string;
  rootDir?: string;
  dbPath?: string;
  port?: number;
}): BotFactoryApp {
  const runtimeCfg = loadHubConfig(overrides);
  const scrubber = new SecretScrubber(runtimeCfg.secrets);
  const db = new StateDatabase(runtimeCfg.dbPath);
  const recovery = db.recoverAfterRestart();

  const core = new CommandCore(db);
  const router = new ModelRouter(runtimeCfg.config);
  const nativeRuntime = new NativeHttpRuntime(runtimeCfg.config, runtimeCfg.secrets, scrubber);
  const acpRuntime = new AcpSubprocessRuntime(runtimeCfg.config, runtimeCfg.logsDir, scrubber);
  const cliStreamRuntime = new CliStreamRuntime(runtimeCfg.config, runtimeCfg.logsDir, runtimeCfg.secrets, scrubber);
  const dreamExtractor = createLlmDreamExtractor({ runtimeCfg, router, nativeRuntime, scrubber });
  const embedderFn = createEmbedderFn({ runtimeCfg, nativeRuntime });
  const memory = new LocalSuperHermesMemory(
    db,
    runtimeCfg.config,
    runtimeCfg.memoryDir,
    scrubber,
    dreamExtractor,
    embedderFn,
  );
  const engine = new OrchestrationEngine(
    runtimeCfg,
    db,
    core,
    memory,
    router,
    nativeRuntime,
    acpRuntime,
    scrubber,
    cliStreamRuntime,
  );
  const server = new DaemonServer(runtimeCfg, db, core, engine, memory, scrubber);

  const { port, url } = server.start();
  engine.setBoundPort(port);
  const resumedAutonomousTasks = engine.getAutonomyLoop().resumePersistedGoals();
  core.startOutboxWorker(200);
  memory.startDecaySweeper();

  process.stderr.write(
    `[bot-factory] Daemon listening at ${url} (epoch=${db.epoch}, recovered: effects=${recovery.retiredEffects}, admissions=${recovery.unknownAdmissions}, resumedAutonomousTasks=${resumedAutonomousTasks})\n`,
  );
  if (import.meta.main) {
    process.stderr.write(`[bot-factory] Authenticated UI: http://127.0.0.1:${port}/?token=${runtimeCfg.sessionToken}\n`);
  }

  const stop = () => {
    core.stopOutboxWorker();
    memory.stop();
    engine.shutdownSync();
    cliStreamRuntime.shutdownAllSync();
    server.stop();
    db.close();
  };

  return { url, port, db, core, memory, engine, server, cliStreamRuntime, stop };
}

if (import.meta.main) {
  const portEnv = process.env.BOT_FACTORY_PORT ? Number(process.env.BOT_FACTORY_PORT) : undefined;
  const app = startBotFactoryDaemon({ port: portEnv });
  const shutdown = () => {
    app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
