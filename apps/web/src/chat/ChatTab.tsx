import { ArrowUpRight, FolderPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { GitDiffResponse, ProjectRecord, QuietStatusProjection, TimelineItem } from "@bot-factory/shared";
import type { ArtifactCardEvent } from "../client/useBotFactory";
import { BotAvatar } from "../components/BotAvatars";
import { BrowserPaneIcon, DocTabIcon } from "../components/BotFactoryIcons";
import { BotThinkingOrb } from "../components/BotThinkingOrb";
import { PrecisionComposer, type AutonomyLevel } from "../components/PrecisionComposer";
import type { ReasoningEffort } from "../components/ReasoningEffortSlider";

interface ChatTabProps {
  messages: TimelineItem[];
  cards: ArtifactCardEvent[];
  projects: ProjectRecord[];
  activeProject: ProjectRecord | null;
  quietStatus: QuietStatusProjection;
  activeModelLabel: string;
  gitDiff: GitDiffResponse | null;
  effort: ReasoningEffort;
  autonomy: AutonomyLevel;
  onChangeEffort: (v: ReasoningEffort) => void;
  onChangeAutonomy: (v: AutonomyLevel) => void;
  onSelectProject: (projectId: string) => void;
  onSendChat: (text: string) => Promise<void>;
  onCreateDemoProject: (name: string) => Promise<void>;
  onOpenProjectPreview: (projectId: string, artifactPath?: string) => void;
  onOpenDiffInBrowser: () => void;
  onOpenBrowser: () => void;
  onSwitchToBots: () => void;
}

function formatTime(ts: number): string {
  try {
    return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(new Date(ts));
  } catch {
    return "";
  }
}

export function ChatTab({
  messages,
  cards,
  projects,
  activeProject,
  quietStatus,
  activeModelLabel,
  gitDiff,
  effort,
  autonomy,
  onChangeEffort,
  onChangeAutonomy,
  onSelectProject,
  onSendChat,
  onCreateDemoProject,
  onOpenProjectPreview,
  onOpenDiffInBrowser,
  onOpenBrowser,
  onSwitchToBots,
}: ChatTabProps) {
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, cards.length, busy]);

  const handleSend = async (text: string) => {
    if (busy) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await onSendChat(text);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const handleCreateDemo = async (name: string) => {
    if (busy) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await onCreateDemoProject(name);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSlash = (command: string) => {
    if (command === "/diff") {
      onOpenDiffInBrowser();
    } else if (command === "/preview" || command === "/plan") {
      if (activeProject) onOpenProjectPreview(activeProject.id, "plans/roadmap.md");
      else onOpenBrowser();
    } else if (command === "/spawn-bot" || command === "/verify") {
      onSwitchToBots();
    }
  };

  const isEmpty = messages.length === 0 && cards.length === 0;

  return (
    <div className="chat-root" data-density="airy">
      <div className="chat-layout">
        {errorMsg && (
          <div className="inline-error">
            <span>{errorMsg}</span>
            <button type="button" className="btn xs ghost" onClick={() => setErrorMsg(null)}>
              Schließen
            </button>
          </div>
        )}

        <div className="chat-stream" ref={streamRef}>
          {isEmpty && (
            <div className="chat-empty">
              <div className="chat-empty-emblem">
                <BotAvatar role="orchestrator" size={56} active={busy} />
              </div>
              <h2 className="chat-empty-title">Woran sollen wir arbeiten?</h2>
              <p className="chat-empty-body">
                Sprich hier ruhig mit dem Meta-Orchestrator. Er legt Projekt-Workspaces an, koordiniert deine
                Bot-Teams im Hintergrund und öffnet Pläne, Code, Bilder &amp; 3D-Modelle direkt im In-App-Browser.
              </p>
              <div className="chat-empty-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() => void handleCreateDemo(`Bot-Factory Demo${projects.length ? ` ${projects.length + 1}` : ""}`)}
                >
                  <FolderPlus size={14} strokeWidth={1.6} />
                  <span>Projekt mit Doc-, Bild- &amp; 3D-Preview starten</span>
                </button>
                {quietStatus.activeProjects > 0 && (
                  <button type="button" className="btn" onClick={onSwitchToBots}>
                    <span>Zu den Bots ({quietStatus.runningBots} aktiv)</span>
                    <ArrowUpRight size={13} strokeWidth={1.6} />
                  </button>
                )}
              </div>
            </div>
          )}

          {!isEmpty && (
            <div className="bcs-time-sep">
              <span>Heute · Ruhiger Orchestrator-Kanal</span>
            </div>
          )}

          {messages.map((m) => {
            const isUser = m.role === "user";
            return (
              <div key={m.id} className={`chat-turn ${isUser ? "user" : "assistant"}`}>
                {isUser ? (
                  <div className="chat-bubble-human">
                    <div>{m.content}</div>
                    <span className="chat-turn-time human">{formatTime(m.createdAt)}</span>
                  </div>
                ) : (
                  <div className="chat-assistant-row">
                    <BotAvatar role="orchestrator" size={28} />
                    <div className="chat-assistant-body">
                      <div className="chat-turn-meta">
                        <span className="chat-speaker-name">Meta-Orchestrator</span>
                        <span className="chat-turn-time">{formatTime(m.createdAt)}</span>
                      </div>
                      <div className="chat-prose-assistant">{m.content}</div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {cards.map((c) => (
            <button
              key={c.id}
              type="button"
              className="inline-preview-card"
              onClick={() => onOpenProjectPreview(c.projectId, c.artifactPath)}
            >
              <span className="inline-preview-icon">
                <DocTabIcon size={15} />
              </span>
              <span className="inline-preview-copy">
                <span className="inline-preview-title">{c.title}</span>
                <span className="inline-preview-sub">{c.subtitle}</span>
              </span>
              <span className="inline-preview-cta">
                <BrowserPaneIcon size={13} />
                <span>Im Browser öffnen</span>
              </span>
            </button>
          ))}

          {busy && (
            <div className="chat-thinking-row">
              <BotAvatar role="orchestrator" size={24} active />
              <BotThinkingOrb activity="composing" size={20} shell={false} />
              <span>Meta-Orchestrator denkt nach…</span>
            </div>
          )}
        </div>

        <PrecisionComposer
          mode="chat"
          placeholder="Nachricht an den Meta-Orchestrator… (/ für Befehle)"
          busy={busy}
          activeProject={activeProject}
          projects={projects}
          onSelectProject={onSelectProject}
          activeModelLabel={activeModelLabel}
          gitDiff={gitDiff}
          showDiffTray={true}
          onViewDiff={onOpenDiffInBrowser}
          onQuickReview={onOpenDiffInBrowser}
          onOpenBrowser={onOpenBrowser}
          effort={effort}
          onChangeEffort={onChangeEffort}
          autonomy={autonomy}
          onChangeAutonomy={onChangeAutonomy}
          onSubmit={handleSend}
          onSlashAction={handleSlash}
        />
      </div>
    </div>
  );
}
