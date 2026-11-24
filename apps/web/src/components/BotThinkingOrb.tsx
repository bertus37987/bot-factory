import type { AgentRecord } from "@bot-factory/shared";
import { ThinkingOrb, type OrbSize, type OrbState } from "thinking-orbs";

export type OrbTone = "neutral" | "active" | "success" | "warning" | "danger";

export type BotOrbActivity =
  | OrbState
  | "idle"
  | "paused"
  | "stopped"
  | "error"
  | "debating"
  | "waiting_review"
  | "requires_action";

interface ResolvedOrb {
  kind: "orb" | "idle";
  state: OrbState;
  tone: OrbTone;
  paused: boolean;
  activeBreath: boolean;
  color?: string;
  speed: number;
  label: string;
}

const AGENT_STATUS_MAP: Record<AgentRecord["status"], ResolvedOrb> = {
  idle: {
    kind: "idle",
    state: "breathing",
    tone: "neutral",
    paused: true,
    activeBreath: false,
    speed: 0.7,
    label: "Idle",
  },
  working: {
    kind: "orb",
    state: "working",
    tone: "active",
    paused: false,
    activeBreath: true,
    color: "#1e4e79",
    speed: 0.82,
    label: "Agent working",
  },
  waiting_review: {
    kind: "orb",
    state: "listening",
    tone: "warning",
    paused: false,
    activeBreath: true,
    color: "#8a530b",
    speed: 0.72,
    label: "Waiting for review",
  },
  requires_action: {
    kind: "orb",
    state: "solving",
    tone: "warning",
    paused: false,
    activeBreath: true,
    color: "#8a530b",
    speed: 0.76,
    label: "Requires operator decision",
  },
  debating: {
    kind: "orb",
    state: "weaving",
    tone: "warning",
    paused: false,
    activeBreath: true,
    color: "#8a530b",
    speed: 0.8,
    label: "In conflict debate",
  },
  paused: {
    kind: "orb",
    state: "breathing",
    tone: "warning",
    paused: true,
    activeBreath: false,
    color: "#8a530b",
    speed: 0.65,
    label: "Paused",
  },
  stopped: {
    kind: "idle",
    state: "breathing",
    tone: "danger",
    paused: true,
    activeBreath: false,
    speed: 0.65,
    label: "Stopped",
  },
  error: {
    kind: "orb",
    state: "shaping",
    tone: "danger",
    paused: true,
    activeBreath: false,
    color: "#9e2626",
    speed: 0.65,
    label: "Error",
  },
};

function resolveOrbConfig(
  status?: AgentRecord["status"],
  activity?: BotOrbActivity,
  toneOverride?: OrbTone,
): ResolvedOrb {
  if (activity) {
    if (activity === "idle") {
      return {
        kind: "idle",
        state: "breathing",
        tone: toneOverride ?? "neutral",
        paused: true,
        activeBreath: false,
        speed: 0.72,
        label: "Idle",
      };
    }
    if (
      activity === "paused" ||
      activity === "stopped" ||
      activity === "error" ||
      activity === "debating" ||
      activity === "waiting_review" ||
      activity === "requires_action"
    ) {
      const base = AGENT_STATUS_MAP[activity];
      return { ...base, tone: toneOverride ?? base.tone };
    }

    const defaultToneByState: Record<OrbState, { tone: OrbTone; color?: string; label: string; speed: number }> = {
      working: { tone: "neutral", label: "Processing task", speed: 0.82 },
      searching: { tone: "active", color: "#1e4e79", label: "Searching context & memory", speed: 0.8 },
      solving: { tone: "active", color: "#1e4e79", label: "Resolving conflict", speed: 0.8 },
      listening: { tone: "warning", color: "#8a530b", label: "Waiting for input", speed: 0.74 },
      connecting: { tone: "active", color: "#1e4e79", label: "Connecting to daemon", speed: 0.82 },
      weaving: { tone: "neutral", label: "Coordinating team", speed: 0.8 },
      composing: { tone: "neutral", label: "Composing response", speed: 0.82 },
      breathing: { tone: "neutral", label: "Ready", speed: 0.68 },
      shaping: { tone: "success", color: "#165e3d", label: "Shaping artifact", speed: 0.8 },
    };
    const meta = defaultToneByState[activity];
    return {
      kind: "orb",
      state: activity,
      tone: toneOverride ?? meta.tone,
      paused: false,
      activeBreath: true,
      color: meta.color,
      speed: meta.speed,
      label: meta.label,
    };
  }

  if (status) {
    const base = AGENT_STATUS_MAP[status] ?? AGENT_STATUS_MAP.idle;
    return { ...base, tone: toneOverride ?? base.tone };
  }

  return {
    kind: "orb",
    state: "breathing",
    tone: toneOverride ?? "neutral",
    paused: false,
    activeBreath: true,
    speed: 0.7,
    label: "Meta-Orchestrator ready",
  };
}

export interface BotThinkingOrbProps {
  status?: AgentRecord["status"];
  activity?: BotOrbActivity;
  size?: number;
  tone?: OrbTone;
  shell?: boolean;
  label?: string;
  className?: string;
}

function toOrbSize(size: number): OrbSize {
  if (size >= 48) return 64;
  if (size >= 26) return 32;
  return 20;
}

export function BotThinkingOrb({
  status,
  activity,
  size = 20,
  tone,
  shell = true,
  label,
  className,
}: BotThinkingOrbProps) {
  const resolved = resolveOrbConfig(status, activity, tone);
  const ariaLabel = label ?? resolved.label;
  const orbSize = toOrbSize(size);

  const shellPad = orbSize === 64 ? 8 : orbSize === 32 ? 4 : 3;
  const shellDim = orbSize + shellPad * 2;

  if (resolved.kind === "idle") {
    const slotSize = shell ? shellDim : orbSize;
    const isDanger = resolved.tone === "danger";
    return (
      <span
        className={`bf-orb-idle-slot ${className ?? ""}`.trim()}
        style={{ width: slotSize, height: slotSize }}
        role="img"
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <span
          className="bf-orb-idle"
          style={
            isDanger
              ? { borderColor: "var(--status-danger-border)", background: "var(--status-danger-bg)" }
              : undefined
          }
        />
      </span>
    );
  }

  const orbEl = (
    <ThinkingOrb
      state={resolved.state}
      size={orbSize}
      theme="light"
      speed={resolved.speed}
      paused={resolved.paused}
      color={resolved.color}
      aria-label={ariaLabel}
    />
  );

  if (!shell) {
    return (
      <span className={`bf-orb-bare ${className ?? ""}`.trim()} title={ariaLabel}>
        {orbEl}
      </span>
    );
  }

  return (
    <span
      className={`bf-orb-shell ${className ?? ""}`.trim()}
      data-orb-tone={resolved.tone}
      data-orb-active={resolved.activeBreath ? "true" : "false"}
      style={{ width: shellDim, height: shellDim }}
      title={ariaLabel}
    >
      {orbEl}
    </span>
  );
}
