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

interface FaceShape {
  eyeY: number;
  eyeRx: number;
  eyeRy: number;
  pupilR: number;
}

const PLUSH_PALETTES: Record<BotRoleKind, PlushPalette> = {
  orchestrator: {
    fur: "#f5a917", furLight: "#ffd45f", furDark: "#b86f00",
    innerEar: "#ffe3a3", muzzle: "#fff0c8", accent: "#fff35c", accentDark: "#5c3600",
  },
  team_lead: {
    fur: "#ffe066", furLight: "#fff29a", furDark: "#c89400",
    innerEar: "#fff8c8", muzzle: "#fff6d7", accent: "#39e75f", accentDark: "#075b2a",
  },
  builder: {
    fur: "#245bff", furLight: "#5c8cff", furDark: "#102b9c",
    innerEar: "#a9c6ff", muzzle: "#dce9ff", accent: "#ffd43b", accentDark: "#503800",
  },
  artist_3d: {
    fur: "#c78cff", furLight: "#e2bcff", furDark: "#8046c8",
    innerEar: "#efd9ff", muzzle: "#f7e9ff", accent: "#ff4fa3", accentDark: "#721348",
  },
  research: {
    fur: "#83f29b", furLight: "#b5ffc3", furDark: "#279b4e",
    innerEar: "#d8ffdf", muzzle: "#ecfff0", accent: "#ffd84d", accentDark: "#315b22",
  },
  verifier: {
    fur: "#ff8fc7", furLight: "#ffb9dc", furDark: "#c9387f",
    innerEar: "#ffd8eb", muzzle: "#ffe8f3", accent: "#ff2f68", accentDark: "#65102d",
  },
  cub: {
    fur: "#ffb85c", furLight: "#ffd98f", furDark: "#b86412",
    innerEar: "#ffe9be", muzzle: "#fff1d5", accent: "#55d6ff", accentDark: "#155d78",
  },
};

const FACE_SHAPES: Record<BotRoleKind, FaceShape> = {
  orchestrator: { eyeY: 45, eyeRx: 7.5, eyeRy: 8.4, pupilR: 2.9 },
  team_lead: { eyeY: 45, eyeRx: 7.2, eyeRy: 8.2, pupilR: 2.9 },
  builder: { eyeY: 45, eyeRx: 7.6, eyeRy: 7.8, pupilR: 3 },
  artist_3d: { eyeY: 45, eyeRx: 7.5, eyeRy: 8.1, pupilR: 2.8 },
  research: { eyeY: 45, eyeRx: 8.4, eyeRy: 8.9, pupilR: 3.1 },
  verifier: { eyeY: 45, eyeRx: 7.4, eyeRy: 6.5, pupilR: 2.8 },
  cub: { eyeY: 45, eyeRx: 8.2, eyeRy: 8.8, pupilR: 3.2 },
};

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function BearTuft({ role, palette }: { role: BotRoleKind; palette: PlushPalette }): JSX.Element {
  const common = { stroke: palette.furDark, strokeWidth: 2.2, strokeLinecap: "round" as const, fill: "none", opacity: 0.58 };
  switch (role) {
    case "builder":
      return <g className="bear-fur-detail" {...common} opacity="0.42"><path d="M39 23 H61" strokeDasharray="3 4" /></g>;
    case "artist_3d":
      return <g className="bear-fur-detail" fill={palette.furDark} opacity="0.46"><path d="M31 26 C38 18 52 17 59 25 C49 22 40 27 34 37 C31 33 30 29 31 26 Z" /></g>;
    case "research":
      return <g className="bear-fur-detail" {...common}><path d="M41 23 C45 18 55 18 59 23" /><path d="M19 65 L27 69 L22 74" /><path d="M81 65 L73 69 L78 74" /></g>;
    case "verifier":
      return <g className="bear-fur-detail" {...common}><path d="M28 60 L22 70 L31 67" /><path d="M72 60 L78 70 L69 67" /></g>;
    case "cub":
      return <g className="bear-fur-detail" {...common}><path d="M46 24 C46 20 48 18 50 18" /><path d="M50 18 C52 18 54 20 54 24" /><path d="M50 18 V24" /></g>;
    default:
      return <g className="bear-fur-detail" {...common}><path d="M42 24 C45 20 48 19 50 21" /><path d="M50 21 C53 18 56 19 58 23" /></g>;
  }
}

function BearHat({ role, palette }: { role: BotRoleKind; palette: PlushPalette }): JSX.Element {
  switch (role) {
    case "orchestrator":
      return (
        <g className="bear-accessory bear-crown-cap">
          <path d="M33 29 L35 13 L43 21 L50 8 L57 21 L65 13 L67 29 Z" fill={palette.accent} stroke={palette.accentDark} strokeWidth="2" strokeLinejoin="round" />
          <path d="M38 25 L50 13 L62 25" stroke="#ffffff" strokeWidth="1.7" strokeLinecap="round" opacity="0.34" fill="none" />
          <rect x="32" y="26" width="36" height="7" rx="3.5" fill={palette.accentDark} />
          <circle className="bear-anim-signal" cx="50" cy="8" r="3" fill="#ffffff" />
        </g>
      );
    case "team_lead":
      return (
        <g className="bear-accessory bear-radio-cap">
          <path d="M34 30 C35 16 42 9 50 9 C59 9 66 16 67 30 L62 33 C60 25 56 21 50 21 C44 21 40 25 38 33 Z" fill={palette.accentDark} />
          <path d="M39 15 C43 11 50 10 56 13" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" opacity="0.22" fill="none" />
          <rect x="33" y="27" width="34" height="7" rx="3.5" fill={palette.accent} />
          <path className="bear-anim-signal" d="M41 16 L34 5" stroke={palette.accentDark} strokeWidth="2.8" strokeLinecap="round" />
          <circle className="bear-anim-signal" cx="34" cy="5" r="3.1" fill={palette.accent} />
          <circle cx="61" cy="25" r="2.7" fill="#efffe9" opacity="0.9" />
        </g>
      );
    case "builder":
      return (
        <g className="bear-accessory bear-hard-hat">
          <path d="M32 31 C33 16 41 8 50 8 C59 8 67 16 68 31 L63 34 C61 25 56 20 50 20 C44 20 39 25 37 34 Z" fill={palette.accent} stroke={palette.accentDark} strokeWidth="2" />
          <rect x="29" y="28" width="42" height="7" rx="3.5" fill={palette.accent} stroke={palette.accentDark} strokeWidth="1.7" />
          <rect x="46" y="8" width="8" height="23" rx="3.5" fill="#fff0a3" opacity="0.72" />
          <path d="M36 17 C40 12 46 10 52 11" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" opacity="0.3" fill="none" />
          <circle cx="61" cy="20" r="2" fill="#fff8c7" />
        </g>
      );
    case "artist_3d":
      return (
        <g className="bear-accessory bear-beret">
          <path d="M34 23 C39 10 56 6 67 13 C63 22 50 27 34 27 Z" fill={palette.accentDark} />
          <ellipse cx="51" cy="16" rx="19" ry="7.5" fill={palette.accent} transform="rotate(-8 51 16)" />
          <ellipse cx="46" cy="13" rx="9" ry="2.4" fill="#ffffff" opacity="0.22" transform="rotate(-8 46 13)" />
          <path d="M51 9 C52 6 55 5 57 7" stroke={palette.accentDark} strokeWidth="2.8" strokeLinecap="round" fill="none" />
          <circle className="bear-anim-prism" cx="67" cy="15" r="3" fill="#fff0f8" />
        </g>
      );
    case "research":
      return (
        <g className="bear-accessory bear-explorer-hat">
          <path d="M34 30 C35 16 42 9 50 9 C58 9 65 16 66 30 L61 33 C59 25 55 21 50 21 C45 21 41 25 39 33 Z" fill={palette.accent} stroke={palette.accentDark} strokeWidth="2" />
          <rect x="30" y="27" width="40" height="7" rx="3.5" fill={palette.accent} stroke={palette.accentDark} strokeWidth="1.7" />
          <path d="M39 15 C44 11 52 10 58 14" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" opacity="0.28" fill="none" />
          <path className="bear-anim-spyglass" d="M62 20 L74 11" stroke={palette.accentDark} strokeWidth="4.4" strokeLinecap="round" />
          <circle className="bear-anim-spyglass" cx="76" cy="10" r="4.5" fill="#9ff7ed" stroke={palette.accentDark} strokeWidth="1.8" />
        </g>
      );
    case "verifier":
      return (
        <g className="bear-accessory bear-fedora">
          <path d="M35 28 C36 15 42 9 50 9 C58 9 64 15 65 28 Z" fill={palette.accentDark} />
          <path d="M39 14 C44 10 53 10 59 14" stroke="#ffffff" strokeWidth="1.9" strokeLinecap="round" opacity="0.2" fill="none" />
          <rect x="30" y="25" width="40" height="7" rx="3.5" fill={palette.accent} stroke={palette.accentDark} strokeWidth="1.7" />
          <rect x="36" y="21" width="28" height="5" fill="#ffd84d" opacity="0.92" />
        </g>
      );
    case "cub":
      return (
        <g className="bear-accessory bear-cub-beanie">
          <path d="M34 29 C36 15 43 9 51 9 C59 9 65 15 66 29 L61 32 C59 24 55 20 50 20 C45 20 41 24 39 32 Z" fill={palette.accentDark} />
          <path d="M40 15 C44 11 52 10 58 14" stroke="#ffffff" strokeWidth="1.9" strokeLinecap="round" opacity="0.22" fill="none" />
          <rect x="35" y="26" width="31" height="7" rx="3.5" fill={palette.accent} />
          <circle className="bear-anim-signal" cx="51" cy="8" r="3.7" fill={palette.accent} />
        </g>
      );
  }
}

function BearMouth({ role }: { role: BotRoleKind }): JSX.Element {
  const stroke = "#160d09";
  switch (role) {
    case "team_lead":
      return <path d="M41 68 Q50 75 59 68" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" fill="none" />;
    case "builder":
      return <path d="M42 69 H53 Q57 69 59 66" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" fill="none" />;
    case "artist_3d":
      return <path d="M42 68 Q50 72 59 66 Q55 73 48 73" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" fill="none" />;
    case "research":
      return <g><ellipse cx="50" cy="69" rx="5" ry="6" fill={stroke} /><ellipse cx="50" cy="71" rx="2.4" ry="2.2" fill="#ff6f91" opacity="0.8" /></g>;
    case "verifier":
      return <path d="M43 69 Q50 67 57 69" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" fill="none" />;
    case "cub":
      return <path d="M42 67 Q50 76 58 67" stroke={stroke} strokeWidth="2.6" strokeLinecap="round" fill="none" />;
    default:
      return <path d="M42 68 Q50 73 58 68" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" fill="none" />;
  }
}

function BearExpressionDetails({ role, palette }: { role: BotRoleKind; palette: PlushPalette }): JSX.Element | null {
  switch (role) {
    case "team_lead":
      return <g className="bear-expression-detail" stroke="#160d09" strokeWidth="3" strokeLinecap="round" fill="none"><path d="M27 35 L42 31" /><path d="M73 35 L58 31" /></g>;
    case "builder":
      return <g className="bear-expression-detail" stroke="#160d09" strokeWidth="3" strokeLinecap="round" fill="none"><path d="M28 34 H42" /><path d="M58 34 H72" /></g>;
    case "artist_3d":
      return (
        <g className="bear-expression-detail">
          <path d="M56 36 C62 32 71 32 76 38 L76 43 L56 43 Z" fill={palette.fur} opacity="0.82" />
          <path d="M28 34 C34 31 40 31 44 35" stroke="#160d09" strokeWidth="2.5" strokeLinecap="round" fill="none" />
        </g>
      );
    case "verifier":
      return <g className="bear-expression-detail" stroke="#160d09" strokeWidth="3" strokeLinecap="round" fill="none"><path d="M28 34 L43 37" /><path d="M72 34 L57 37" /></g>;
    case "research":
      return <g className="bear-expression-detail" stroke="#160d09" strokeWidth="2.3" strokeLinecap="round" fill="none" opacity="0.8"><path d="M29 34 C34 30 40 30 44 34" /><path d="M56 34 C60 30 66 30 71 34" /></g>;
    default:
      return null;
  }
}

export function PlushBearBody({ role }: { role: BotRoleKind }): JSX.Element {
  const uid = useId().replace(/:/g, "");
  const palette = PLUSH_PALETTES[role];
  const furGrad = `plush-fur-${uid}`;
  const muzzleGrad = `plush-muzzle-${uid}`;
  const headClip = `plush-head-${uid}`;
  return (
    <svg className="bear-plush-body" width="100%" height="100%" viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <radialGradient id={furGrad} cx="35%" cy="22%" r="82%">
          <stop offset="0%" stopColor={palette.furLight} />
          <stop offset="58%" stopColor={palette.fur} />
          <stop offset="100%" stopColor={palette.furDark} />
        </radialGradient>
        <radialGradient id={muzzleGrad} cx="42%" cy="28%" r="78%">
          <stop offset="0%" stopColor="#fffdf4" />
          <stop offset="100%" stopColor={palette.muzzle} />
        </radialGradient>
        <clipPath id={headClip}>
          <circle cx="50" cy="54" r="39" />
        </clipPath>
      </defs>
      <ellipse cx="50" cy="93" rx="34" ry="5" fill="#000000" opacity="0.28" />
      <circle cx="22" cy="25" r="15" fill={`url(#${furGrad})`} stroke="#090909" strokeWidth="2" />
      <circle cx="78" cy="25" r="15" fill={`url(#${furGrad})`} stroke="#090909" strokeWidth="2" />
      <ellipse cx="18" cy="20" rx="5" ry="6" fill="#ffffff" opacity="0.14" />
      <ellipse cx="82" cy="20" rx="5" ry="6" fill="#ffffff" opacity="0.14" />
      <circle cx="22" cy="25" r="7.6" fill={palette.innerEar} />
      <circle cx="78" cy="25" r="7.6" fill={palette.innerEar} />
      <circle cx="50" cy="54" r="39" fill={`url(#${furGrad})`} stroke="#090909" strokeWidth="2.4" />
      <g clipPath={`url(#${headClip})`}>
        <ellipse cx="36" cy="31" rx="24" ry="17" fill="#ffffff" opacity="0.18" />
        <ellipse cx="65" cy="76" rx="30" ry="22" fill="#000000" opacity="0.13" />
        <path d="M17 58 C22 80 35 91 56 91 C75 91 87 78 90 60 C84 79 70 86 50 86 C31 86 21 75 17 58 Z" fill="#000000" opacity="0.1" />
        <path d="M24 36 C30 24 40 18 52 17" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" opacity="0.16" fill="none" />
      </g>
      <BearTuft role={role} palette={palette} />
      <ellipse cx="50" cy="68" rx="21" ry="15" fill={`url(#${muzzleGrad})`} stroke="#090909" strokeWidth="1.2" opacity="0.98" />
      <ellipse cx="50" cy="75" rx="15" ry="5" fill="#000000" opacity="0.06" />
      <rect x="44" y="58" width="12" height="8.5" rx="4.2" fill="#120b08" />
      <circle cx="47.6" cy="60.3" r="1.1" fill="#ffffff" opacity="0.42" />
      <BearMouth role={role} />
      <BearHat role={role} palette={palette} />
    </svg>
  );
}

function BearEyewear({ role }: { role: BotRoleKind }): JSX.Element | null {
  switch (role) {
    case "builder":
      return (
        <g className="bear-eyewear" fill="rgb(255 255 255 / 0.08)" stroke="#ffd43b" strokeWidth="2.5" strokeLinejoin="round" opacity="0.95">
          <rect x="24" y="35" width="52" height="21" rx="9" />
          <path d="M49 35 V56" opacity="0.7" />
        </g>
      );
    case "research":
      return (
        <g className="bear-eyewear" fill="none" stroke="#fff7c0" strokeWidth="2" strokeLinecap="round" opacity="0.95">
          <circle cx="36" cy="45" r="9" />
          <path d="M45 45 H53" opacity="0.6" />
        </g>
      );
    case "verifier":
      return (
        <g className="bear-eyewear bear-anim-inspect" fill="rgb(255 255 255 / 0.08)" stroke="#ff2f68" strokeWidth="2.8" strokeLinecap="round" opacity="0.96">
          <circle cx="64" cy="45" r="11.5" />
          <path d="M72 54 L80 64" />
        </g>
      );
    case "orchestrator":
      return (
        <g className="bear-eyewear" fill="none" stroke="#fff35c" strokeWidth="2.2" strokeLinecap="round" opacity="0.94">
          <circle cx="36" cy="45" r="8.8" />
          <circle cx="64" cy="45" r="8.8" />
          <path d="M44.8 45 H55.2" />
        </g>
      );
    default:
      return null;
  }
}

export function BearEyeRig({ role, status, seed }: { role: BotRoleKind; status: BearAvatarStatus; seed?: string }): JSX.Element {
  const palette = PLUSH_PALETTES[role];
  const face = FACE_SHAPES[role];
  const h = hashSeed(seed || role);
  const blinkDelay = `${(-((h % 41) * 0.11)).toFixed(2)}s`;
  const glanceDelay = `${(-((h % 29) * 0.17)).toFixed(2)}s`;
  const blinkDuration = `${(4.8 + (h % 7) * 0.43).toFixed(2)}s`;
  const glanceDuration = `${(2.7 + (h % 5) * 0.31).toFixed(2)}s`;
  const eyes: Array<[number, number, "left" | "right"]> = [
    [36, face.eyeY, "left"],
    [64, face.eyeY, "right"],
  ];

  return (
    <svg className="bear-eye-rig" width="100%" height="100%" viewBox="0 0 100 100" aria-hidden="true">
      {eyes.map(([cx, cy, side]) => {
        if (status === "done") {
          return <g key={side} className="bear-eye-happy"><path d={`M ${cx - 5} ${cy + 1.1} Q ${cx} ${cy - 5.4} ${cx + 5} ${cy + 1.1}`} stroke="#100906" strokeWidth="3.2" strokeLinecap="round" fill="none" /></g>;
        }
        if (status === "error") {
          const dir = side === "left" ? 1 : -1;
          return <g key={side} className="bear-eye-error"><path d={`M ${cx - 3.8 * dir} ${cy - 3} L ${cx + 3.3 * dir} ${cy} L ${cx - 3.8 * dir} ${cy + 3}`} stroke="#100906" strokeWidth="2.9" strokeLinecap="round" strokeLinejoin="round" fill="none" /></g>;
        }
        const wide = status === "waiting" ? 1.1 : 1;
        return (
          <g key={side} className="bear-eye-group" style={{ animationDelay: blinkDelay, animationDuration: blinkDuration }}>
            <ellipse cx={cx} cy={cy} rx={face.eyeRx * wide} ry={face.eyeRy * wide} fill="#fff8ec" stroke="#100906" strokeWidth="1.7" />
            <g className={`bear-eye-glance bear-eye-glance-${side}`} style={{ animationDelay: glanceDelay, animationDuration: glanceDuration }}>
              <circle cx={cx + 0.7} cy={cy + 0.5} r={face.pupilR} fill="#08070a" />
              <circle cx={cx + 1.7} cy={cy - 1.1} r={Math.max(0.9, face.pupilR * 0.36)} fill="#ffffff" />
            </g>
          </g>
        );
      })}
      <BearExpressionDetails role={role} palette={palette} />
      <BearEyewear role={role} />
    </svg>
  );
}
