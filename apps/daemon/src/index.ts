import { loadHubConfig, SecretScrubber } from "./config";
import { CommandCore } from "./core/commandCore";
import { StateDatabase } from "./db/database";
import { LocalSuperHermesMemory } from "./memory/memoryEngine";
import { OrchestrationEngine } from "./orchestration/engine";
import { DaemonServer } from "./rpc/server";
import { AcpSubprocessRuntime } from "./runtimes/acpSubprocessRuntime";
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
  stop: () => void;
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
  const memory = new LocalSuperHermesMemory(db, runtimeCfg.config, runtimeCfg.memoryDir, scrubber);
  const router = new ModelRouter(runtimeCfg.config);
  const nativeRuntime = new NativeHttpRuntime(runtimeCfg.config, runtimeCfg.secrets, scrubber);
  const acpRuntime = new AcpSubprocessRuntime(runtimeCfg.config, runtimeCfg.logsDir, scrubber);
  const engine = new OrchestrationEngine(runtimeCfg, db, core, memory, router, nativeRuntime, acpRuntime, scrubber);
  const server = new DaemonServer(runtimeCfg, db, core, engine);

  core.startOutboxWorker(200);
  memory.startDecaySweeper();
  const { port, url } = server.start();
  engine.setBoundPort(port);

  process.stderr.write(
    `[bot-factory] Daemon listening at ${url} (epoch=${db.epoch}, recovered: effects=${recovery.retiredEffects}, admissions=${recovery.unknownAdmissions})\n`,
  );

  const stop = () => {
    core.stopOutboxWorker();
    memory.stop();
    engine.shutdownSync();
    server.stop();
    db.close();
  };

  return { url, port, db, core, memory, engine, server, stop };
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
