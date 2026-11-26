import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHubConfig, redactHubConfigForExposure, restoreRedactedProviderEnvValues } from "../apps/daemon/src/config";

it("redacts sensitive provider env values before exposing hub config", () => {
  const root = mkdtempSync(join(tmpdir(), "bf-config-redaction-"));
  try {
    const { config } = loadHubConfig({ rootDir: root, port: 0 });
    const providerId = Object.keys(config.providers)[0];
    if (!providerId) throw new Error("default config has no provider");
    const provider = config.providers[providerId];
    if (!provider) throw new Error("default provider missing");
    provider.env = {
      OPENAI_API_KEY: "sk-test-secret-value",
      DEVIN_MODEL: "opus-4.5",
    };
    const exposed = redactHubConfigForExposure(config);
    expect(exposed.providers[providerId]?.env?.OPENAI_API_KEY).toBe("[REDACTED]");
    expect(exposed.providers[providerId]?.env?.DEVIN_MODEL).toBe("opus-4.5");
    expect(config.providers[providerId]?.env?.OPENAI_API_KEY).toBe("sk-test-secret-value");

    const patch = structuredClone({ providers: exposed.providers });
    restoreRedactedProviderEnvValues(patch, config);
    const patchedEnv = (patch.providers as Record<string, { env?: Record<string, string> }>)[providerId]?.env;
    expect(patchedEnv?.OPENAI_API_KEY).toBe("sk-test-secret-value");
    expect(patchedEnv?.DEVIN_MODEL).toBe("opus-4.5");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
