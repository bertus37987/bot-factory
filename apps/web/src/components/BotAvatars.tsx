import type { AgentRecord } from "@bot-factory/shared";
import { type CSSProperties, type JSX } from "react";
import { BearEyeRig, PlushBearBody } from "./PlushBear";

/* --------------------------------------------------------------------------
 * Bot-Factory Studio — vector plush bear crew
 * Crisp role-coded SVG plush bears with a separate animated eye layer:
 * one ownable teddy silhouette, large expressive eyes, and functional
 * workwear accessories instead of stock icons or raster artifacts.
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
    if (/verifier|inspect|review/.test(n)) {
      role = "verifier";
    } else if (/3d|visual|asset|design|carver/.test(n)) {
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
        <PlushBearBody role={role} />
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
