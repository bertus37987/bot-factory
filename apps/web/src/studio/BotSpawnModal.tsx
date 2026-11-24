import type { ProjectRecord } from "@bot-factory/shared";
import { Cpu, ShieldCheck, Users, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type JSX } from "react";
import type { ProviderSummary } from "../client/useBotFactory";
import { BotAvatar, resolveBotRole } from "../components/BotAvatars";
import { BotThinkingOrb } from "../components/BotThinkingOrb";
import type { AutonomyLevel } from "../components/PrecisionComposer";
import type { ReasoningEffort } from "../components/ReasoningEffortSlider";

export interface BotSpawnModalProps {
  open: boolean;
  project: ProjectRecord | null;
  providers: ProviderSummary[];
  onClose: () => void;
  onSubmit: (input: {
    projectId: string;
    name: string;
    scope: "peer" | "project" | "verifier";
    provider?: string;
    model?: string;
    autonomyLevel: AutonomyLevel;
    reasoningEffort: ReasoningEffort;
  }) => Promise<void>;
}

const SCOPE_OPTIONS: Array<{
  value: "peer" | "project" | "verifier";
  label: string;
  desc: string;
}> = [
  {
    value: "peer",
    label: "Specialist Peer",
    desc: "Isolated Git worktree for parallel coding, 3D, or research execution.",
  },
  {
    value: "verifier",
    label: "Verifier",
    desc: "Independent cross-family session for fresh verification runs.",
  },
  {
    value: "project",
    label: "Team Lead (PM)",
    desc: "Project orchestrator owning plans, task DAG, and escalations.",
  },
];

const AUTONOMY_CHOICES: Array<{ value: AutonomyLevel; label: string; desc: string }> = [
  { value: "spec", label: "Spec", desc: "Plan only" },
  { value: "low", label: "Low", desc: "Confirm tools" },
  { value: "medium", label: "Medium", desc: "Scoped edits" },
  { value: "high", label: "High", desc: "Autonomous" },
];

const EFFORT_CHOICES: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

const ROLE_PRESETS: Array<{ label: string; suggestedName: string; scope: "peer" | "verifier" }> = [
  { label: "Forge · Builder", suggestedName: "Forge", scope: "peer" },
  { label: "Carver · 3D Artist", suggestedName: "Carver-3D", scope: "peer" },
  { label: "Scout · Research", suggestedName: "Scout-Research", scope: "peer" },
  { label: "Inspector · Verifier", suggestedName: "Inspector", scope: "verifier" },
];

export function BotSpawnModal({
  open,
  project,
  providers,
  onClose,
  onSubmit,
}: BotSpawnModalProps): JSX.Element | null {
  const [name, setName] = useState("Forge-1");
  const [scope, setScope] = useState<"peer" | "project" | "verifier">("peer");
  const [provider, setProvider] = useState<string>("__auto__");
  const [model, setModel] = useState<string>("");
  const [autonomyLevel, setAutonomyLevel] = useState<AutonomyLevel>("medium");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("high");
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("Forge-1");
    setScope("peer");
    setProvider("__auto__");
    setModel("");
    setAutonomyLevel("medium");
    setReasoningEffort("high");
    setErrorMsg(null);
    setBusy(false);
  }, [open, project?.id]);

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

  const selectedProviderEntry = useMemo(
    () => (provider !== "__auto__" ? providers.find((p) => p.name === provider) ?? null : null),
    [providers, provider],
  );

  const previewMeta = useMemo(
    () => resolveBotRole({ scope, name: name.trim() || "Bot", model: model || "default" }),
    [scope, name, model],
  );

  if (!open) return null;

  const handleProviderChange = (nextProvider: string) => {
    setProvider(nextProvider);
    if (nextProvider === "__auto__") {
      setModel("");
      return;
    }
    const found = providers.find((p) => p.name === nextProvider);
    setModel(found?.models[0] ?? "");
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!project) {
      setErrorMsg("Select or create a project first.");
      return;
    }
    const cleanName = name.trim();
    if (!cleanName) {
      setErrorMsg("Bot name is required.");
      return;
    }

    setBusy(true);
    setErrorMsg(null);
    try {
      await onSubmit({
        projectId: project.id,
        name: cleanName,
        scope,
        provider: provider !== "__auto__" ? provider : undefined,
        model: provider !== "__auto__" && model ? model : undefined,
        autonomyLevel,
        reasoningEffort,
      });
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
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
        className="modal-card"
        style={{ width: 540, maxWidth: "94vw", maxHeight: "88vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bot-spawn-modal-title"
      >
        <div
          className="modal-header"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "13px 16px",
            borderBottom: "var(--hairline)",
            background: "var(--bg-surface)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <BotAvatar role={previewMeta.role} size={26} />
            <div>
              <h2
                id="bot-spawn-modal-title"
                style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: 600, color: "var(--ink-primary)" }}
              >
                Spawn Project Bot
              </h2>
              <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-muted)" }}>
                {project ? `${project.name} · ${previewMeta.jobTitle}` : "No active project"}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="btn xs ghost"
            onClick={onClose}
            disabled={busy}
            aria-label="Close modal"
          >
            <X size={14} strokeWidth={1.6} />
          </button>
        </div>

        {!project ? (
          <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-secondary)" }}>
              Create or select a project before spawning a bot.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" className="btn sm" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => void handleSubmit(e)}
            style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}
          >
            <div
              className="modal-body"
              style={{
                padding: 16,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              {errorMsg && (
                <div className="inline-error" role="alert">
                  <span>{errorMsg}</span>
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--ink-secondary)" }}>
                  Role Presets
                </span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {ROLE_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className="btn xs"
                      disabled={busy}
                      onClick={() => {
                        setName(preset.suggestedName);
                        setScope(preset.scope);
                      }}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--ink-secondary)" }}>
                  Bot Name
                </span>
                <input
                  autoFocus
                  className="field-input"
                  placeholder="e.g. Forge-2"
                  value={name}
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--ink-secondary)" }}>
                  Scope
                </span>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                  {SCOPE_OPTIONS.map((opt) => {
                    const active = scope === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={busy}
                        onClick={() => setScope(opt.value)}
                        style={{
                          textAlign: "left",
                          padding: "9px 10px",
                          borderRadius: "var(--radius-md)",
                          border: active ? "1px solid var(--accent-orange)" : "var(--hairline)",
                          background: active ? "var(--accent-orange-soft)" : "var(--bg-surface)",
                          cursor: busy ? "not-allowed" : "pointer",
                          display: "flex",
                          flexDirection: "column",
                          gap: 3,
                        }}
                      >
                        <span
                          style={{
                            fontSize: "var(--text-xs)",
                            fontWeight: 600,
                            color: active ? "var(--accent-orange-ink)" : "var(--ink-primary)",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                          }}
                        >
                          {opt.value === "verifier" ? (
                            <ShieldCheck size={12} strokeWidth={1.6} />
                          ) : (
                            <Users size={12} strokeWidth={1.6} />
                          )}
                          {opt.label}
                        </span>
                        <span style={{ fontSize: "11px", color: "var(--ink-muted)", lineHeight: 1.35 }}>
                          {opt.desc}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span
                    style={{
                      fontSize: "var(--text-xs)",
                      fontWeight: 500,
                      color: "var(--ink-secondary)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    <Cpu size={12} strokeWidth={1.6} />
                    Provider
                  </span>
                  <select
                    className="field-input"
                    value={provider}
                    disabled={busy}
                    onChange={(e) => handleProviderChange(e.target.value)}
                  >
                    <option value="__auto__">Auto-route by scope &amp; intent</option>
                    {providers.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name} ({p.runtime})
                      </option>
                    ))}
                  </select>
                </label>

                <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--ink-secondary)" }}>
                    Model
                  </span>
                  <select
                    className="field-input"
                    value={model}
                    disabled={busy || !selectedProviderEntry}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {!selectedProviderEntry ? (
                      <option value="">Project / Router default</option>
                    ) : (
                      selectedProviderEntry.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--ink-secondary)" }}>
                    Autonomy Level
                  </span>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
                    {AUTONOMY_CHOICES.map((a) => {
                      const active = autonomyLevel === a.value;
                      return (
                        <button
                          key={a.value}
                          type="button"
                          disabled={busy}
                          onClick={() => setAutonomyLevel(a.value)}
                          style={{
                            padding: "6px 8px",
                            borderRadius: "var(--radius-sm)",
                            border: active ? "1px solid var(--ink-primary)" : "var(--hairline)",
                            background: active ? "var(--bg-canvas)" : "var(--bg-surface)",
                            textAlign: "left",
                            cursor: busy ? "not-allowed" : "pointer",
                          }}
                        >
                          <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--ink-primary)" }}>
                            {a.label}
                          </div>
                          <div style={{ fontSize: "10.5px", color: "var(--ink-muted)" }}>{a.desc}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--ink-secondary)" }}>
                    Reasoning Effort
                  </span>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
                    {EFFORT_CHOICES.map((ef) => {
                      const active = reasoningEffort === ef.value;
                      return (
                        <button
                          key={ef.value}
                          type="button"
                          disabled={busy}
                          onClick={() => setReasoningEffort(ef.value)}
                          style={{
                            padding: "8px 9px",
                            borderRadius: "var(--radius-sm)",
                            border: active ? "1px solid var(--accent-orange)" : "var(--hairline)",
                            background: active ? "var(--accent-orange-soft)" : "var(--bg-surface)",
                            color: active ? "var(--accent-orange-ink)" : "var(--ink-primary)",
                            fontSize: "var(--text-xs)",
                            fontWeight: 600,
                            textAlign: "left",
                            cursor: busy ? "not-allowed" : "pointer",
                          }}
                        >
                          {ef.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div
              className="modal-footer"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: 8,
                padding: "11px 16px",
                borderTop: "var(--hairline)",
                background: "var(--bg-surface)",
              }}
            >
              <button type="button" className="btn sm" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn sm primary" disabled={busy || !name.trim()}>
                {busy ? (
                  <>
                    <BotThinkingOrb activity="working" size={20} shell={false} />
                    <span>Spawning…</span>
                  </>
                ) : (
                  <span>Spawn Bot</span>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
