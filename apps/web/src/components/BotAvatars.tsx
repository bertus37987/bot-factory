import type { JSX } from "react";
import type { AgentRecord } from "@bot-factory/shared";

/* --------------------------------------------------------------------------
 * Bot-Factory Studio — Low-Poly Flat-Shaded Orange Beavers
 * Signature visual identity: crisp geometric facets in burnt-orange,
 * sunlit peach, and deep terracotta; cream snout + twin front teeth;
 * espresso nose & eyes. Sharp at 20px / 28px / 34px / 48px.
 * ------------------------------------------------------------------------ */

export type BotRoleKind =
  | "orchestrator"
  | "team_lead"
  | "builder"
  | "artist_3d"
  | "research"
  | "verifier";

export interface ResolvedBotMeta {
  role: BotRoleKind;
  jobTitle: string;
  displayName: string;
  tintBg: string;
  tintBorder: string;
  tintInk: string;
}

const ROLE_META: Record<BotRoleKind, Omit<ResolvedBotMeta, "role">> = {
  orchestrator: {
    displayName: "Meta",
    jobTitle: "Orchestrator",
    tintBg: "#FDF1E2",
    tintBorder: "#F0D9BC",
    tintInk: "#A65A18",
  },
  team_lead: {
    displayName: "Chief",
    jobTitle: "Team Lead",
    tintBg: "#F0F3F8",
    tintBorder: "#DBE2EE",
    tintInk: "#3A4A63",
  },
  builder: {
    displayName: "Forge",
    jobTitle: "Builder",
    tintBg: "#FBEFE4",
    tintBorder: "#EFD4BC",
    tintInk: "#B84312",
  },
  artist_3d: {
    displayName: "Carver",
    jobTitle: "3D Artist",
    tintBg: "#FAF0EA",
    tintBorder: "#EBD2C2",
    tintInk: "#A04E20",
  },
  research: {
    displayName: "Scout",
    jobTitle: "Research",
    tintBg: "#F0F4EC",
    tintBorder: "#DAE4D0",
    tintInk: "#5C6B4C",
  },
  verifier: {
    displayName: "Inspector",
    jobTitle: "Verifier",
    tintBg: "#EFF2FA",
    tintBorder: "#DCE2F2",
    tintInk: "#3354B8",
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

interface FurPalette {
  litA: string;
  litB: string;
  mid: string;
  midDark: string;
  shade: string;
  ear: string;
  earInner: string;
}

const FUR_DEFAULT: FurPalette = {
  litA: "#F7A66B",
  litB: "#F39356",
  mid: "#E06224",
  midDark: "#D0531C",
  shade: "#B84312",
  ear: "#B84312",
  earInner: "#E06224",
};

const FUR_ORCHESTRATOR: FurPalette = {
  litA: "#F8B571",
  litB: "#F5A75B",
  mid: "#ED8B2C",
  midDark: "#DD761E",
  shade: "#C4631A",
  ear: "#C4631A",
  earInner: "#ED8B2C",
};

const CREAM = "#FFF7ED";
const CREAM_SHADE = "#F4E7D6";
const ESPRESSO = "#1C1917";

const O = {
  top: [24, 8.2],
  topR: [35.5, 10.5],
  sideR: [40.8, 20.5],
  jawR: [40.2, 30.5],
  chinR: [33.5, 38.8],
  chin: [24, 42.6],
  chinL: [14.5, 38.8],
  jawL: [7.8, 30.5],
  sideL: [7.2, 20.5],
  topL: [12.5, 10.5],
} as const;
const P = [24, 23.5] as const;

const pt = (a: readonly [number, number] | readonly number[]) => `${a[0]},${a[1]}`;

function BeaverFace({ role }: { role: BotRoleKind }) {
  const fur = role === "orchestrator" ? FUR_ORCHESTRATOR : FUR_DEFAULT;
  return (
    <>
      <polygon points="10,13 8,5 16,4.5 18,12" fill={fur.ear} />
      <polygon points="38,13 40,5 32,4.5 30,12" fill={fur.ear} />
      <polygon points="11.4,10.6 10.4,7.2 15,6.7 15.9,10.4" fill={fur.earInner} />
      <polygon points="36.6,10.6 37.6,7.2 33,6.7 32.1,10.4" fill={fur.earInner} />

      <polygon points={`${pt(O.sideL)} ${pt(O.topL)} ${pt(P)}`} fill={fur.litA} />
      <polygon points={`${pt(O.topL)} ${pt(O.top)} ${pt(P)}`} fill={fur.litB} />
      <polygon points={`${pt(O.top)} ${pt(O.topR)} ${pt(P)}`} fill={fur.litB} />
      <polygon points={`${pt(O.topR)} ${pt(O.sideR)} ${pt(P)}`} fill={fur.mid} />
      <polygon points={`${pt(O.sideR)} ${pt(O.jawR)} ${pt(P)}`} fill={fur.midDark} />
      <polygon points={`${pt(O.jawR)} ${pt(O.chinR)} ${pt(P)}`} fill={fur.shade} />
      <polygon points={`${pt(O.chinR)} ${pt(O.chin)} ${pt(P)}`} fill={fur.midDark} />
      <polygon points={`${pt(O.chin)} ${pt(O.chinL)} ${pt(P)}`} fill={fur.mid} />
      <polygon points={`${pt(O.chinL)} ${pt(O.jawL)} ${pt(P)}`} fill={fur.litB} />
      <polygon points={`${pt(O.jawL)} ${pt(O.sideL)} ${pt(P)}`} fill={fur.litA} />

      <polygon points="24,26.5 24,38.8 18.5,37.2 15.5,32 17.5,27.5" fill={CREAM} />
      <polygon points="24,26.5 30.5,27.5 32.5,32 29.5,37.2 24,38.8" fill={CREAM_SHADE} />

      <polygon points="19.8,26.8 28.2,26.8 26.4,31.2 21.6,31.2" fill={ESPRESSO} />

      <ellipse cx="16.8" cy="21.7" rx="2" ry="2.3" fill={ESPRESSO} />
      <ellipse cx="31.2" cy="21.7" rx="2" ry="2.3" fill={ESPRESSO} />
      <circle cx="17.4" cy="21" r="0.55" fill="#FFFFFF" />
      <circle cx="31.8" cy="21" r="0.55" fill="#FFFFFF" />

      <path d="M24 31.4 L24 34.4" stroke="#E4CDB4" strokeWidth="0.8" fill="none" />
      <rect x="21.6" y="38.6" width="2.6" height="3.6" rx="0.7" fill="#FFFBF4" />
      <rect x="23.8" y="38.6" width="2.6" height="3.6" rx="0.7" fill="#FFFBF4" />
    </>
  );
}

function BeaverOutfit({ role }: { role: BotRoleKind }) {
  switch (role) {
    case "team_lead":
      return (
        <>
          <circle cx="16.8" cy="21.7" r="5" fill="none" stroke="#3A3F4A" strokeWidth="1.4" />
          <circle cx="31.2" cy="21.7" r="5" fill="none" stroke="#3A3F4A" strokeWidth="1.4" />
          <path d="M21.8 20.6 L26.2 20.6" stroke="#3A3F4A" strokeWidth="1.4" fill="none" />
          <path d="M11.9 20.2 L8 19.2" stroke="#3A3F4A" strokeWidth="1.4" fill="none" />
          <path d="M36.1 20.2 L40 19.2" stroke="#3A3F4A" strokeWidth="1.4" fill="none" />
          <polygon points="8,48 16,41.6 24,44.6 24,48" fill="#39465E" />
          <polygon points="24,44.6 32,41.6 40,48 24,48" fill="#2E3A50" />
          <path d="M11 47 L17.4 43.2" stroke="#7C8DA8" strokeWidth="0.6" fill="none" />
          <path d="M14 47.6 L19.4 44.4" stroke="#7C8DA8" strokeWidth="0.6" fill="none" />
          <path d="M37 47 L30.6 43.2" stroke="#56677F" strokeWidth="0.6" fill="none" />
          <path d="M34 47.6 L28.6 44.4" stroke="#56677F" strokeWidth="0.6" fill="none" />
        </>
      );
    case "builder":
      return (
        <>
          <polygon points="8.5,15.6 24,12.4 39.5,15.6 39.5,18.6 24,15.4 8.5,18.6" fill="#3A3F45" />
          <path d="M21.2 15.2 L26.8 15.2" stroke="#2E3339" strokeWidth="1.6" fill="none" />
          <circle cx="16.5" cy="15.2" r="4.7" fill="#555D66" stroke="#2E3339" strokeWidth="1.6" />
          <circle cx="31.5" cy="15.2" r="4.7" fill="#555D66" stroke="#2E3339" strokeWidth="1.6" />
          <circle cx="16.5" cy="15.2" r="2.9" fill="#6A7480" />
          <circle cx="31.5" cy="15.2" r="2.9" fill="#6A7480" />
          <polygon points="14.6,13.6 16.5,12.2 18,13.6 16.5,14.2" fill="#9AA4AE" />
          <polygon points="29.6,13.6 31.5,12.2 33,13.6 31.5,14.2" fill="#9AA4AE" />
          <polygon points="9,48 17,42 24,44.8 24,48" fill="#383E46" />
          <polygon points="24,44.8 31,42 39,48 24,48" fill="#2C3138" />
          <path d="M17 42 L24 44.8 L31 42" stroke="#4A515B" strokeWidth="0.8" fill="none" />
        </>
      );
    case "artist_3d":
      return (
        <>
          <polygon
            points="12.5,13.8 15,7 20.5,4.6 27.5,4.4 34,6.4 38.4,9.6 38.8,13.8 30,12.4 20.5,11.8"
            fill="#B84312"
          />
          <polygon points="15,12.4 17.4,7 22,5.2 27,5.4 23,10 18,11.6" fill="#D2541B" />
          <polygon
            points="12.5,13.8 20.5,11.8 30,12.4 38.8,13.8 38.2,15.2 13,15.2"
            fill="#4A3F38"
          />
          <circle cx="30.4" cy="4.8" r="0.9" fill="#8F3410" />
          <polygon points="10,48 16.5,42.9 24,45.2 31.5,42.9 38,48" fill="#5B524B" />
          <polygon points="16.5,42.9 24,45.2 24,48 13.5,48" fill="#6A5F56" />
        </>
      );
    case "research":
      return (
        <>
          <path d="M36.4 18.6 L39.6 15.4" stroke="#9A7B33" strokeWidth="1.4" fill="none" />
          <circle
            cx="31.5"
            cy="21.7"
            r="5.5"
            fill="rgba(255,255,255,0.16)"
            stroke="#9A7B33"
            strokeWidth="1.6"
          />
          <polygon points="28.6,18.6 30.1,17.1 31.3,18.5 29.9,19.7" fill="rgba(255,255,255,0.55)" />
          <path d="M35.9 24.9 L37.4 27" stroke="#9A7B33" strokeWidth="1.3" fill="none" />
          <polygon points="9,48 12,42.6 24,45.4 36,42.6 39,48" fill="#8A9B78" />
          <polygon points="12,42.6 24,45.4 21,48 9,48" fill="#76855F" />
          <polygon points="15,44.4 18.6,45.9 15.7,47.8 12.4,46.2" fill="#6B7A57" />
        </>
      );
    case "verifier":
      return (
        <>
          <circle
            cx="16.8"
            cy="21.7"
            r="6.3"
            fill="rgba(255,255,255,0.18)"
            stroke="#3354B8"
            strokeWidth="1.8"
          />
          <polygon points="13.4,18.2 15.2,16.6 16.6,18.4 15,19.8" fill="rgba(255,255,255,0.55)" />
          <path d="M12.1 26.2 L8.6 30.4" stroke="#3354B8" strokeWidth="1.8" fill="none" />
          <polygon points="9,48 15.5,42.8 24,45.2 24,48" fill="#D9E1F0" />
          <polygon points="24,45.2 32.5,42.8 39,48 24,48" fill="#C9D4E8" />
          <path d="M13.4 45.6 L15.8 47.6 L19.6 43.4" stroke="#3354B8" strokeWidth="1.2" fill="none" />
        </>
      );
    case "orchestrator":
      return (
        <>
          <polygon
            points="24,9.6 25.15,12.9 28.4,14 25.15,15.1 24,18.4 22.85,15.1 19.6,14 22.85,12.9"
            fill="#FFD9A3"
          />
          <polygon
            points="31.4,9.4 31.95,11 33.5,11.6 31.95,12.2 31.4,13.8 30.85,12.2 29.3,11.6 30.85,11"
            fill="#FFE4BC"
          />
          <polygon points="12,48 17.5,43.6 24,45.6 30.5,43.6 36,48" fill="#E8C79A" />
          <polygon points="17.5,43.6 24,45.6 24,48 15,48" fill="#DDB583" />
        </>
      );
    default:
      return null;
  }
}

function BeaverPortrait({ role }: { role: BotRoleKind }) {
  const meta = ROLE_META[role];
  return (
    <>
      <rect x="0" y="0" width="48" height="48" rx="9" fill={meta.tintBg} />
      <BeaverFace role={role} />
      <BeaverOutfit role={role} />
      <rect
        x="0.5"
        y="0.5"
        width="47"
        height="47"
        rx="8.5"
        fill="none"
        stroke={meta.tintBorder}
        strokeWidth="1"
      />
    </>
  );
}

export interface BotAvatarProps {
  role: BotRoleKind;
  size?: number;
  active?: boolean;
  badgeCount?: number;
  className?: string;
}

export function BotAvatar({
  role,
  size = 32,
  active = false,
  badgeCount,
  className,
}: BotAvatarProps): JSX.Element {
  const meta = ROLE_META[role];
  const badgeSize = Math.max(13, Math.round(size * 0.42));
  const badgeLabel =
    badgeCount !== undefined && badgeCount > 0 ? (badgeCount > 9 ? "9+" : `${badgeCount}`) : null;

  return (
    <span
      className={`bf-beaver-wrap ${className ?? ""}`.trim()}
      role="img"
      aria-label={`${meta.displayName} · ${meta.jobTitle}`}
      title={`${meta.displayName} · ${meta.jobTitle}`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
        <BeaverPortrait role={role} />
      </svg>

      {active && (
        <span
          className="bf-beaver-active-ring"
          aria-hidden="true"
          style={{ borderRadius: Math.round(size * (9 / 48)) + 3 }}
        />
      )}

      {active && (
        <span className="bf-beaver-dots" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="bf-beaver-dot"
              style={{ animationDelay: `${i * 0.22}s` }}
            />
          ))}
        </span>
      )}

      {badgeLabel !== null && (
        <span
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
    </span>
  );
}

export interface JobTitlePillProps {
  label: string;
  tone?: "neutral" | "accent";
}

export function JobTitlePill({ label, tone = "neutral" }: JobTitlePillProps): JSX.Element {
  return (
    <span className={`bf-job-pill ${tone === "accent" ? "accent" : ""}`.trim()}>
      {label}
    </span>
  );
}

export interface GroupAvatarClusterProps {
  roles: BotRoleKind[];
  size?: number;
}

export function GroupAvatarCluster({ roles, size = 32 }: GroupAvatarClusterProps): JSX.Element {
  const cells = roles.slice(0, 4);
  const gap = Math.max(1, Math.round(size * 0.05));
  const cellRadius = Math.max(3, Math.round(size * 0.14));
  return (
    <span
      className="bf-group-cluster"
      role="img"
      aria-label={`Bot team (${cells.length})`}
      style={{ gap, width: size, height: size }}
    >
      {[0, 1, 2, 3].map((i) =>
        cells[i] ? (
          <svg
            key={i}
            viewBox="0 0 48 48"
            width="100%"
            height="100%"
            aria-hidden="true"
            style={{ display: "block" }}
          >
            <BeaverPortrait role={cells[i]} />
          </svg>
        ) : (
          <span
            key={i}
            className="bf-group-empty-cell"
            aria-hidden="true"
            style={{ borderRadius: cellRadius }}
          />
        ),
      )}
    </span>
  );
}
