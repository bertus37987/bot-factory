import type { ReactNode } from "react";

/* --------------------------------------------------------------------------
 * Bot-Factory Harness — Handcrafted Icon Set ("Monochrome Ink")
 * Minimalist geometric 1.5px-stroke SVG icons for the Light-Mode harness.
 * Every glyph: stroke="currentColor", round caps/joins, no fills unless the
 * mark itself is a focal ink dot. No cartoon robots, no emojis.
 * ------------------------------------------------------------------------ */

export interface BotFactoryIconProps {
  size?: number;
  className?: string;
}

function IconFrame({
  size = 16,
  className,
  children,
}: BotFactoryIconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Top-left rail #1 — architectural rounded aperture frame + focal ink dot. */
export function AgentChatApertureIcon({ size, className }: BotFactoryIconProps) {
  return (
    <IconFrame size={size} className={className}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
      <circle cx="12" cy="12" r="4.6" />
      <path d="M14.4 9.6 L17.8 6.2" />
      <path d="M14.4 14.4 L17.8 17.8" />
      <path d="M9.6 14.4 L6.2 17.8" />
      <path d="M9.6 9.6 L6.2 6.2" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
    </IconFrame>
  );
}

/** Top-left rail #2 — precision 3-node factory hex-lattice with conduits. */
export function BotsLatticeIcon({ size, className }: BotFactoryIconProps) {
  return (
    <IconFrame size={size} className={className}>
      <path d="M10.9 8.7 L7.6 14.5" />
      <path d="M13.1 8.7 L16.4 14.5" />
      <path d="M8.1 16.9 L15.9 16.9" />
      <path d="M12 4.2 L14 5.35 L14 7.65 L12 8.8 L10 7.65 L10 5.35 Z" />
      <path d="M6 14.6 L8 15.75 L8 18.05 L6 19.2 L4 18.05 L4 15.75 Z" />
      <path d="M18 14.6 L20 15.75 L20 18.05 L18 19.2 L16 18.05 L16 15.75 Z" />
      <circle cx="12" cy="6.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="6" cy="16.9" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="18" cy="16.9" r="0.9" fill="currentColor" stroke="none" />
    </IconFrame>
  );
}

/** Split-pane browser frame with subtle address bar line. */
export function BrowserPaneIcon({ size, className }: BotFactoryIconProps) {
  return (
    <IconFrame size={size} className={className}>
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="M3.5 9.25 H20.5" />
      <path d="M6.2 6.85 H10.6" />
      <path d="M13.4 9.5 V19.5" />
    </IconFrame>
  );
}

export type AutonomyLevel = "spec" | "low" | "medium" | "high";

export interface AutonomyBarsIconProps extends BotFactoryIconProps {
  level: AutonomyLevel;
}

/**
 * Bot-Factory signature autonomy readout — 3 vertical bars.
 * spec = dashed outlines · low = 1 ink bar · medium/high = indigo signal bars.
 */
export function AutonomyBarsIcon({ level, size, className }: AutonomyBarsIconProps) {
  const bars = [
    { x: 6.7, y: 13.5, h: 6 },
    { x: 10.9, y: 9.5, h: 10 },
    { x: 15.1, y: 5.5, h: 14 },
  ];
  const lit = level === "high" ? 3 : level === "medium" ? 2 : level === "low" ? 1 : 0;
  return (
    <IconFrame size={size} className={className}>
      {bars.map((b, i) =>
        level === "spec" ? (
          <rect
            key={i}
            x={b.x}
            y={b.y}
            width={2.2}
            height={b.h}
            rx={1.1}
            strokeDasharray="2.1 1.8"
          />
        ) : i < lit ? (
          <rect
            key={i}
            x={b.x}
            y={b.y}
            width={2.2}
            height={b.h}
            rx={1.1}
            fill={level === "low" ? "currentColor" : "var(--accent-indigo)"}
            stroke="none"
          />
        ) : (
          <rect
            key={i}
            x={b.x}
            y={b.y}
            width={2.2}
            height={b.h}
            rx={1.1}
            strokeOpacity={0.42}
          />
        ),
      )}
    </IconFrame>
  );
}

/** Slash-command keycap hint. */
export function SlashKeyIcon({ size, className }: BotFactoryIconProps) {
  return (
    <IconFrame size={size} className={className}>
      <rect x="5" y="5" width="14" height="14" rx="3.5" />
      <path d="M14.2 9.2 L9.8 14.8" />
    </IconFrame>
  );
}

/** Send / steer arrow (up-right). */
export function SendArrowIcon({ size, className }: BotFactoryIconProps) {
  return (
    <IconFrame size={size} className={className}>
      <path d="M5.5 18.5 L18.5 5.5" />
      <path d="M10.5 5.5 H18.5 V13.5" />
    </IconFrame>
  );
}

/** Quick review — loupe with check verdict. */
export function QuickReviewIcon({ size, className }: BotFactoryIconProps) {
  return (
    <IconFrame size={size} className={className}>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="M15 15 L19.5 19.5" />
      <path d="M8.3 10.4 L9.9 12 L12.9 8.9" />
    </IconFrame>
  );
}

/** Diff / worktree branch divergence. */
export function DiffBranchIcon({ size, className }: BotFactoryIconProps) {
  return (
    <IconFrame size={size} className={className}>
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="6.5" cy="18.5" r="2" />
      <circle cx="17.6" cy="16.4" r="2.1" />
      <path d="M6.5 7.5 V16.5" />
      <path d="M6.5 10.2 C6.5 13.4 8.7 14.9 11.8 15.4 L15.4 16" />
    </IconFrame>
  );
}

/** Left rail / sidebar visibility toggle. */
export function SidebarToggleIcon({ size, className }: BotFactoryIconProps) {
  return (
    <IconFrame size={size} className={className}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M9.6 4.5 V19.5" />
      <path d="M6.1 8.2 H7.5" />
      <path d="M6.1 11 H7.5" />
    </IconFrame>
  );
}

/* Shared "folder tab" chrome for the artifact tab family. */
const TAB_CHROME =
  "M5.5 5.5 L9.8 5.5 L11.3 7 L18.5 7 C19.3 7 20 7.7 20 8.5 L20 17.5 C20 18.3 19.3 19 18.5 19 L5.5 19 C4.7 19 4 18.3 4 17.5 L4 7 C4 6.2 4.7 5.5 5.5 5.5 Z";

/** Code artifact tab. */
export function CodeTabIcon({ size, className }: BotFactoryIconProps) {
  return (
    <IconFrame size={size} className={className}>
      <path d={TAB_CHROME} />
      <path d="M10 10.8 L8.2 12.7 L10 14.6" />
      <path d="M14 10.8 L15.8 12.7 L14 14.6" />
    </IconFrame>
  );
}

/** Markdown / document artifact tab. */
export function DocTabIcon({ size, className }: BotFactoryIconProps) {
  return (
    <IconFrame size={size} className={className}>
      <path d={TAB_CHROME} />
      <path d="M8.2 10.6 H15.8" />
      <path d="M8.2 13 H15.8" />
      <path d="M8.2 15.4 H12.8" />
    </IconFrame>
  );
}

/** Image artifact tab. */
export function ImageTabIcon({ size, className }: BotFactoryIconProps) {
  return (
    <IconFrame size={size} className={className}>
      <path d={TAB_CHROME} />
      <circle cx="9.4" cy="10.4" r="1.2" />
      <path d="M6.8 16.4 L10.1 12.9 L12 14.7 L14.2 12.6 L17.4 16" />
    </IconFrame>
  );
}

/** 3D model artifact tab — isometric cube. */
export function Cube3DTabIcon({ size, className }: BotFactoryIconProps) {
  return (
    <IconFrame size={size} className={className}>
      <path d={TAB_CHROME} />
      <path d="M12 9.2 L15.5 11.1 V15 L12 16.9 L8.5 15 V11.1 Z" />
      <path d="M8.5 11.1 L12 13 L15.5 11.1" />
      <path d="M12 13 V16.9" />
    </IconFrame>
  );
}

/** Web preview artifact tab — globe. */
export function WebTabIcon({ size, className }: BotFactoryIconProps) {
  return (
    <IconFrame size={size} className={className}>
      <path d={TAB_CHROME} />
      <circle cx="12" cy="13" r="4.7" />
      <path d="M7.3 13 H16.7" />
      <path d="M12 8.3 C10.2 10.1 10.2 15.9 12 17.7 C13.8 15.9 13.8 10.1 12 8.3 Z" />
    </IconFrame>
  );
}

/** "New" / plus tab. */
export function PlusTabIcon({ size, className }: BotFactoryIconProps) {
  return (
    <IconFrame size={size} className={className}>
      <path d={TAB_CHROME} />
      <path d="M12 10.2 V15.8" />
      <path d="M9.2 13 H14.8" />
    </IconFrame>
  );
}

/** Expand pane outward (both diagonal corners). */
export function ExpandPaneIcon({ size, className }: BotFactoryIconProps) {
  return (
    <IconFrame size={size} className={className}>
      <path d="M13.5 4.5 H19.5 V10.5" />
      <path d="M19.5 4.5 L12.3 11.7" />
      <path d="M10.5 19.5 H4.5 V13.5" />
      <path d="M4.5 19.5 L11.7 12.3" />
    </IconFrame>
  );
}

/** Annotation pin / pinned comment marker. */
export function PinCommentIcon({ size, className }: BotFactoryIconProps) {
  return (
    <IconFrame size={size} className={className}>
      <path d="M12 3.8 C8.7 3.8 6.2 6.3 6.2 9.5 C6.2 13.3 10.4 17.3 12 18.8 C13.6 17.3 17.8 13.3 17.8 9.5 C17.8 6.3 15.3 3.8 12 3.8 Z" />
      <circle cx="12" cy="9.4" r="1.9" />
      <path d="M12 18.8 L12 20.4" />
    </IconFrame>
  );
}
