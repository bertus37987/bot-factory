import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startBotFactoryDaemon, type BotFactoryApp } from "../apps/daemon/src/index";

const REPO_ROOT = resolve(import.meta.dir, "..");
const WEB_DIST_INDEX = resolve(REPO_ROOT, "apps/web/dist/index.html");
const PLAYWRIGHT_SCRIPT = resolve(import.meta.dir, "ui_e2e_playwright.py");
const PYTHON_EXE = Bun.which("python3") ?? Bun.which("python") ?? "python3";

interface PlaywrightProbeResult {
  available: boolean;
  reason?: string;
}

function probePythonPlaywright(): PlaywrightProbeResult {
  if (process.env.BOT_FACTORY_SKIP_PLAYWRIGHT === "1") {
    return { available: false, reason: "BOT_FACTORY_SKIP_PLAYWRIGHT=1" };
  }
  try {
    const probe = Bun.spawnSync(
      [
        PYTHON_EXE,
        "-c",
        [
          "import os",
          "from playwright.sync_api import sync_playwright",
          "with sync_playwright() as p:",
          "    exe = p.chromium.executable_path",
          "    assert exe and os.path.exists(exe), f'missing chromium executable: {exe}'",
        ].join("\n"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (probe.exitCode !== 0) {
      const stderr = probe.stderr.toString("utf8").trim();
      const stdout = probe.stdout.toString("utf8").trim();
      return {
        available: false,
        reason: stderr || stdout || `python_exit_${probe.exitCode}`,
      };
    }
    return { available: true };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

const playwrightProbe = probePythonPlaywright();
const shouldSkipPlaywright = process.env.BOT_FACTORY_SKIP_PLAYWRIGHT === "1" || !playwrightProbe.available;

let prevOfflineMock: string | undefined;
let prevOpenAiKey: string | undefined;
let runningApp: BotFactoryApp | null = null;
let tempRoot: string | null = null;

beforeEach(() => {
  prevOfflineMock = process.env.BOT_FACTORY_OFFLINE_MOCK;
  prevOpenAiKey = process.env.OPENAI_API_KEY;
});

afterEach(() => {
  try {
    runningApp?.stop();
    runningApp = null;
    if (tempRoot) {
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // Windows handle release delay
      }
      tempRoot = null;
    }
  } finally {
    if (prevOfflineMock === undefined) delete process.env.BOT_FACTORY_OFFLINE_MOCK;
    else process.env.BOT_FACTORY_OFFLINE_MOCK = prevOfflineMock;
    if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAiKey;
    prevOfflineMock = undefined;
    prevOpenAiKey = undefined;
  }
});

describe("Bot-Factory Studio Playwright UI E2E", () => {
  it.skipIf(shouldSkipPlaywright)(
    "drives full Studio UI flow in headless Chromium with zero page or console errors",
    async () => {
      if (!playwrightProbe.available) {
        throw new Error(`Python Playwright + Chromium unavailable: ${playwrightProbe.reason ?? "unknown"}`);
      }
      expect(existsSync(WEB_DIST_INDEX)).toBe(true);
      expect(existsSync(PLAYWRIGHT_SCRIPT)).toBe(true);

      process.env.BOT_FACTORY_OFFLINE_MOCK = "1";
      delete process.env.OPENAI_API_KEY;

      tempRoot = mkdtempSync(join(tmpdir(), "bf-ui-e2e-"));
      const app = startBotFactoryDaemon({ rootDir: tempRoot, port: 0 });
      runningApp = app;

      const token = readFileSync(join(tempRoot, "system", ".daemon-token"), "utf8").trim();
      expect(token.length).toBeGreaterThan(10);

      const childEnv: Record<string, string | undefined> = {
        ...process.env,
        BOT_FACTORY_OFFLINE_MOCK: "1",
        BASE_URL: app.url,
        TOKEN: token,
        PROJECT_ROOT: tempRoot,
        PYTHONUNBUFFERED: "1",
      };
      delete childEnv.OPENAI_API_KEY;

      const proc = Bun.spawn([PYTHON_EXE, PLAYWRIGHT_SCRIPT], {
        cwd: REPO_ROOT,
        env: childEnv,
        stdout: "pipe",
        stderr: "pipe",
      });

      let timedOut = false;
      const killTimer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {
          // process already exited
        }
      }, 45_000);

      const [exitCode, stdoutText, stderrText] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      clearTimeout(killTimer);

      if (timedOut || exitCode !== 0) {
        throw new Error(
          `Playwright UI E2E failed (timedOut=${timedOut}, exitCode=${exitCode})\n--- STDOUT ---\n${stdoutText}\n--- STDERR ---\n${stderrText}`,
        );
      }

      expect(exitCode).toBe(0);
    },
    60_000,
  );
});
