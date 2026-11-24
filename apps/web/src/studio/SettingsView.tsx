import type {
  HubConfig,
  ProjectRecord,
  ProviderConfig,
  RouteTarget,
} from "@bot-factory/shared";
import {
  CheckCircle2,
  Cpu,
  KeyRound,
  Plus,
  RefreshCw,
  Route,
  Server,
  Shield,
  Sliders,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import type { ProviderSummary, RpcCommandInput } from "../client/useBotFactory";
import { BotThinkingOrb } from "../components/BotThinkingOrb";

export interface SettingsViewProps {
  open: boolean;
  onClose: () => void;
  config: HubConfig | null;
  projects: ProjectRecord[];
  activeProject: ProjectRecord | null;
  providers: ProviderSummary[];
  secretsPresence: Array<{ key: string; present: boolean; source: string }>;
  onRefresh: () => Promise<void>;
  onSaveSecret: (key: string, value: string) => Promise<void>;
  onDeleteSecret: (key: string) => Promise<void>;
  onTestProvider: (provider: string) => Promise<{ ok: boolean; detail: string }>;
  onSendCommand: <T = unknown>(cmd: RpcCommandInput) => Promise<T>;
}

type SettingsTab = "providers" | "secrets" | "routing" | "guardrails";

const STANDARD_INTENTS = [
  "meta_orchestrator",
  "project_manager",
  "coding_deep",
  "coding_parallel",
  "multimodal_review",
  "vision_fix",
  "sidekick",
  "memory_dreaming",
  "verifier_default",
];

const SECRET_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function SettingsView({
  open,
  onClose,
  config,
  projects,
  activeProject,
  providers,
  secretsPresence,
  onRefresh,
  onSaveSecret,
  onDeleteSecret,
  onTestProvider,
  onSendCommand,
}: SettingsViewProps): JSX.Element | null {
  const [tab, setTab] = useState<SettingsTab>("providers");
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Provider testing & config patching
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [newProvId, setNewProvId] = useState("");
  const [newProvRuntime, setNewProvRuntime] = useState<"native_http" | "acp_stdio" | "cli_stream">("native_http");
  const [newProvProtocol, setNewProvProtocol] = useState<"openai_compatible" | "google_gemini" | "anthropic">(
    "openai_compatible",
  );
  const [newProvAdapter, setNewProvAdapter] = useState<"claude" | "codex">("claude");
  const [newProvBaseUrl, setNewProvBaseUrl] = useState("https://api.openai.com/v1");
  const [newProvCommand, setNewProvCommand] = useState("");
  const [newProvApiKeyEnv, setNewProvApiKeyEnv] = useState("");
  const [newProvModelId, setNewProvModelId] = useState("");
  const [patchJson, setPatchJson] = useState("");

  // Write-only API keys
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [customSecretKey, setCustomSecretKey] = useState("");
  const [customSecretValue, setCustomSecretValue] = useState("");

  // Project routing & checks
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [draftOverrides, setDraftOverrides] = useState<Record<string, RouteTarget | null>>({});

  // Guardrails
  const [maxConcurrentBots, setMaxConcurrentBots] = useState(4);
  const [maxTaskAutoRetries, setMaxTaskAutoRetries] = useState(2);
  const [maxSubagentsPerBot, setMaxSubagentsPerBot] = useState(3);
  const [maxDebateRounds, setMaxDebateRounds] = useState(3);
  const [maxAnnotationRetries, setMaxAnnotationRetries] = useState(2);
  const [crossFamilyVerification, setCrossFamilyVerification] = useState(true);

  useEffect(() => {
    if (!open) return;
    setErrorMsg(null);
    setStatusMsg(null);
    void onRefresh().catch((err) => {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    });
  }, [open, onRefresh]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onClose]);

  useEffect(() => {
    if (!config) return;
    setMaxConcurrentBots(config.guardrails.maxConcurrentBotsPerProject);
    setMaxTaskAutoRetries(config.guardrails.maxTaskAutoRetries);
    setMaxSubagentsPerBot(config.guardrails.maxSubagentsPerBot);
    setMaxDebateRounds(config.guardrails.maxDebateRounds);
    setMaxAnnotationRetries(config.guardrails.maxAnnotationFixRetries);
    setCrossFamilyVerification(config.routing.crossFamilyVerification);
  }, [config]);

  useEffect(() => {
    const nextId = activeProject?.id ?? projects[0]?.id ?? "";
    setSelectedProjectId((prev) => (prev && projects.some((p) => p.id === prev) ? prev : nextId));
  }, [activeProject?.id, projects]);

  const targetProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? activeProject ?? projects[0] ?? null,
    [projects, selectedProjectId, activeProject],
  );

  useEffect(() => {
    setDraftOverrides({});
  }, [targetProject?.id]);

  const providerList = useMemo<Array<{ name: string; cfg: ProviderConfig | null; models: string[]; runtime: string }>>(
    () => {
      if (config) {
        return Object.entries(config.providers).map(([name, cfg]) => ({
          name,
          cfg,
          models: Object.keys(cfg.models),
          runtime: cfg.runtime,
        }));
      }
      return providers.map((p) => ({
        name: p.name,
        cfg: null,
        models: p.models,
        runtime: p.runtime,
      }));
    },
    [config, providers],
  );

  const allSecretEntries = useMemo(() => {
    const map = new Map<string, { key: string; present: boolean; source: string }>();
    for (const s of secretsPresence) {
      map.set(s.key, s);
    }
    if (config) {
      for (const p of Object.values(config.providers)) {
        if (p.apiKeyEnv && !map.has(p.apiKeyEnv)) {
          map.set(p.apiKeyEnv, { key: p.apiKeyEnv, present: false, source: "none" });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [secretsPresence, config]);

  const intentNames = useMemo(() => {
    const set = new Set(STANDARD_INTENTS);
    if (config) {
      for (const k of Object.keys(config.routing.defaultsByIntent)) set.add(k);
    }
    if (targetProject) {
      for (const k of Object.keys(targetProject.routingOverrides)) set.add(k);
    }
    return Array.from(set);
  }, [config, targetProject]);

  if (!open) return null;

  const runSafe = async (fn: () => Promise<void>, successNotice?: string) => {
    if (busy) return;
    setBusy(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await fn();
      if (successNotice) setStatusMsg(successNotice);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async (providerName: string) => {
    setTestingProvider(providerName);
    setErrorMsg(null);
    try {
      const res = await onTestProvider(providerName);
      setTestResults((prev) => ({ ...prev, [providerName]: res }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [providerName]: { ok: false, detail: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setTestingProvider(null);
    }
  };

  const handleAddProvider = async () => {
    const id = newProvId.trim();
    const modelId = newProvModelId.trim();
    if (!id || !modelId) {
      setErrorMsg("Provider ID and initial Model ID are required.");
      return;
    }
    const providerEntry: Record<string, unknown> = {
      runtime: newProvRuntime,
      models: {
        [modelId]: {
          id: modelId,
          capabilities: ["reasoning", "coding"],
          tier: "balanced",
        },
      },
    };
    if (newProvRuntime === "native_http") {
      providerEntry.protocol = newProvProtocol;
      providerEntry.baseUrl = newProvBaseUrl.trim();
      if (newProvApiKeyEnv.trim()) {
        providerEntry.apiKeyEnv = newProvApiKeyEnv.trim();
      }
    } else {
      providerEntry.command = newProvCommand.trim();
      if (newProvRuntime === "cli_stream") {
        providerEntry.adapter = newProvAdapter;
      }
    }
    await runSafe(async () => {
      await onSendCommand({
        type: "config.update",
        patchJson: JSON.stringify({ providers: { [id]: providerEntry } }),
      });
      await onRefresh();
      setShowAddProvider(false);
      setNewProvId("");
      setNewProvModelId("");
      setNewProvCommand("");
      setNewProvApiKeyEnv("");
    }, `Provider "${id}" saved and hot-reloaded.`);
  };

  const handleApplyPatch = async () => {
    const raw = patchJson.trim();
    if (!raw) return;
    await runSafe(async () => {
      JSON.parse(raw);
      await onSendCommand({ type: "config.update", patchJson: raw });
      await onRefresh();
      setPatchJson("");
    }, "Configuration patch applied and hot-reloaded.");
  };

  const handleSaveGuardrails = async () => {
    await runSafe(async () => {
      await onSendCommand({
        type: "config.update",
        patchJson: JSON.stringify({
          routing: { crossFamilyVerification },
          guardrails: {
            maxConcurrentBotsPerProject: Math.max(1, Math.trunc(maxConcurrentBots)),
            maxTaskAutoRetries: Math.max(0, Math.min(5, Math.trunc(maxTaskAutoRetries))),
            maxSubagentsPerBot: Math.max(1, Math.min(6, Math.trunc(maxSubagentsPerBot))),
            maxDebateRounds: Math.max(1, Math.min(10, Math.trunc(maxDebateRounds))),
            maxAnnotationFixRetries: Math.max(1, Math.min(5, Math.trunc(maxAnnotationRetries))),
          },
        }),
      });
      await onRefresh();
    }, "Guardrails and verification policy updated.");
  };

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!busy) onClose();
      }}
      role="presentation"
    >
      <div
        className="modal-card wide settings-modal"
        style={{ width: 820, maxWidth: "95vw", height: "86vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
      >
        <div
          className="modal-header settings-header"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: "var(--hairline)",
            background: "var(--bg-surface)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <Sliders size={16} strokeWidth={1.6} color="var(--ink-secondary)" />
            <div>
              <h2
                id="settings-modal-title"
                style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: 600, color: "var(--ink-primary)" }}
              >
                Studio Settings &amp; Open BYOS
              </h2>
              <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-muted)" }}>
                Providers, write-only secrets, project routing overrides, and safety guardrails
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              type="button"
              className="btn xs"
              disabled={busy}
              onClick={() => void runSafe(() => onRefresh(), "Configuration refreshed.")}
              title="Reload live config and secret presence"
            >
              <RefreshCw size={12} strokeWidth={1.6} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              className="btn xs ghost"
              onClick={onClose}
              disabled={busy}
              aria-label="Close settings"
            >
              <X size={14} strokeWidth={1.6} />
            </button>
          </div>
        </div>

        <div
          className="settings-tabs-bar"
          style={{
            padding: "9px 16px",
            borderBottom: "var(--hairline)",
            background: "var(--bg-canvas)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <div className="subview-tabs">
            <button
              type="button"
              className={`subview-tab ${tab === "providers" ? "active" : ""}`}
              onClick={() => setTab("providers")}
            >
              <Server size={12} strokeWidth={1.6} />
              <span>Providers ({providerList.length})</span>
            </button>
            <button
              type="button"
              className={`subview-tab ${tab === "secrets" ? "active" : ""}`}
              onClick={() => setTab("secrets")}
            >
              <KeyRound size={12} strokeWidth={1.6} />
              <span>API Keys ({allSecretEntries.filter((s) => s.present).length}/{allSecretEntries.length})</span>
            </button>
            <button
              type="button"
              className={`subview-tab ${tab === "routing" ? "active" : ""}`}
              onClick={() => setTab("routing")}
            >
              <Route size={12} strokeWidth={1.6} />
              <span>Project Routing &amp; Checks</span>
            </button>
            <button
              type="button"
              className={`subview-tab ${tab === "guardrails" ? "active" : ""}`}
              onClick={() => setTab("guardrails")}
            >
              <Shield size={12} strokeWidth={1.6} />
              <span>Guardrails</span>
            </button>
          </div>

          {config && (
            <span className="mono-tag">
              {config.hub.host}:{config.hub.port} · {config.routing.policy}
            </span>
          )}
        </div>

        <div
          className="modal-body settings-body"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {errorMsg && (
            <div className="inline-error" role="alert">
              <span>{errorMsg}</span>
              <button type="button" className="btn xs ghost" onClick={() => setErrorMsg(null)}>
                Dismiss
              </button>
            </div>
          )}

          {statusMsg && (
            <div
              className="pill success"
              style={{ padding: "7px 11px", borderRadius: "var(--radius-sm)", justifyContent: "space-between" }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <CheckCircle2 size={13} strokeWidth={1.6} />
                <span>{statusMsg}</span>
              </span>
            </div>
          )}

          {tab === "providers" && (
            <div className="settings-section" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div className="section-eyebrow" style={{ padding: 0 }}>
                  Configured BYOS Runtimes &amp; Models
                </div>
                <button
                  type="button"
                  className="btn xs primary"
                  disabled={busy}
                  onClick={() => setShowAddProvider((v) => !v)}
                >
                  <Plus size={12} strokeWidth={1.6} />
                  <span>{showAddProvider ? "Hide Form" : "Add / Update Provider"}</span>
                </button>
              </div>

              {showAddProvider && (
                <div className="task-card" style={{ background: "var(--bg-surface)", gap: 10 }}>
                  <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--ink-primary)" }}>
                    Add or Patch Provider (`config.update`)
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    <input
                      className="field-input"
                      placeholder="Provider ID (e.g. openai-custom)"
                      value={newProvId}
                      disabled={busy}
                      onChange={(e) => setNewProvId(e.target.value)}
                    />
                    <select
                      className="field-input"
                      value={newProvRuntime}
                      disabled={busy}
                      onChange={(e) =>
                        setNewProvRuntime(e.target.value as "native_http" | "acp_stdio" | "cli_stream")
                      }
                    >
                      <option value="native_http">native_http</option>
                      <option value="acp_stdio">acp_stdio</option>
                      <option value="cli_stream">cli_stream</option>
                    </select>
                    <input
                      className="field-input"
                      placeholder="Initial Model ID (e.g. gpt-5)"
                      value={newProvModelId}
                      disabled={busy}
                      onChange={(e) => setNewProvModelId(e.target.value)}
                    />
                  </div>

                  {newProvRuntime === "native_http" ? (
                    <div style={{ display: "grid", gridTemplateColumns: "0.9fr 1.3fr 0.8fr", gap: 8 }}>
                      <select
                        className="field-input"
                        value={newProvProtocol}
                        disabled={busy}
                        onChange={(e) =>
                          setNewProvProtocol(
                            e.target.value as "openai_compatible" | "google_gemini" | "anthropic",
                          )
                        }
                      >
                        <option value="openai_compatible">openai_compatible</option>
                        <option value="google_gemini">google_gemini</option>
                        <option value="anthropic">anthropic</option>
                      </select>
                      <input
                        className="field-input"
                        placeholder="https://api.example.com/v1"
                        value={newProvBaseUrl}
                        disabled={busy}
                        onChange={(e) => setNewProvBaseUrl(e.target.value)}
                      />
                      <input
                        className="field-input"
                        style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
                        placeholder="ENV key name (optional)"
                        value={newProvApiKeyEnv}
                        disabled={busy}
                        onChange={(e) => setNewProvApiKeyEnv(e.target.value.toUpperCase())}
                      />
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <input
                        className="field-input"
                        placeholder="CLI executable (e.g. claude or devin)"
                        value={newProvCommand}
                        disabled={busy}
                        onChange={(e) => setNewProvCommand(e.target.value)}
                      />
                      {newProvRuntime === "cli_stream" && (
                        <select
                          className="field-input"
                          value={newProvAdapter}
                          disabled={busy}
                          onChange={(e) => setNewProvAdapter(e.target.value as "claude" | "codex")}
                        >
                          <option value="claude">claude</option>
                          <option value="codex">codex</option>
                        </select>
                      )}
                    </div>
                  )}

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                    <button type="button" className="btn xs" onClick={() => setShowAddProvider(false)} disabled={busy}>
                      Cancel
                    </button>
                    <button type="button" className="btn xs primary" onClick={() => void handleAddProvider()} disabled={busy}>
                      Save Provider
                    </button>
                  </div>
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {providerList.map((prov) => {
                  const secretStatus = prov.cfg?.apiKeyEnv
                    ? allSecretEntries.find((s) => s.key === prov.cfg?.apiKeyEnv)
                    : null;
                  const testResult = testResults[prov.name];
                  const isTesting = testingProvider === prov.name;
                  return (
                    <div key={prov.name} className="task-card" style={{ gap: 7 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          <Cpu size={14} strokeWidth={1.6} color="var(--ink-secondary)" />
                          <span style={{ fontWeight: 600, fontSize: "var(--text-sm)", color: "var(--ink-primary)" }}>
                            {prov.name}
                          </span>
                          <span className="mono-tag">{prov.runtime}</span>
                          {prov.cfg?.protocol && <span className="mono-tag">{prov.cfg.protocol}</span>}
                          {prov.cfg?.adapter && <span className="mono-tag">{prov.cfg.adapter}</span>}
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          {prov.cfg?.apiKeyEnv && (
                            <span className={`pill ${secretStatus?.present ? "success" : "warning"}`}>
                              {prov.cfg.apiKeyEnv}: {secretStatus?.present ? "Configured" : "Missing"}
                            </span>
                          )}
                          <button
                            type="button"
                            className="btn xs"
                            disabled={isTesting}
                            onClick={() => void handleTest(prov.name)}
                          >
                            {isTesting ? (
                              <>
                                <BotThinkingOrb activity="connecting" size={20} shell={false} />
                                <span>Testing…</span>
                              </>
                            ) : (
                              <span>Test Connection</span>
                            )}
                          </button>
                        </div>
                      </div>

                      <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)", fontFamily: "var(--font-mono)" }}>
                        {prov.cfg?.baseUrl ??
                          (prov.cfg?.command ? `${prov.cfg.command} ${(prov.cfg.args ?? []).join(" ")}` : "Configured")}
                      </div>

                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {prov.models.map((m) => (
                          <span key={m} className="mono-tag">
                            {m}
                          </span>
                        ))}
                      </div>

                      {testResult && (
                        <div
                          className={`pill ${testResult.ok ? "success" : "danger"}`}
                          style={{
                            borderRadius: "var(--radius-sm)",
                            padding: "5px 9px",
                            whiteSpace: "normal",
                            lineHeight: 1.4,
                          }}
                        >
                          {testResult.ok ? "OK" : "Failed"} · {testResult.detail}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="task-card" style={{ gap: 8 }}>
                <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--ink-primary)" }}>
                  Advanced Config JSON Patch (<code>config.update</code>)
                </div>
                <textarea
                  className="field-textarea mono"
                  rows={4}
                  placeholder='{"routing":{"policy":"task_adaptive"}}'
                  value={patchJson}
                  disabled={busy}
                  onChange={(e) => setPatchJson(e.target.value)}
                />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-muted)" }}>
                    Plaintext secrets and immutable <code>hub.*</code> paths are rejected by the daemon.
                  </span>
                  <button
                    type="button"
                    className="btn xs primary"
                    disabled={busy || !patchJson.trim()}
                    onClick={() => void handleApplyPatch()}
                  >
                    Apply Config Patch
                  </button>
                </div>
              </div>
            </div>
          )}

          {tab === "secrets" && (
            <div className="settings-section" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div
                style={{
                  padding: "9px 11px",
                  borderRadius: "var(--radius-md)",
                  border: "var(--hairline)",
                  background: "var(--bg-surface)",
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-secondary)",
                  lineHeight: 1.45,
                }}
              >
                API keys are <b>write-only</b>. Existing secret values stored in <code>secrets.env</code> or
                environment variables are never transmitted back to the browser.
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {allSecretEntries.map((entry) => {
                  const draft = secretInputs[entry.key] ?? "";
                  return (
                    <div key={entry.key} className="task-card" style={{ gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", fontWeight: 600 }}>
                            {entry.key}
                          </span>
                          <span className={`pill ${entry.present ? "success" : "warning"}`}>
                            {entry.present ? "Configured" : "Missing"}
                          </span>
                          {entry.present && entry.source !== "none" && (
                            <span className="mono-tag">{entry.source}</span>
                          )}
                        </div>
                        {entry.present && (
                          <button
                            type="button"
                            className="btn xs danger"
                            disabled={busy}
                            onClick={() =>
                              void runSafe(async () => {
                                await onDeleteSecret(entry.key);
                                await onRefresh();
                              }, `Removed ${entry.key} from secrets.env.`)
                            }
                          >
                            <Trash2 size={11} strokeWidth={1.6} />
                            <span>Delete</span>
                          </button>
                        )}
                      </div>

                      <div style={{ display: "flex", gap: 6 }}>
                        <input
                          type="password"
                          autoComplete="new-password"
                          className="field-input"
                          placeholder={`Enter new value for ${entry.key} (write-only)`}
                          value={draft}
                          disabled={busy}
                          onChange={(e) => setSecretInputs((prev) => ({ ...prev, [entry.key]: e.target.value }))}
                        />
                        <button
                          type="button"
                          className="btn sm primary"
                          disabled={busy || !draft.trim()}
                          onClick={() =>
                            void runSafe(async () => {
                              await onSaveSecret(entry.key, draft.trim());
                              setSecretInputs((prev) => ({ ...prev, [entry.key]: "" }));
                              await onRefresh();
                            }, `Saved ${entry.key}.`)
                          }
                        >
                          Save Key
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="task-card" style={{ gap: 8 }}>
                <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--ink-primary)" }}>
                  Add Custom Secret Key
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "0.9fr 1.4fr auto", gap: 6 }}>
                  <input
                    className="field-input"
                    style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
                    placeholder="CUSTOM_API_KEY"
                    value={customSecretKey}
                    disabled={busy}
                    onChange={(e) => setCustomSecretKey(e.target.value.toUpperCase())}
                  />
                  <input
                    type="password"
                    autoComplete="new-password"
                    className="field-input"
                    placeholder="Secret value (write-only)"
                    value={customSecretValue}
                    disabled={busy}
                    onChange={(e) => setCustomSecretValue(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn sm primary"
                    disabled={
                      busy || !SECRET_KEY_RE.test(customSecretKey.trim()) || !customSecretValue.trim()
                    }
                    onClick={() =>
                      void runSafe(async () => {
                        const k = customSecretKey.trim();
                        await onSaveSecret(k, customSecretValue.trim());
                        setCustomSecretKey("");
                        setCustomSecretValue("");
                        await onRefresh();
                      }, "Secret key saved.")
                    }
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          )}

          {tab === "routing" && (
            <div className="settings-section" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {projects.length === 0 ? (
                <div className="task-card" style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)" }}>
                  Create a project first to configure per-project routing overrides and inspect verification checks.
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--ink-secondary)" }}>
                        Project:
                      </span>
                      <select
                        className="field-input"
                        style={{ width: 240 }}
                        value={targetProject?.id ?? ""}
                        onChange={(e) => setSelectedProjectId(e.target.value)}
                      >
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.slug})
                          </option>
                        ))}
                      </select>
                    </label>

                    {targetProject && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className="mono-tag">status: {targetProject.status}</span>
                        {targetProject.status !== "archived" ? (
                          <button
                            type="button"
                            className="btn xs"
                            disabled={busy}
                            onClick={() =>
                              void runSafe(async () => {
                                await onSendCommand({
                                  type: "project.archive",
                                  projectId: targetProject.id,
                                  status: "archived",
                                });
                              }, `Archived project "${targetProject.name}".`)
                            }
                          >
                            Archive Project
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn xs"
                            disabled={busy}
                            onClick={() =>
                              void runSafe(async () => {
                                await onSendCommand({
                                  type: "project.archive",
                                  projectId: targetProject.id,
                                  status: "active",
                                });
                              }, `Reactivated project "${targetProject.name}".`)
                            }
                          >
                            Restore Active
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {targetProject && (
                    <>
                      <div className="section-eyebrow" style={{ padding: 0 }}>
                        Per-Intent Routing Overrides (<code>routing.set_override</code>)
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {intentNames.map((intent) => {
                          const defaultTarget = config?.routing.defaultsByIntent[intent];
                          const savedOverride = targetProject.routingOverrides[intent] ?? null;
                          const draft = intent in draftOverrides ? draftOverrides[intent] : savedOverride;
                          const selectedProv = draft?.provider ?? defaultTarget?.provider ?? providerList[0]?.name ?? "";
                          const provModels =
                            providerList.find((p) => p.name === selectedProv)?.models ?? [];
                          const selectedModel =
                            draft?.model && provModels.includes(draft.model)
                              ? draft.model
                              : provModels[0] ?? defaultTarget?.model ?? "";

                          return (
                            <div
                              key={intent}
                              className="task-card"
                              style={{
                                display: "grid",
                                gridTemplateColumns: "1.1fr 1fr 1fr auto",
                                alignItems: "center",
                                gap: 8,
                              }}
                            >
                              <div style={{ minWidth: 0 }}>
                                <div
                                  style={{
                                    fontFamily: "var(--font-mono)",
                                    fontSize: "var(--text-xs)",
                                    fontWeight: 600,
                                    color: "var(--ink-primary)",
                                  }}
                                >
                                  {intent}
                                </div>
                                <div style={{ fontSize: "11px", color: "var(--ink-muted)" }}>
                                  Default:{" "}
                                  {defaultTarget ? `${defaultTarget.provider}/${defaultTarget.model}` : "auto"}
                                </div>
                              </div>

                              <select
                                className="field-input"
                                value={selectedProv}
                                disabled={busy}
                                onChange={(e) => {
                                  const nextProv = e.target.value;
                                  const nextModels =
                                    providerList.find((p) => p.name === nextProv)?.models ?? [];
                                  setDraftOverrides((prev) => ({
                                    ...prev,
                                    [intent]: { provider: nextProv, model: nextModels[0] ?? "" },
                                  }));
                                }}
                              >
                                {providerList.map((p) => (
                                  <option key={p.name} value={p.name}>
                                    {p.name}
                                  </option>
                                ))}
                              </select>

                              <select
                                className="field-input"
                                value={selectedModel}
                                disabled={busy || provModels.length === 0}
                                onChange={(e) => {
                                  setDraftOverrides((prev) => ({
                                    ...prev,
                                    [intent]: { provider: selectedProv, model: e.target.value },
                                  }));
                                }}
                              >
                                {provModels.map((m) => (
                                  <option key={m} value={m}>
                                    {m}
                                  </option>
                                ))}
                              </select>

                              <div style={{ display: "flex", gap: 4 }}>
                                <button
                                  type="button"
                                  className="btn xs primary"
                                  disabled={busy || !selectedProv || !selectedModel}
                                  onClick={() =>
                                    void runSafe(async () => {
                                      await onSendCommand({
                                        type: "routing.set_override",
                                        projectId: targetProject.id,
                                        intent,
                                        target: { provider: selectedProv, model: selectedModel },
                                      });
                                    }, `Updated routing override for "${intent}".`)
                                  }
                                >
                                  Set
                                </button>
                                {savedOverride && (
                                  <button
                                    type="button"
                                    className="btn xs"
                                    disabled={busy}
                                    onClick={() =>
                                      void runSafe(async () => {
                                        await onSendCommand({
                                          type: "routing.set_override",
                                          projectId: targetProject.id,
                                          intent,
                                          target: null,
                                        });
                                        setDraftOverrides((prev) => ({ ...prev, [intent]: null }));
                                      }, `Cleared routing override for "${intent}".`)
                                    }
                                  >
                                    Clear
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div className="section-eyebrow" style={{ padding: "4px 0 0" }}>
                        Project Verification Checks
                      </div>
                      <div className="task-card" style={{ gap: 6 }}>
                        {(targetProject.verifyChecks ?? []).length === 0 ? (
                          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)" }}>
                            No static verification commands registered on this project. Project verification checks
                            are configured at project creation or passed ad-hoc when running task verification.
                          </div>
                        ) : (
                          (targetProject.verifyChecks ?? []).map((vc, idx) => (
                            <div
                              key={`${vc.name}-${idx}`}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: 8,
                                padding: "5px 8px",
                                borderRadius: "var(--radius-sm)",
                                background: "var(--bg-surface)",
                                border: "var(--hairline)",
                              }}
                            >
                              <span style={{ fontSize: "var(--text-xs)", fontWeight: 600 }}>{vc.name}</span>
                              <code style={{ fontSize: "var(--text-xs)", color: "var(--ink-secondary)" }}>{vc.cmd}</code>
                              {vc.timeoutMs && (
                                <span className="mono-tag">{Math.round(vc.timeoutMs / 1000)}s</span>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {tab === "guardrails" && (
            <div className="settings-section" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="task-card" style={{ gap: 12 }}>
                <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--ink-primary)" }}>
                  Execution &amp; Autonomy Guardrails
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-secondary)" }}>
                      Max Concurrent Bots / Project
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={16}
                      className="field-input"
                      value={maxConcurrentBots}
                      disabled={busy}
                      onChange={(e) => setMaxConcurrentBots(Number(e.target.value) || 1)}
                    />
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-secondary)" }}>
                      Max Task Auto-Retries (0–5)
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={5}
                      className="field-input"
                      value={maxTaskAutoRetries}
                      disabled={busy}
                      onChange={(e) => setMaxTaskAutoRetries(Number(e.target.value) || 0)}
                    />
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-secondary)" }}>
                      Max Subagents / Bot (1–6)
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={6}
                      className="field-input"
                      value={maxSubagentsPerBot}
                      disabled={busy}
                      onChange={(e) => setMaxSubagentsPerBot(Number(e.target.value) || 1)}
                    />
                  </label>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-secondary)" }}>
                      Max Debate Rounds (1–10)
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      className="field-input"
                      value={maxDebateRounds}
                      disabled={busy}
                      onChange={(e) => setMaxDebateRounds(Number(e.target.value) || 1)}
                    />
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-secondary)" }}>
                      Max Annotation Fix Retries (1–5)
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={5}
                      className="field-input"
                      value={maxAnnotationRetries}
                      disabled={busy}
                      onChange={(e) => setMaxAnnotationRetries(Number(e.target.value) || 1)}
                    />
                  </label>
                </div>

                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--bg-surface)",
                    border: "var(--hairline)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={crossFamilyVerification}
                    disabled={busy}
                    onChange={(e) => setCrossFamilyVerification(e.target.checked)}
                    style={{ accentColor: "var(--accent-orange)" }}
                  />
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-primary)" }}>
                    Enforce cross-family independent verification (exclude task author provider)
                  </span>
                </label>

                {config && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <span className="mono-tag">
                      worktreeBoundary: {String(config.guardrails.acpWorktreeBoundaryEnforced)}
                    </span>
                    <span className="mono-tag">
                      secretRedaction: {String(config.guardrails.redactSecretsInLogsAndMemory)}
                    </span>
                    <span className="mono-tag">
                      selfModStaging: {String(config.guardrails.selfModRequiresStagingAndVerifier)}
                    </span>
                    <span className="mono-tag">
                      compactThreshold: {config.guardrails.autoCompactThresholdTokens.toLocaleString()} tok
                    </span>
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    className="btn sm primary"
                    disabled={busy || !config}
                    onClick={() => void handleSaveGuardrails()}
                  >
                    Save Guardrails
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
