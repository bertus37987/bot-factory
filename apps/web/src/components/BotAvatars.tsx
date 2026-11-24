import type { AgentRecord } from "@bot-factory/shared";
import { useId, type CSSProperties, type JSX } from "react";
import bearArtistImg from "../assets/bears/bear-artist.png";
import bearBuilderImg from "../assets/bears/bear-builder.png";
import bearCubImg from "../assets/bears/bear-cub.png";
import bearOrchestratorImg from "../assets/bears/bear-orchestrator.png";
import bearResearchImg from "../assets/bears/bear-research.png";
import bearTeamLeadImg from "../assets/bears/bear-team-lead.png";
import bearVerifierImg from "../assets/bears/bear-verifier.png";
import eyeAnchorsRaw from "../assets/bears/eyeAnchors.json";

/* --------------------------------------------------------------------------
 * Bot-Factory Studio — Blender-rendered matte bears with SVG eye rigs
 * Role-matched 256x256 RGBA portraits overlaid with synchronized SVG eye rigs
 * anchored from eyeAnchors.json for working scans, waiting
 * alertness, happy "done" arcs, and diagonal lens gleam on Research shades.
 * ------------------------------------------------------------------------ */

export type BotRoleKind =
  | "orchestrator"
  | "team_lead"
  | "builder"
  | "artist_3d"
  | "research"
  | "verifier"
  | "cub";

export type BearAvatarStatus = "idle" | "working" | "waiting" | "done" | "error";

export interface ResolvedBotMeta {
  role: BotRoleKind;
  jobTitle: string;
  displayName: string;
  tintBg: string;
  tintBorder: string;
  tintInk: string;
  accentVar: string;
}

export const ROLE_META: Record<BotRoleKind, Omit<ResolvedBotMeta, "role">> = {
  orchestrator: {
    displayName: "Meta",
    jobTitle: "Orchestrator",
    tintBg: "var(--bubble-orch-bg)",
    tintBorder: "var(--bubble-orch-border)",
    tintInk: "var(--bubble-orch-accent)",
    accentVar: "var(--bubble-orch-accent)",
  },
  team_lead: {
    displayName: "Chief",
    jobTitle: "Team Lead",
    tintBg: "var(--bubble-lead-bg)",
    tintBorder: "var(--bubble-lead-border)",
    tintInk: "var(--bubble-lead-accent)",
    accentVar: "var(--bubble-lead-accent)",
  },
  builder: {
    displayName: "Forge",
    jobTitle: "Builder",
    tintBg: "var(--bubble-builder-bg)",
    tintBorder: "var(--bubble-builder-border)",
    tintInk: "var(--bubble-builder-accent)",
    accentVar: "var(--bubble-builder-accent)",
  },
  artist_3d: {
    displayName: "Carver",
    jobTitle: "3D Artist",
    tintBg: "var(--bubble-artist-bg)",
    tintBorder: "var(--bubble-artist-border)",
    tintInk: "var(--bubble-artist-accent)",
    accentVar: "var(--bubble-artist-accent)",
  },
  research: {
    displayName: "Scout",
    jobTitle: "Research",
    tintBg: "var(--bubble-research-bg)",
    tintBorder: "var(--bubble-research-border)",
    tintInk: "var(--bubble-research-accent)",
    accentVar: "var(--bubble-research-accent)",
  },
  verifier: {
    displayName: "Inspector",
    jobTitle: "Verifier",
    tintBg: "var(--bubble-verifier-bg)",
    tintBorder: "var(--bubble-verifier-border)",
    tintInk: "var(--bubble-verifier-accent)",
    accentVar: "var(--bubble-verifier-accent)",
  },
  cub: {
    displayName: "Cub",
    jobTitle: "Subagent Cub",
    tintBg: "var(--bubble-cub-bg)",
    tintBorder: "var(--bubble-cub-border)",
    tintInk: "var(--bubble-cub-accent)",
    accentVar: "var(--bubble-cub-accent)",
  },
};

type EyeAnchorKey = keyof typeof eyeAnchorsRaw;

const BEAR_ASSETS: Record<BotRoleKind, { src: string; anchorKey: EyeAnchorKey }> = {
  orchestrator: { src: bearOrchestratorImg, anchorKey: "orchestrator" },
  team_lead: { src: bearTeamLeadImg, anchorKey: "team-lead" },
  builder: { src: bearBuilderImg, anchorKey: "builder" },
  artist_3d: { src: bearArtistImg, anchorKey: "artist" },
  research: { src: bearResearchImg, anchorKey: "research" },
  verifier: { src: bearVerifierImg, anchorKey: "verifier" },
  cub: { src: bearCubImg, anchorKey: "cub" },
};

export function resolveBotRole(
  agent: Pick<AgentRecord, "scope" | "name" | "model">,
): ResolvedBotMeta {
  let role: BotRoleKind;
  if (agent.scope === "global") {
    role = "orchestrator";
  } else if (agent.scope === "project") {
    role = "team_lead";
  } else if (agent.scope === "verifier") {
    role = "verifier";
  } else if (agent.scope === "sidekick") {
    role = "cub";
  } else {
    const n = `${agent.name} ${agent.model}`.toLowerCase();
    if (/3d|visual|asset|design|carver/.test(n)) {
      role = "artist_3d";
    } else if (/research|scout|memory|audit/.test(n)) {
      role = "research";
    } else if (/forge|build|dev|code|eng/.test(n)) {
      role = "builder";
    } else {
      let h = 0;
      const key = agent.name || agent.model || "peer";
      for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
      role = h % 2 === 0 ? "builder" : "research";
    }
  }
  return { role, ...ROLE_META[role] };
}

export function mapAgentStatusToBearStatus(
  agentStatus?: AgentRecord["status"],
  active?: boolean,
): BearAvatarStatus {
  if (agentStatus === "working") return "working";
  if (
    agentStatus === "waiting_review" ||
    agentStatus === "requires_action" ||
    agentStatus === "debating" ||
    agentStatus === "paused"
  ) {
    return "waiting";
  }
  if (agentStatus === "error") return "error";
  if (agentStatus === "stopped") return "idle";
  return active ? "working" : "idle";
}

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function BearEyeRig({
  role,
  status,
  seed,
}: {
  role: BotRoleKind;
  status: BearAvatarStatus;
  seed?: string;
}): JSX.Element {
  const uid = useId().replace(/:/g, "");
  const asset = BEAR_ASSETS[role];
  const anchor = eyeAnchorsRaw[asset.anchorKey];
  const [lx, ly] = anchor.left;
  const [rx, ry] = anchor.right;

  const h = hashSeed(seed || role);
  const blinkDelay = `${(-((h % 41) * 0.11)).toFixed(2)}s`;
  const glanceDelay = `${(-((h % 29) * 0.17)).toFixed(2)}s`;

  if (anchor.hasShades) {
    const clipId = `shades-clip-${uid}`;
    const gradId = `shades-grad-${uid}`;
    return (
      <svg
        className="bear-eye-rig"
        width="100%"
        height="100%"
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <defs>
          <clipPath id={clipId}>
            <circle cx={lx} cy={ly} r="7.4" />
            <circle cx={rx} cy={ry} r="7.4" />
          </clipPath>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="50%" stopColor="#ffffff" stopOpacity="0.72" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          <g className="bear-shades-gleam" style={{ animationDelay: blinkDelay }}>
            <polygon points="10,25 22,25 8,65 -4,65" fill={`url(#${gradId})`} />
            <polygon points="24,25 28,25 14,65 10,65" fill="rgba(255,255,255,0.42)" />
          </g>
        </g>
        {status === "done" && (
          <path
            d={`M ${rx + 5.8} ${ry - 5.8} L ${rx + 6.4} ${ry - 4.1} L ${rx + 8.1} ${ry - 3.5} L ${rx + 6.4} ${ry - 2.9} L ${rx + 5.8} ${ry - 1.2} L ${rx + 5.2} ${ry - 2.9} L ${rx + 3.5} ${ry - 3.5} L ${rx + 5.2} ${ry - 4.1} Z`}
            fill="#ffffff"
            opacity="0.92"
          />
        )}
      </svg>
    );
  }

  const eyes: Array<[number, number, "left" | "right"]> = [
    [lx, ly, "left"],
    [rx, ry, "right"],
  ];

  return (
    <svg
      className="bear-eye-rig"
      width="100%"
      height="100%"
      viewBox="0 0 100 100"
      aria-hidden="true"
    >
      {eyes.map(([cx, cy, side]) => {
        if (status === "done") {
          return (
            <g key={side} className="bear-eye-happy">
              <path
                d={`M ${cx - 4.1} ${cy + 1.0} Q ${cx} ${cy - 4.7} ${cx + 4.1} ${cy + 1.0}`}
                stroke="#140d09"
                strokeWidth="2.9"
                strokeLinecap="round"
                fill="none"
              />
            </g>
          );
        }

        if (status === "error") {
          const dir = side === "left" ? 1 : -1;
          return (
            <g key={side} className="bear-eye-error">
              <path
                d={`M ${cx - 3.3 * dir} ${cy - 2.6} L ${cx + 2.9 * dir} ${cy} L ${cx - 3.3 * dir} ${cy + 2.6}`}
                stroke="#140d09"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </g>
          );
        }

        const eyeRx = status === "waiting" ? 4.85 : 4.35;
        const eyeRy = status === "waiting" ? 5.95 : 5.35;
        const catchR = status === "waiting" ? 1.7 : 1.5;

        return (
          <g key={side} className="bear-eye-group" style={{ animationDelay: blinkDelay }}>
            <g className="bear-eye-glance" style={{ animationDelay: glanceDelay }}>
              <ellipse cx={cx} cy={cy} rx={eyeRx} ry={eyeRy} fill="#140d09" />
              <circle cx={cx + 1.4} cy={cy - 1.7} r={catchR} fill="#ffffff" />
              <circle cx={cx - 1.25} cy={cy + 1.65} r={0.7} fill="rgba(255,255,255,0.72)" />
            </g>
          </g>
        );
      })}
    </svg>
  );
}

export interface BotAvatarProps {
  role: BotRoleKind;
  size?: number;
  active?: boolean;
  live?: boolean;
  badgeCount?: number;
  status?: BearAvatarStatus;
  agentStatus?: AgentRecord["status"];
  seed?: string;
  className?: string;
}

export function BotAvatar({
  role,
  size = 32,
  active = false,
  live = false,
  badgeCount,
  status,
  agentStatus,
  seed,
  className,
}: BotAvatarProps): JSX.Element {
  const meta = ROLE_META[role];
  const asset = BEAR_ASSETS[role];
  const effectiveStatus = live ? status ?? mapAgentStatusToBearStatus(agentStatus, active) : "idle";
  const badgeSize = Math.max(13, Math.round(size * 0.4));
  const badgeLabel =
    badgeCount !== undefined && badgeCount > 0 ? (badgeCount > 9 ? "9+" : `${badgeCount}`) : null;

  const wrapStyle = {
    width: size,
    height: size,
  } as CSSProperties;

  return (
    <div
      className={`bear-avatar-wrap bf-beaver-wrap ${className ?? ""}`.trim()}
      data-role={role}
      data-status={effectiveStatus}
      data-live={live || undefined}
      role="img"
      aria-label={`${meta.displayName} · ${meta.jobTitle}`}
      title={`${meta.displayName} · ${meta.jobTitle}`}
      style={wrapStyle}
    >
      <span className="bear-portrait-stage">
        <img src={asset.src} alt="" draggable={false} className="bear-avatar-img" />
        <BearEyeRig role={role} status={effectiveStatus} seed={seed} />
      </span>

      {effectiveStatus === "waiting" && badgeLabel === null && (
        <span className="bear-waiting-dot" aria-hidden="true" />
      )}

      {badgeLabel !== null && (
        <span
          role="status"
          aria-label={`${badgeCount} unread`}
          className="bf-beaver-badge bf-tabular"
          style={{
            minWidth: badgeSize,
            height: badgeSize,
            fontSize: Math.max(8, Math.round(badgeSize * 0.62)),
          }}
        >
          {badgeLabel}
        </span>
      )}
    </div>
  );
}

export const BearAvatar = BotAvatar;

export interface JobTitlePillProps {
  label: string;
  tone?: "neutral" | "accent";
  role?: BotRoleKind;
}

export function JobTitlePill({ label, tone = "neutral", role }: JobTitlePillProps): JSX.Element {
  return (
    <span
      className={`bf-job-pill ${tone === "accent" ? "accent" : ""}`.trim()}
      data-role={role}
    >
      {label}
    </span>
  );
}

export interface GroupAvatarClusterProps {
  roles: BotRoleKind[];
  size?: number;
  totalCount?: number;
}

export function GroupAvatarCluster({ roles, size = 32, totalCount }: GroupAvatarClusterProps): JSX.Element {
  const count = totalCount ?? roles.length;
  const hasOverflow = count > 4;
  const visibleRoles = roles.slice(0, hasOverflow ? 3 : 4);
  const gap = Math.max(1, Math.round(size * 0.05));
  const cellSize = Math.max(10, Math.floor((size - gap) / 2));
  const cellRadius = Math.max(3, Math.round(size * 0.14));

  if (!hasOverflow && count === 1 && visibleRoles[0]) {
    return (
      <span
        className="bf-group-cluster bf-group-cluster-single"
        role="img"
        aria-label={`Bot team (${count})`}
        style={{ width: size, height: size }}
      >
        <BotAvatar role={visibleRoles[0]} size={size} seed={`cluster-single-${visibleRoles[0]}`} />
      </span>
    );
  }

  if (!hasOverflow && count === 2) {
    return (
      <span
        className="bf-group-cluster bf-group-cluster-pair"
        role="img"
        aria-label={`Bot team (${count})`}
        style={{ gap, width: size, height: size }}
      >
        {visibleRoles.map((role, i) => (
          <BotAvatar key={`${i}-${role}`} role={role} size={cellSize} seed={`cluster-pair-${i}-${role}`} />
        ))}
      </span>
    );
  }

  return (
    <span
      className="bf-group-cluster"
      role="img"
      aria-label={`Bot team (${count})`}
      style={{ gap, width: size, height: size }}
    >
      {[0, 1, 2, 3].map((i) => {
        if (hasOverflow && i === 3) {
          return (
            <span
              key="overflow"
              className="bf-group-overflow-cell"
              style={{ borderRadius: cellRadius, fontSize: Math.max(7, Math.round(cellSize * 0.52)) }}
            >
              +{count - 3}
            </span>
          );
        }
        const role = visibleRoles[i];
        return role ? (
          <BotAvatar key={`${i}-${role}`} role={role} size={cellSize} seed={`cluster-${i}-${role}`} />
        ) : (
          <span key={i} className="bf-group-empty-cell" aria-hidden="true" />
        );
      })}
    </span>
  );
}
