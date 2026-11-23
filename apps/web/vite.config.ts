import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "vite";

function expandHome(inputPath: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return join(homedir(), inputPath.slice(2));
  }
  return resolve(inputPath);
}

function readTokenFile(filePath: string): string {
  try {
    if (!existsSync(filePath)) return "";
    return readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function resolveDaemonToken(): string {
  const envToken = process.env.BOT_FACTORY_TOKEN?.trim();
  if (envToken) return envToken;

  const envRoot = process.env.BOT_FACTORY_ROOT?.trim();
  if (envRoot) {
    return readTokenFile(join(expandHome(envRoot), "system", ".daemon-token"));
  }

  const defaultTokenPath = join(homedir(), "bot-factory", "system", ".daemon-token");
  const defaultToken = readTokenFile(defaultTokenPath);
  if (defaultToken) return defaultToken;

  const devRuntimeTokenPath = resolve(__dirname, "../../.dev-runtime/system/.daemon-token");
  return readTokenFile(devRuntimeTokenPath);
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@bot-factory/shared": resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4310",
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            const token = resolveDaemonToken();
            if (token) {
              proxyReq.setHeader("x-bf-token", token);
            }
          });
        },
      },
      "/ws": {
        target: "ws://127.0.0.1:4310",
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            const token = resolveDaemonToken();
            if (token) {
              proxyReq.setHeader("x-bf-token", token);
            }
          });
          proxy.on("proxyReqWs", (proxyReq) => {
            const token = resolveDaemonToken();
            if (token) {
              proxyReq.setHeader("x-bf-token", token);
            }
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
