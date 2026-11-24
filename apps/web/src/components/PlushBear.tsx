import { useId, type JSX } from "react";
import type { BearAvatarStatus, BotRoleKind } from "./BotAvatars";

interface PlushPalette {
  fur: string;
  furLight: string;
  furDark: string;
  innerEar: string;
  muzzle: string;
  accent: string;
  accentDark: string;
}

const PLUSH_PALETTES: Record<BotRoleKind, PlushPalette> = {
  orchestrator: {
    fur: "#8f5c32",
    furLight: "#ad7847",
    furDark: "#6c4224",
    innerEar: "#e4b984",
    muzzle: "#f2ddbd",
    accent: "#e5a92f",
    accentDark: "#8f6418",
  },
  team_lead: {
    fur: "#48694f",
    furLight: "#618464",
    furDark: "#334b38",
    innerEar: "#b9cfae",
    muzzle: "#e7dbc0",
    accent: "#55b87a",
    accentDark: "#2c6c47",
  },
  builder: {
    fur: "#47667f",
    furLight: "#5f819a",
    furDark: "#314a5e",
    innerEar: "#b5cadd",
    muzzle: "#e6dabd",
    accent: "#55a7e8",
    accentDark: "#2a638f",
  },
  artist_3d: {
    fur: "#6e4f76",
    furLight: "#89688e",
    furDark: "#503853",
    innerEar: "#cfb6d5",
    muzzle: "#eadbc3",
    accent: "#a967e8",
    accentDark: "#65409a",
  },
  research: {
    fur: "#406f68",
    furLight: "#578a80",
    furDark: "#2d504b",
    innerEar: "#b4d4c9",
    muzzle: "#e5dcc0",
    accent: "#35bcae",
    accentDark: "#1d7068",
  },
  verifier: {
    fur: "#784854",
    furLight: "#92606b",
    furDark: "#57333d",
    innerEar: "#d3b4bc",
    muzzle: "#e9d8bf",
    accent: "#e35062",
    accentDark: "#8e2e3a",
  },
  cub: {
    fur: "#9a6a3e",
    furLight: "#b98553",
    furDark: "#704b2c",
    innerEar: "#e5c097",
    muzzle: "#f2dfbf",
    accent: "#d79a42",
    accentDark: "#8c6126",
  },
};

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function BearAccessory({ role, palette }: { role: BotRoleKind; palette: PlushPalette }): JSX.Element | null {
  switch (role) {
    case "orchestrator":
      return (
        <g className="bear-accessory bear-gantry-module">
          <path d="M28 25 C34 9 66 9 72 25" fill="none" stroke={palette.accentDark} strokeWidth="5" strokeLinecap="round" />
          <rect x="24" y="20" width="7" height="12" rx="2.5" fill={palette.accentDark} />
          <rect x="69" y="20" width="7" height="12" rx="2.5" fill={palette.accentDark} />
          <rect x="43" y="7" width="14" height="11" rx="3" fill={palette.accentDark} />
          <path d="M50 18 V27" stroke={palette.accentDark} strokeWidth="3" strokeLinecap="round" />
          <circle cx="50" cy="28" r="3" fill={palette.accent} />
        </g>
      );
    case "team_lead":
      return (
        <g className="bear-accessory bear-radio-module">
          <rect x="16" y="11" width="20" height="13" rx="5" fill="#26302b" transform="rotate(-13 26 18)" />
          <path d="M23 13 L16 2" stroke="#26302b" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M30 12 L31 1" stroke="#26302b" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="31" cy="17" r="2.6" fill={palette.accent} />
          <circle cx="16" cy="2" r="1.7" fill={palette.accent} opacity="0.85" />
        </g>
      );
    case "builder":
      return (
        <g className="bear-accessory bear-clamp-module">
          <path
            d="M25 35 C28 18 38 10 50 10 C62 10 72 18 75 35 L68 38 C65 27 59 21 50 21 C41 21 35 27 32 38 Z"
            fill={palette.accentDark}
          />
          <rect x="29" y="29" width="42" height="7" rx="3.5" fill={palette.accent} />
          <rect x="57" y="16" width="13" height="12" rx="2.5" fill={palette.accentDark} opacity="0.88" />
          <circle cx="61" cy="20" r="1.2" fill="#f2d69b" />
          <circle cx="66" cy="20" r="1.2" fill="#f2d69b" />
          <path d="M34 32 H45" stroke="#eaf6ff" strokeWidth="2.2" strokeLinecap="round" opacity="0.9" />
        </g>
      );
    case "artist_3d":
      return (
        <g className="bear-accessory bear-mesh-module">
          <path d="M29 27 L39 9 L48 25 Z" fill={palette.accentDark} />
          <path d="M39 9 L56 8 L48 25 Z" fill={palette.accent} />
          <path d="M48 25 L56 8 L64 24 Z" fill={palette.accentDark} opacity="0.92" />
          <path d="M39 9 L48 25 M56 8 L48 25" stroke="#f0e5ff" strokeWidth="1.4" opacity="0.45" />
          <circle cx="48" cy="25" r="2" fill={palette.accent} />
        </g>
      );
    case "research":
      return (
        <g className="bear-accessory bear-scan-module">
          <path d="M70 29 L62 36" stroke={palette.accentDark} strokeWidth="4" strokeLinecap="round" />
          <circle cx="79" cy="22" r="12" fill={palette.accentDark} />
          <circle cx="79" cy="22" r="8" fill={palette.accent} />
          <circle cx="79" cy="22" r="3.4" fill="#10201e" />
          <circle cx="81" cy="19" r="1.5" fill="#d9fffa" opacity="0.9" />
        </g>
      );
    case "verifier":
      return (
        <g className="bear-accessory bear-gauge-module" fill="none" strokeLinecap="round">
          <path d="M69 28 L75 37" stroke={palette.accentDark} strokeWidth="3.5" />
          <rect x="67" y="38" width="20" height="20" rx="4" stroke={palette.accent} strokeWidth="3.6" />
          <path d="M77 41 V55 M70 48 H84" stroke={palette.accent} strokeWidth="1.5" opacity="0.65" />
          <circle cx="83" cy="42" r="2" fill={palette.accent} stroke="none" />
        </g>
      );
    case "cub":
      return null;
  }
}

export function PlushBearBody({ role }: { role: BotRoleKind }): JSX.Element {
  const uid = useId().replace(/:/g, "");
  const palette = PLUSH_PALETTES[role];
  const furGrad = `plush-fur-${uid}`;
  const muzzleGrad = `plush-muzzle-${uid}`;
  return (
    <svg className="bear-plush-body" width="100%" height="100%" viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <radialGradient id={furGrad} cx="35%" cy="23%" r="82%">
          <stop offset="0%" stopColor={palette.furLight} />
          <stop offset="64%" stopColor={palette.fur} />
          <stop offset="100%" stopColor={palette.furDark} />
        </radialGradient>
        <radialGradient id={muzzleGrad} cx="42%" cy="28%" r="78%">
          <stop offset="0%" stopColor="#fff0d8" />
          <stop offset="100%" stopColor={palette.muzzle} />
        </radialGradient>
      </defs>
      <ellipse cx="50" cy="92" rx="33" ry="5.5" fill="#000000" opacity="0.16" />
      <circle cx="22" cy="23" r="14.5" fill={`url(#${furGrad})`} />
      <circle cx="78" cy="23" r="14.5" fill={`url(#${furGrad})`} />
      <circle cx="22" cy="23" r="7.6" fill={palette.innerEar} opacity="0.95" />
      <circle cx="78" cy="23" r="7.6" fill={palette.innerEar} opacity="0.95" />
      <path
        d="M50 15 C69 15 86 29 88 49 C90 70 79 88 59 92 C54 93 46 93 41 92 C21 88 10 70 12 49 C14 29 31 15 50 15 Z"
        fill={`url(#${furGrad})`}
      />
      <path d="M25 69 C29 73 34 75 39 75" stroke={palette.furDark} strokeWidth="1.5" strokeLinecap="round" opacity="0.28" fill="none" />
      <path d="M75 69 C71 73 66 75 61 75" stroke={palette.furDark} strokeWidth="1.5" strokeLinecap="round" opacity="0.28" fill="none" />
      <rect x="31" y="55" width="38" height="23" rx="11.5" fill={`url(#${muzzleGrad})`} />
      <rect x="44" y="56" width="12" height="8.5" rx="4.2" fill="#20130e" />
      <circle cx="47.6" cy="58.3" r="1.1" fill="#ffffff" opacity="0.38" />
      <path d="M50 64.2 C50 66.7 47.8 68 45.8 67.5" stroke="#2a1a13" strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M50 64.2 C50 66.7 52.2 68 54.2 67.5" stroke="#2a1a13" strokeWidth="2" strokeLinecap="round" fill="none" />
      <BearAccessory role={role} palette={palette} />
    </svg>
  );
}

export function BearEyeRig({
  role,
  status,
  seed,
}: {
  role: BotRoleKind;
  status: BearAvatarStatus;
  seed?: string;
}): JSX.Element {
  const h = hashSeed(seed || role);
  const blinkDelay = `${(-((h % 41) * 0.11)).toFixed(2)}s`;
  const glanceDelay = `${(-((h % 29) * 0.17)).toFixed(2)}s`;
  const eyes: Array<[number, number, "left" | "right"]> = [
    [36, 46, "left"],
    [64, 46, "right"],
  ];
  const hasGaugeLens = role === "verifier";

  return (
    <svg
      className="bear-eye-rig"
      width="100%"
      height="100%"
      viewBox="0 0 100 100"
      aria-hidden="true"
    >
      {hasGaugeLens && status !== "error" && (
        <g className="bear-shades-gleam" style={{ animationDelay: blinkDelay }}>
          <path d="M70 55 L82 41" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" opacity="0.68" />
        </g>
      )}
      {eyes.map(([cx, cy, side]) => {
        if (status === "done") {
          return (
            <g key={side} className="bear-eye-happy">
              <path
                d={`M ${cx - 5} ${cy + 1.1} Q ${cx} ${cy - 5.4} ${cx + 5} ${cy + 1.1}`}
                stroke="#17100c"
                strokeWidth="3.2"
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
                d={`M ${cx - 3.8 * dir} ${cy - 3} L ${cx + 3.3 * dir} ${cy} L ${cx - 3.8 * dir} ${cy + 3}`}
                stroke="#17100c"
                strokeWidth="2.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </g>
          );
        }

        const eyeRx = status === "waiting" ? 6.8 : 6.1;
        const eyeRy = status === "waiting" ? 8.1 : 7.35;
        const catchR = status === "waiting" ? 2.25 : 2.05;

        return (
          <g key={side} className="bear-eye-group" style={{ animationDelay: blinkDelay }}>
            <rect
              x={cx - eyeRx}
              y={cy - eyeRy}
              width={eyeRx * 2}
              height={eyeRy * 2}
              rx={eyeRx}
              fill="#120c08"
              stroke="#f0dcbe"
              strokeOpacity="0.2"
              strokeWidth="0.8"
            />
            <g className="bear-eye-glance" style={{ animationDelay: glanceDelay }}>
              <circle cx={cx + 1.9} cy={cy - 2.35} r={catchR} fill="#fff7e8" />
              <circle cx={cx - 1.75} cy={cy + 2.25} r={0.95} fill="#fff7e8" opacity="0.7" />
            </g>
          </g>
        );
      })}
    </svg>
  );
}
