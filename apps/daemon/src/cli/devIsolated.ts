import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const isolatedRoot = resolve(import.meta.dir, "../../../../.dev-runtime");
process.env.BOT_FACTORY_ROOT = isolatedRoot;

const { startBotFactoryDaemon } = await import("../index");

if (import.meta.main) {
  const portEnv = process.env.BOT_FACTORY_PORT ? Number(process.env.BOT_FACTORY_PORT) : undefined;
  const app = startBotFactoryDaemon({ rootDir: isolatedRoot, port: portEnv });
  const tokenPath = join(isolatedRoot, "system", ".daemon-token");
  const token =
    process.env.BOT_FACTORY_TOKEN?.trim() ||
    (existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "");

  process.stderr.write(`[bot-factory] Isolated BOT_FACTORY_ROOT=${isolatedRoot}\n`);
  if (token) {
    process.stderr.write(`[bot-factory] Open authenticated UI: http://127.0.0.1:${app.port}/?token=${token}\n`);
  }

  const shutdown = () => {
    app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
