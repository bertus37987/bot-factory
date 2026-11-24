import { slugify, type VerifyCheck } from "@bot-factory/shared";
import { FolderGit2, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState, type FormEvent, type JSX } from "react";
import { BotThinkingOrb } from "../components/BotThinkingOrb";

export interface ProjectModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    slug?: string;
    externalRepoPath?: string;
    seedDemoArtifacts: boolean;
    verifyChecks: VerifyCheck[];
  }) => Promise<void>;
}

interface DraftCheck {
  id: string;
  name: string;
  cmd: string;
  timeoutSeconds: string;
}

function emptyCheck(): DraftCheck {
  return {
    id: `chk_${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    cmd: "",
    timeoutSeconds: "",
  };
}

export function ProjectModal({ open, onClose, onSubmit }: ProjectModalProps): JSX.Element | null {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [externalRepoPath, setExternalRepoPath] = useState("");
  const [seedDemoArtifacts, setSeedDemoArtifacts] = useState(true);
  const [checks, setChecks] = useState<DraftCheck[]>([]);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setSlug("");
    setExternalRepoPath("");
    setSeedDemoArtifacts(true);
    setChecks([]);
    setErrorMsg(null);
    setBusy(false);
  }, [open]);

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

  if (!open) return null;

  const autoSlug = name.trim() ? slugify(name.trim()) : "my-project";

  const addCheck = () => {
    setChecks((prev) => [...prev, emptyCheck()]);
  };

  const updateCheck = (id: string, patch: Partial<DraftCheck>) => {
    setChecks((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const removeCheck = (id: string) => {
    setChecks((prev) => prev.filter((c) => c.id !== id));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;

    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMsg("Project name is required.");
      return;
    }

    const parsedChecks: VerifyCheck[] = [];
    for (const c of checks) {
      const cName = c.name.trim();
      const cCmd = c.cmd.trim();
      if (!cName && !cCmd) continue;
      if (!cName || !cCmd) {
        setErrorMsg("Each verification check requires both a name and a shell command.");
        return;
      }
      let timeoutMs: number | undefined;
      if (c.timeoutSeconds.trim()) {
        const sec = Number(c.timeoutSeconds.trim());
        if (!Number.isFinite(sec) || sec <= 0) {
          setErrorMsg(`Invalid timeout for check "${cName}". Enter seconds > 0.`);
          return;
        }
        timeoutMs = Math.round(sec * 1000);
      }
      parsedChecks.push({ name: cName, cmd: cCmd, ...(timeoutMs ? { timeoutMs } : {}) });
    }

    setBusy(true);
    setErrorMsg(null);
    try {
      await onSubmit({
        name: trimmedName,
        slug: slug.trim() ? slug.trim() : undefined,
        externalRepoPath: externalRepoPath.trim() ? externalRepoPath.trim() : undefined,
        seedDemoArtifacts,
        verifyChecks: parsedChecks,
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
        aria-labelledby="project-modal-title"
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
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <FolderGit2 size={16} strokeWidth={1.6} color="var(--ink-secondary)" />
            <h2
              id="project-modal-title"
              style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: 600, color: "var(--ink-primary)" }}
            >
              Create Project Workspace
            </h2>
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

        <form
          onSubmit={(e) => void handleSubmit(e)}
          style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}
        >
          <div
            className="modal-body"
            style={{
              padding: "16px",
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

            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 10 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--ink-secondary)" }}>
                  Project Name
                </span>
                <input
                  autoFocus
                  className="field-input"
                  placeholder="e.g. Payments API"
                  value={name}
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--ink-secondary)" }}>
                  Slug <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}>(optional)</span>
                </span>
                <input
                  className="field-input"
                  style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
                  placeholder={autoSlug}
                  value={slug}
                  disabled={busy}
                  onChange={(e) => setSlug(e.target.value)}
                />
              </label>
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--ink-secondary)" }}>
                Attach Local Git Repository{" "}
                <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}>(optional path on disk)</span>
              </span>
              <input
                className="field-input"
                style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
                placeholder="C:\Users\name\repos\existing-repo (leave blank to initialize a new repo)"
                value={externalRepoPath}
                disabled={busy}
                onChange={(e) => setExternalRepoPath(e.target.value)}
              />
              <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-muted)", lineHeight: 1.45 }}>
                Bot-Factory creates an isolated workspace for plans, handoffs, and preview artifacts, plus Git
                worktrees for peer bots.
              </span>
            </label>

            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 9,
                padding: "10px 11px",
                borderRadius: "var(--radius-md)",
                border: "var(--hairline)",
                background: "var(--bg-surface)",
                cursor: busy ? "not-allowed" : "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={seedDemoArtifacts}
                disabled={busy}
                onChange={(e) => setSeedDemoArtifacts(e.target.checked)}
                style={{ marginTop: 2, accentColor: "var(--accent-orange)" }}
              />
              <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--ink-primary)" }}>
                  Seed starter preview artifacts
                </span>
                <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-muted)", lineHeight: 1.4 }}>
                  Populates initial roadmap document, preview diagram, and 3D specimen for immediate annotation.
                </span>
              </span>
            </label>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div>
                  <div style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--ink-secondary)" }}>
                    Automated Verification Checks{" "}
                    <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}>(optional)</span>
                  </div>
                  <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-muted)" }}>
                    Run by the independent verifier inside task worktrees before marking verified.
                  </div>
                </div>
                <button type="button" className="btn xs" onClick={addCheck} disabled={busy}>
                  <Plus size={12} strokeWidth={1.6} />
                  <span>Add Check</span>
                </button>
              </div>

              {checks.length === 0 && (
                <div
                  style={{
                    padding: "9px 11px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px dashed var(--border-strong)",
                    fontSize: "var(--text-2xs)",
                    color: "var(--ink-muted)",
                  }}
                >
                  No verification commands configured yet. You can add checks such as{" "}
                  <code>bun run typecheck</code> or <code>bun test</code> here or later in Settings.
                </div>
              )}

              {checks.map((chk) => (
                <div
                  key={chk.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "0.9fr 1.4fr 76px auto",
                    gap: 6,
                    alignItems: "center",
                    padding: "7px 8px",
                    borderRadius: "var(--radius-sm)",
                    border: "var(--hairline)",
                    background: "var(--bg-surface)",
                  }}
                >
                  <input
                    className="field-input"
                    placeholder="Name (e.g. Tests)"
                    value={chk.name}
                    disabled={busy}
                    onChange={(e) => updateCheck(chk.id, { name: e.target.value })}
                  />
                  <input
                    className="field-input"
                    style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
                    placeholder="bun test"
                    value={chk.cmd}
                    disabled={busy}
                    onChange={(e) => updateCheck(chk.id, { cmd: e.target.value })}
                  />
                  <input
                    className="field-input"
                    style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
                    placeholder="60s"
                    title="Optional timeout in seconds"
                    value={chk.timeoutSeconds}
                    disabled={busy}
                    onChange={(e) => updateCheck(chk.id, { timeoutSeconds: e.target.value })}
                  />
                  <button
                    type="button"
                    className="btn xs ghost"
                    disabled={busy}
                    onClick={() => removeCheck(chk.id)}
                    aria-label="Remove verification check"
                  >
                    <Trash2 size={12} strokeWidth={1.6} />
                  </button>
                </div>
              ))}
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
                  <span>Creating…</span>
                </>
              ) : (
                <span>Create Project</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
