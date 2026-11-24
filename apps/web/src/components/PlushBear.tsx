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

interface EarShape {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

interface RoleShape {
  headPath: string;
  leftEar: EarShape;
  rightEar: EarShape;
  muzzle: { x: number; y: number; width: number; height: number; rx: number };
  noseY: number;
  mouthY: number;
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

const ROLE_SHAPES: Record<BotRoleKind, RoleShape> = {
  orchestrator: {
    headPath: "M50 15 C69 15 86 29 88 49 C90 70 79 88 59 92 C54 93 46 93 41 92 C21 88 10 70 12 49 C14 29 31 15 50 15 Z",
    leftEar: { cx: 22, cy: 23, rx: 14.5, ry: 14.5 },
    rightEar: { cx: 78, cy: 23, rx: 14.5, ry: 14.5 },
    muzzle: { x: 31, y: 55, width: 38, height: 23, rx: 11.5 },
    noseY: 56,
    mouthY: 64.2,
  },
  team_lead: {
    headPath: "M50 13 C68 13 84 28 86 48 C88 68 78 86 60 91 C54 93 46 93 40 91 C22 86 12 68 14 48 C16 28 32 13 50 13 Z",
    leftEar: { cx: 20, cy: 22, rx: 15.5, ry: 15.5 },
    rightEar: { cx: 80, cy: 22, rx: 15.5, ry: 15.5 },
    muzzle: { x: 32, y: 56, width: 36, height: 21, rx: 10.5 },
    noseY: 57,
    mouthY: 65,
  },
  builder: {
    headPath: "M50 16 C69 16 85 30 87 49 C89 68 80 85 62 90 C55 93 45 93 38 90 C20 85 11 68 13 49 C15 30 31 16 50 16 Z",
    leftEar: { cx: 24, cy: 25, rx: 12.5, ry: 13.5 },
    rightEar: { cx: 76, cy: 25, rx: 12.5, ry: 13.5 },
    muzzle: { x: 29, y: 55, width: 42, height: 23, rx: 9 },
    noseY: 56,
    mouthY: 64.2,
  },
  artist_3d: {
    headPath: "M50 15 C68 14 85 28 88 48 C91 69 79 87 60 91 C53 93 45 92 39 90 C21 86 11 69 13 49 C15 30 30 16 50 15 Z",
    leftEar: { cx: 21, cy: 22, rx: 16, ry: 14 },
    rightEar: { cx: 79, cy: 25, rx: 12.5, ry: 13.5 },
    muzzle: { x: 33, y: 56, width: 34, height: 21, rx: 12 },
    noseY: 57,
    mouthY: 65,
  },
  research: {
    headPath: "M50 13 C70 13 87 28 89 49 C91 71 79 89 59 93 C54 94 46 94 41 93 C21 89 9 71 11 49 C13 28 30 13 50 13 Z",
    leftEar: { cx: 21, cy: 22, rx: 13.5, ry: 16 },
    rightEar: { cx: 79, cy: 22, rx: 13.5, ry: 16 },
    muzzle: { x: 30, y: 54, width: 40, height: 24, rx: 12.5 },
    noseY: 55,
    mouthY: 63.5,
  },
  verifier: {
    headPath: "M50 16 C67 16 83 30 86 49 C89 69 78 86 60 91 C54 93 46 93 40 91 C22 86 11 69 14 49 C17 30 33 16 50 16 Z",
    leftEar: { cx: 24, cy: 24, rx: 11.5, ry: 14 },
    rightEar: { cx: 76, cy: 24, rx: 11.5, ry: 14 },
    muzzle: { x: 32, y: 56, width: 36, height: 21, rx: 8.5 },
    noseY: 57,
    mouthY: 65,
  },
  cub: {
    headPath: "M50 17 C68 17 84 31 86 50 C88 69 78 85 60 90 C54 92 46 92 40 90 C22 85 12 69 14 50 C16 31 32 17 50 17 Z",
    leftEar: { cx: 22, cy: 25, rx: 15.5, ry: 15.5 },
    rightEar: { cx: 78, cy: 25, rx: 15.5, ry: 15.5 },
    muzzle: { x: 33, y: 57, width: 34, height: 20, rx: 12 },
    noseY: 58,
    mouthY: 65.5,
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

function BearFurDetails({ role, palette }: { role: BotRoleKind; palette: PlushPalette }): JSX.Element {
  switch (role) {
    case "orchestrator":
      return (
        <g className="bear-fur-detail" stroke={palette.furDark} strokeWidth="2" strokeLinecap="round" fill="none" opacity="0.5">
          <path d="M43 18 C45 14 47 13 50 15" />
          <path d="M50 15 C53 12 56 13 58 17" />
          <path d="M36 24 C39 20 42 19 45 21" opacity="0.65" />
        </g>
      );
    case "team_lead":
      return (
        <g className="bear-fur-detail" opacity="0.9">
          <path d="M15 52 L8 61 L17 64 L12 72 L24 68" fill={palette.fur} opacity="0.95" />
          <path d="M85 52 L92 61 L83 64 L88 72 L76 68" fill={palette.fur} opacity="0.95" />
          <g stroke={palette.furDark} strokeWidth="2.2" strokeLinecap="round" fill="none" opacity="0.58">
            <path d="M48 17 C51 10 56 9 60 13" />
            <path d="M25 67 C29 72 35 74 40 73" opacity="0.55" />
            <path d="M75 67 C71 72 65 74 60 73" opacity="0.55" />
          </g>
        </g>
      );
    case "builder":
      return (
        <g className="bear-fur-detail" stroke={palette.furDark} strokeWidth="1.9" strokeLinecap="round" fill="none" opacity="0.5">
          <path d="M27 69 L34 72 L39 69" />
          <path d="M73 69 L66 72 L61 69" />
          <path d="M42 20 H58" opacity="0.45" strokeDasharray="3 4" />
        </g>
      );
    case "artist_3d":
      return (
        <g className="bear-fur-detail" fill={palette.furDark} opacity="0.52">
          <path d="M31 18 C39 12 50 13 55 20 C47 18 40 22 34 31 C31 27 29 22 31 18 Z" />
          <path d="M16 52 L8 62 L19 65 L14 75 L27 70" fill={palette.fur} opacity="0.8" />
          <path d="M24 67 C29 73 35 75 40 73" stroke={palette.furDark} strokeWidth="1.8" strokeLinecap="round" fill="none" opacity="0.65" />
        </g>
      );
    case "research":
      return (
        <g className="bear-fur-detail" opacity="0.92">
          <path d="M14 51 L5 61 L16 64 L9 75 L24 70" fill={palette.fur} />
          <path d="M86 51 L95 61 L84 64 L91 75 L76 70" fill={palette.fur} />
          <g stroke={palette.furDark} strokeWidth="2" strokeLinecap="round" fill="none" opacity="0.58">
            <path d="M22 65 L29 70 L25 75" />
            <path d="M78 65 L71 70 L75 75" />
            <path d="M43 17 C47 13 53 13 57 17" />
          </g>
        </g>
      );
    case "verifier":
      return (
        <g className="bear-fur-detail" opacity="0.9">
          <path d="M19 51 L10 62 L20 64 L14 77 L28 69" fill={palette.fur} />
          <path d="M81 51 L90 62 L80 64 L86 77 L72 69" fill={palette.fur} />
          <g stroke={palette.furDark} strokeWidth="2.1" strokeLinecap="round" fill="none" opacity="0.58">
            <path d="M28 58 L22 68 L31 66" />
            <path d="M72 58 L78 68 L69 66" />
            <path d="M45 19 L50 15 L55 19" opacity="0.45" />
          </g>
        </g>
      );
    case "cub":
      return (
        <g className="bear-fur-detail" opacity="0.88">
          <path d="M17 56 L11 63 L20 66 L16 73 L26 69" fill={palette.fur} />
          <path d="M83 56 L89 63 L80 66 L84 73 L74 69" fill={palette.fur} />
          <g stroke={palette.furDark} strokeWidth="2" strokeLinecap="round" fill="none" opacity="0.58">
            <path d="M46 18 C46 14 48 12 50 12" />
            <path d="M50 12 C52 12 54 14 54 18" />
            <path d="M50 12 V18" />
          </g>
        </g>
      );
  }
}

function BearAccessory({ role, palette }: { role: BotRoleKind; palette: PlushPalette }): JSX.Element | null {
  switch (role) {
    case "orchestrator":
      return (
        <g className="bear-accessory bear-gantry-module">
          <path d="M27 29 C31 10 69 10 73 29 L67 32 C64 21 36 21 33 32 Z" fill={palette.accentDark} />
          <rect x="31" y="24" width="38" height="6" rx="3" fill={palette.accent} />
          <rect x="22" y="24" width="8" height="14" rx="3" fill={palette.accentDark} />
          <rect x="70" y="24" width="8" height="14" rx="3" fill={palette.accentDark} />
          <path className="bear-anim-signal" d="M50 18 V8" stroke={palette.accentDark} strokeWidth="3" strokeLinecap="round" />
          <circle className="bear-anim-signal" cx="50" cy="8" r="3.2" fill={palette.accent} />
        </g>
      );
    case "team_lead":
      return (
        <g className="bear-accessory bear-radio-module">
          <path d="M25 30 C28 14 39 8 51 8 C64 8 73 16 75 31 L67 34 C64 24 58 20 50 20 C41 20 35 25 33 34 Z" fill={palette.accentDark} />
          <rect x="27" y="27" width="46" height="7" rx="3.5" fill={palette.accent} opacity="0.95" />
          <rect x="14" y="13" width="22" height="15" rx="6" fill="#26302b" transform="rotate(-13 25 20)" />
          <path className="bear-anim-signal" d="M24 13 L16 2" stroke="#26302b" strokeWidth="2.6" strokeLinecap="round" />
          <path d="M31 12 L32 1" stroke="#26302b" strokeWidth="2.6" strokeLinecap="round" />
          <circle className="bear-anim-signal" cx="32" cy="18" r="3" fill={palette.accent} />
          <circle cx="16" cy="2" r="1.9" fill={palette.accent} opacity="0.85" />
        </g>
      );
    case "builder":
      return (
        <g className="bear-accessory bear-clamp-module">
          <path d="M22 36 C25 17 37 8 50 8 C63 8 75 17 78 36 L69 39 C66 27 59 20 50 20 C41 20 34 27 31 39 Z" fill={palette.accentDark} />
          <rect x="25" y="29" width="50" height="8" rx="4" fill={palette.accent} />
          <rect x="57" y="14" width="15" height="13" rx="3" fill={palette.accentDark} opacity="0.9" />
          <circle cx="62" cy="19" r="1.4" fill="#f2d69b" />
          <circle cx="67" cy="19" r="1.4" fill="#f2d69b" />
          <path d="M33 33 H47" stroke="#eaf6ff" strokeWidth="2.4" strokeLinecap="round" opacity="0.9" />
        </g>
      );
    case "artist_3d":
      return (
        <g className="bear-accessory bear-mesh-module">
          <path d="M30 20 C35 7 57 4 70 14 C64 22 48 26 31 25 Z" fill={palette.accentDark} />
          <ellipse cx="52" cy="17" rx="24" ry="8" fill={palette.accent} opacity="0.94" transform="rotate(-8 52 17)" />
          <circle cx="70" cy="12" r="3.1" fill={palette.accentDark} />
          <g className="bear-anim-prism">
            <path d="M28 31 L38 13 L47 29 Z" fill={palette.accentDark} opacity="0.95" />
            <path d="M38 13 L55 12 L47 29 Z" fill={palette.accent} />
            <path d="M38 13 L47 29 M55 12 L47 29" stroke="#f0e5ff" strokeWidth="1.4" opacity="0.48" />
          </g>
        </g>
      );
    case "research":
      return (
        <g className="bear-accessory bear-scan-module">
          <g className="bear-anim-spyglass" transform="rotate(-22 74 17)">
            <rect x="57" y="10" width="34" height="12" rx="5" fill={palette.accentDark} />
            <rect x="70" y="10" width="8" height="12" fill={palette.accent} opacity="0.95" />
            <circle cx="90" cy="16" r="7" fill={palette.accentDark} />
            <circle cx="90" cy="16" r="4.4" fill="#9ff7ed" opacity="0.9" />
            <circle cx="91.5" cy="13.8" r="1.2" fill="#ffffff" opacity="0.8" />
          </g>
          <path d="M67 24 L61 34" stroke={palette.accentDark} strokeWidth="3.5" strokeLinecap="round" />
        </g>
      );
    case "verifier":
      return (
        <g className="bear-accessory bear-gauge-module" fill="none" strokeLinecap="round">
          <path d="M25 30 C29 16 39 10 50 10 C61 10 71 16 75 30 L68 33 C65 24 58 20 50 20 C42 20 35 24 32 33 Z" fill={palette.accentDark} stroke="none" />
          <rect x="33" y="27" width="34" height="6" rx="3" fill={palette.accent} stroke="none" opacity="0.95" />
          <path d="M54 68 L66 65" stroke="#5b321d" strokeWidth="5" />
          <path d="M64 65.5 L69 64.5" stroke="#2a160d" strokeWidth="5" />
          <circle className="bear-anim-gauge" cx="69" cy="64.5" r="2.4" fill="#e78945" stroke="none" />
        </g>
      );
    case "cub":
      return (
        <g className="bear-accessory bear-beanie-module">
          <path d="M31 27 C34 14 43 9 51 9 C61 9 69 16 70 28 L64 31 C61 23 56 20 50 20 C43 20 38 23 36 31 Z" fill={palette.accentDark} />
          <rect x="32" y="25" width="37" height="7" rx="3.5" fill={palette.accent} />
          <circle className="bear-anim-signal" cx="52" cy="8" r="4" fill={palette.accent} />
        </g>
      );
  }
}

export function PlushBearBody({ role }: { role: BotRoleKind }): JSX.Element {
  const uid = useId().replace(/:/g, "");
  const palette = PLUSH_PALETTES[role];
  const shape = ROLE_SHAPES[role];
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
      <ellipse cx={shape.leftEar.cx} cy={shape.leftEar.cy} rx={shape.leftEar.rx} ry={shape.leftEar.ry} fill={`url(#${furGrad})`} />
      <ellipse cx={shape.rightEar.cx} cy={shape.rightEar.cy} rx={shape.rightEar.rx} ry={shape.rightEar.ry} fill={`url(#${furGrad})`} />
      <ellipse cx={shape.leftEar.cx} cy={shape.leftEar.cy} rx={shape.leftEar.rx * 0.53} ry={shape.leftEar.ry * 0.53} fill={palette.innerEar} opacity="0.95" />
      <ellipse cx={shape.rightEar.cx} cy={shape.rightEar.cy} rx={shape.rightEar.rx * 0.53} ry={shape.rightEar.ry * 0.53} fill={palette.innerEar} opacity="0.95" />
      <path d={shape.headPath} fill={`url(#${furGrad})`} />
      <BearFurDetails role={role} palette={palette} />
      <rect
        x={shape.muzzle.x}
        y={shape.muzzle.y}
        width={shape.muzzle.width}
        height={shape.muzzle.height}
        rx={shape.muzzle.rx}
        fill={`url(#${muzzleGrad})`}
      />
      <rect x="44" y={shape.noseY} width="12" height="8.5" rx="4.2" fill="#20130e" />
      <circle cx="47.6" cy={shape.noseY + 2.3} r="1.1" fill="#ffffff" opacity="0.38" />
      <path d={`M50 ${shape.mouthY} C50 ${shape.mouthY + 2.5} 47.8 ${shape.mouthY + 3.8} 45.8 ${shape.mouthY + 3.3}`} stroke="#2a1a13" strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d={`M50 ${shape.mouthY} C50 ${shape.mouthY + 2.5} 52.2 ${shape.mouthY + 3.8} 54.2 ${shape.mouthY + 3.3}`} stroke="#2a1a13" strokeWidth="2" strokeLinecap="round" fill="none" />
      <BearAccessory role={role} palette={palette} />
    </svg>
  );
}

function BearEyewear({ role }: { role: BotRoleKind }): JSX.Element | null {
  switch (role) {
    case "orchestrator":
      return (
        <g className="bear-eyewear" fill="none" stroke="#e5a92f" strokeWidth="2.1" strokeLinecap="round" opacity="0.92">
          <circle cx="36" cy="46" r="8.8" />
          <circle cx="64" cy="46" r="8.8" />
          <path d="M44.8 46 H55.2" />
          <path d="M27.5 44 L20 39 M72.5 44 L80 39" />
        </g>
      );
    case "builder":
      return (
        <g className="bear-eyewear" fill="rgb(85 167 232 / 0.12)" stroke="#55a7e8" strokeWidth="2.4" strokeLinejoin="round" opacity="0.9">
          <rect x="24" y="35" width="52" height="22" rx="9" />
          <path d="M48 35 V57" opacity="0.65" />
        </g>
      );
    case "research":
      return (
        <g className="bear-eyewear" fill="none" stroke="#35bcae" strokeWidth="2" strokeLinecap="round" opacity="0.9">
          <circle cx="36" cy="46" r="8.4" />
          <path d="M44 46 H52" opacity="0.55" />
          <path d="M28 43 L22 39" />
        </g>
      );
    case "verifier":
      return (
        <g className="bear-eyewear bear-anim-inspect" fill="rgb(227 80 98 / 0.06)" stroke="#e35062" strokeWidth="2.8" strokeLinecap="round" opacity="0.95">
          <circle cx="64" cy="46" r="11.5" />
          <path d="M72 55 L80 65" />
        </g>
      );
    default:
      return null;
  }
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
  const blinkDuration = `${(5.4 + (h % 7) * 0.43).toFixed(2)}s`;
  const glanceDuration = `${(7.2 + (h % 5) * 0.61).toFixed(2)}s`;
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
          <path d="M58 54 L72 39" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" opacity="0.68" />
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
          <g key={side} className="bear-eye-group" style={{ animationDelay: blinkDelay, animationDuration: blinkDuration }}>
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
            <g className="bear-eye-glance" style={{ animationDelay: glanceDelay, animationDuration: glanceDuration }}>
              <circle cx={cx + 1.9} cy={cy - 2.35} r={catchR} fill="#fff7e8" />
              <circle cx={cx - 1.75} cy={cy + 2.25} r={0.95} fill="#fff7e8" opacity="0.7" />
            </g>
          </g>
        );
      })}
      <BearEyewear role={role} />
    </svg>
  );
}
