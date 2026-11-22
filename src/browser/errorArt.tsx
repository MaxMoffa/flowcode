// The doodles of the in-app browser's own pages (new tab, server down, offline...). Vector, one shape per page.
// Colours come from the theme's CSS variables so the light palettes work; the motion classes live in
// browser-status.css and stop under prefers-reduced-motion.
import type { ReactElement } from "react";

const INK = "var(--fg)";
const MUT = "var(--fg-muted)";
const WATER = "var(--ansi-blue)";
const G1 = "var(--ansi-green)";
const G2 = "var(--ansi-bright-green)";
const DARK = "var(--bg)";
const WAIT = "var(--ansi-yellow)";
const DANGER = "var(--ansi-red)";
const SURF = "var(--sidebar-hover)";
const WHITE = "#f4efe6";

export type ArtId = "newtab" | "local" | "offline" | "timeout" | "cert" | "blocked" | "crash";

function Frog({ x, y, s = 1, eyes = "open" }: { x: number; y: number; s?: number; eyes?: "open" | "x" }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <ellipse cx="0" cy="0" rx="16" ry="11" fill={G1} />
      <ellipse cx="0" cy="3" rx="10" ry="6" fill={G2} />
      <circle cx="-8" cy="-10" r="5.5" fill={G1} />
      <circle cx="8" cy="-10" r="5.5" fill={G1} />
      {eyes === "x" ? (
        <path d="M-10 -12 l4 4 m0 -4 l-4 4 M6 -12 l4 4 m0 -4 l-4 4" stroke={DARK} strokeWidth="1.5" strokeLinecap="round" />
      ) : (
        <>
          <circle cx="-8" cy="-10" r="3.2" fill={WHITE} />
          <circle cx="8" cy="-10" r="3.2" fill={WHITE} />
          <g className="bp-blink">
            <circle cx="-7.5" cy="-10" r="1.6" fill={DARK} />
            <circle cx="8.5" cy="-10" r="1.6" fill={DARK} />
          </g>
        </>
      )}
      <path d="M-5 1 Q0 4 5 1" stroke={DARK} strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </g>
  );
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** A quiet pond, a frog on a lily pad and a blank signpost. */
function NewTab() {
  return (
    <svg width="320" height="130" viewBox="0 0 320 130" aria-hidden="true">
      <circle cx="262" cy="30" r="14" fill={WAIT} opacity=".18" />
      <ellipse cx="160" cy="106" rx="150" ry="18" fill={WATER} opacity=".14" />
      <g className="bp-wave">
        <path d="M40 104 q10 -4 20 0 t20 0 M190 112 q10 -4 20 0 t20 0" stroke={WATER} strokeWidth="1.5" fill="none" opacity=".45" />
      </g>
      <path d="M70 102 a22 7 0 1 0 44 0 a22 7 0 1 0 -44 0 Z" fill={G1} opacity=".45" />
      <path d="M200 104 a28 8 0 1 0 56 0 l-28 0 Z" fill={G1} opacity=".6" />
      <Frog x={228} y={92} />
      <rect x="132" y="40" width="4" height="62" rx="2" fill={MUT} />
      <path d="M136 46 h40 l8 8 l-8 8 h-40 Z" fill={SURF} stroke={MUT} strokeWidth="1.5" />
      <path d="M132 68 h-36 l-8 8 l8 8 h36 Z" fill={SURF} stroke={MUT} strokeWidth="1.5" />
      <text x="156" y="58" fontFamily="monospace" fontSize="10" fill={MUT} textAnchor="middle">?</text>
      <text x="112" y="80" fontFamily="monospace" fontSize="10" fill={MUT} textAnchor="middle">?</text>
    </svg>
  );
}

/** A sleeping server, unplugged. */
function Local() {
  return (
    <svg width="230" height="160" viewBox="0 0 230 160" aria-hidden="true">
      <ellipse cx="110" cy="146" rx="90" ry="7" fill="#000" opacity=".2" />
      <rect x="62" y="34" width="86" height="106" rx="10" fill={SURF} stroke={MUT} strokeWidth="1.5" />
      <path d="M76 98 h58 M76 110 h58 M76 122 h40" stroke={MUT} strokeWidth="1.5" strokeLinecap="round" opacity=".6" />
      <circle cx="130" cy="122" r="3" fill={MUT} opacity=".5" />
      <path d="M84 64 q6 5 12 0 M114 64 q6 5 12 0" stroke={INK} strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M98 80 q7 3 14 0" stroke={INK} strokeWidth="1.6" fill="none" strokeLinecap="round" opacity=".7" />
      <text className="bp-zz" x="150" y="40" fontFamily="monospace" fontSize="13" fill={WAIT}>z</text>
      <text className="bp-zz bp-d2" x="160" y="30" fontFamily="monospace" fontSize="16" fill={WAIT}>z</text>
      <text className="bp-zz bp-d3" x="172" y="18" fontFamily="monospace" fontSize="19" fill={WAIT}>Z</text>
      <path d="M105 140 C 105 150, 150 152, 170 146" stroke={MUT} strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <rect x="168" y="139" width="14" height="12" rx="3" fill={MUT} />
      <path d="M182 142 h6 M182 148 h6" stroke={MUT} strokeWidth="2" strokeLinecap="round" />
      <rect x="204" y="126" width="16" height="22" rx="4" fill={SURF} stroke={MUT} strokeWidth="1.5" />
      <path d="M209 134 v4 M215 134 v4" stroke={MUT} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** A broken bridge between two banks, no signal. */
function Offline() {
  return (
    <svg width="340" height="125" viewBox="0 0 340 125" aria-hidden="true">
      <rect x="0" y="100" width="340" height="25" fill={WATER} opacity=".12" />
      <g className="bp-wave">
        <path d="M120 108 q8 -4 16 0 t16 0 t16 0 t16 0 t16 0" stroke={WATER} strokeWidth="1.5" fill="none" opacity=".5" />
      </g>
      <path d="M0 62 h96 l10 8 v55 h-106 Z" fill={SURF} stroke={MUT} strokeWidth="1.5" />
      <path d="M340 62 h-96 l-10 8 v55 h106 Z" fill={SURF} stroke={MUT} strokeWidth="1.5" />
      <path d="M100 60 L150 66 M240 60 L190 66" stroke={MUT} strokeWidth="1.5" />
      {range(4).map((i) => (
        <rect key={`l${i}`} x={104 + i * 11} y={60 + i * 1.5} width="9" height="5" rx="1" fill={MUT} />
      ))}
      {range(4).map((i) => (
        <rect key={`r${i}`} x={227 - i * 11} y={60 + i * 1.5} width="9" height="5" rx="1" fill={MUT} />
      ))}
      <rect className="bp-fall" x="160" y="68" width="9" height="5" rx="1" fill={MUT} />
      <rect className="bp-fall bp-d2" x="174" y="68" width="9" height="5" rx="1" fill={MUT} />
      <Frog x={56} y={52} s={0.8} />
      <g transform="translate(170 26)">
        <path d="M-26 8 a12 12 0 0 1 8 -18 a16 16 0 0 1 30 2 a10 10 0 0 1 14 16 Z" fill={SURF} stroke={MUT} strokeWidth="1.5" />
        <path d="M-8 4 a12 12 0 0 1 16 0 M-4 8 a6 6 0 0 1 8 0" stroke={MUT} strokeWidth="1.6" fill="none" strokeLinecap="round" />
        <path d="M-12 -6 L12 12" stroke={DANGER} strokeWidth="2" strokeLinecap="round" />
      </g>
    </svg>
  );
}

/** A snail carrying the response, and a clock. */
function Timeout() {
  return (
    <svg width="320" height="110" viewBox="0 0 320 110" aria-hidden="true">
      <path d="M10 92 H310" stroke={MUT} strokeWidth="1.5" strokeDasharray="2 6" strokeLinecap="round" />
      <rect x="292" y="70" width="18" height="22" rx="3" fill={SURF} stroke={MUT} strokeWidth="1.5" />
      <g transform="translate(262 34)">
        <circle r="20" fill={SURF} stroke={WAIT} strokeWidth="1.8" />
        <path d="M0 -14 V0" stroke={INK} strokeWidth="2" strokeLinecap="round" />
        <path className="bp-hand" d="M0 0 L0 -11" stroke={WAIT} strokeWidth="1.6" strokeLinecap="round" />
        <circle r="2" fill={INK} />
      </g>
      <g className="bp-crawl">
        <g transform="translate(40 0)">
          <path d="M0 92 q4 -12 20 -10 h26 q6 0 8 -6 l3 -8" stroke={G2} strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M-4 92 H56 q6 0 4 -6" fill={G1} />
          <circle cx="56" cy="66" r="2" fill={G2} />
          <circle cx="62" cy="68" r="2" fill={G2} />
          <circle cx="24" cy="74" r="16" fill={WAIT} opacity=".85" />
          <path d="M24 74 m0 -10 a10 10 0 1 1 -9 6 a6 6 0 1 1 6 -2" stroke={DARK} strokeWidth="1.6" fill="none" opacity=".55" />
          <rect x="14" y="48" width="18" height="12" rx="2" fill={SURF} stroke={MUT} strokeWidth="1.3" />
          <path d="M14 54 h18" stroke={MUT} strokeWidth="1" />
        </g>
      </g>
    </svg>
  );
}

/** A cracked shield in a badge. */
function Cert() {
  return (
    <svg width="170" height="170" viewBox="0 0 170 170" aria-hidden="true">
      <circle cx="85" cy="85" r="76" fill={DANGER} opacity=".08" />
      <circle cx="85" cy="85" r="62" fill="none" stroke={DANGER} strokeWidth="1.2" strokeDasharray="3 6" opacity=".5" />
      <path d="M85 34 L124 48 V86 C124 112 106 128 85 136 C64 128 46 112 46 86 V48 Z" fill={SURF} stroke={MUT} strokeWidth="1.8" />
      <path d="M88 40 L80 66 L94 78 L78 100 L90 112 L84 132" stroke={DANGER} strokeWidth="2.2" fill="none" strokeLinejoin="round" strokeLinecap="round" />
      <rect x="62" y="80" width="22" height="18" rx="3" fill={MUT} opacity=".9" />
      <path d="M66 80 v-7 a7 7 0 0 1 14 0" stroke={MUT} strokeWidth="2.4" fill="none" transform="rotate(-24 80 73)" />
    </svg>
  );
}

/** Flowcode's house behind a gate, frog on guard. */
function Blocked() {
  return (
    <svg width="270" height="140" viewBox="0 0 270 140" aria-hidden="true">
      <ellipse cx="135" cy="128" rx="120" ry="8" fill="#000" opacity=".2" />
      <path d="M150 64 L190 34 L230 64 V124 H150 Z" fill={SURF} stroke={MUT} strokeWidth="1.6" strokeLinejoin="round" />
      <rect x="174" y="80" width="18" height="16" rx="2" fill={WAIT} opacity=".55" />
      <rect x="200" y="98" width="16" height="26" rx="2" fill={MUT} opacity=".5" />
      {range(8).map((i) => (
        <path key={i} d={`M${40 + i * 14} 124 V${92 - (i % 2) * 4} l4 -6 l4 6 V124`} fill={SURF} stroke={MUT} strokeWidth="1.3" strokeLinejoin="round" />
      ))}
      <path d="M36 104 H156 M36 116 H156" stroke={MUT} strokeWidth="1.5" />
      <Frog x={72} y={118} s={0.85} />
      <rect x="96" y="70" width="3" height="48" rx="1.5" fill={MUT} />
      <circle cx="97.5" cy="66" r="13" fill={DANGER} />
      <rect x="89" y="64" width="17" height="4" rx="2" fill={WHITE} />
    </svg>
  );
}

/** A paper boat going under. */
function Crash() {
  return (
    <svg width="300" height="125" viewBox="0 0 300 125" aria-hidden="true">
      <rect x="0" y="78" width="300" height="47" fill={WATER} opacity=".14" />
      <g className="bp-sink">
        <path d="M112 70 L188 70 L176 92 L124 92 Z" fill={INK} opacity=".9" />
        <path d="M150 70 L150 34 L176 70 Z" fill={INK} opacity=".75" />
        <path d="M150 34 L128 70" stroke={MUT} strokeWidth="1.2" />
      </g>
      <rect x="0" y="82" width="300" height="43" fill={WATER} opacity=".18" />
      <g className="bp-wave">
        <path d="M20 82 q12 -6 24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0 t24 0" stroke={WATER} strokeWidth="1.8" fill="none" opacity=".6" />
      </g>
      <circle className="bp-bub" cx="140" cy="100" r="3" fill="none" stroke={WATER} strokeWidth="1.3" />
      <circle className="bp-bub bp-d2" cx="158" cy="104" r="2" fill="none" stroke={WATER} strokeWidth="1.3" />
      <circle className="bp-bub bp-d3" cx="148" cy="108" r="4" fill="none" stroke={WATER} strokeWidth="1.3" />
      <Frog x={238} y={70} s={0.75} eyes="x" />
      <path d="M222 76 a16 5 0 1 0 32 0" fill={G1} opacity=".5" />
    </svg>
  );
}

const ART: Record<ArtId, () => ReactElement> = { newtab: NewTab, local: Local, offline: Offline, timeout: Timeout, cert: Cert, blocked: Blocked, crash: Crash };

export function ErrorArt({ id }: { id: ArtId }) {
  const Art = ART[id];
  return <Art />;
}
