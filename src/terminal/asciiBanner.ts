import { t } from "../i18n";

/** "Flowcode" wordmark in the ANSI Shadow block font. */
const FLOWCODE_ART = [
  "███████╗██╗      ██████╗ ██╗    ██╗ ██████╗ ██████╗ ██████╗ ███████╗",
  "██╔════╝██║     ██╔═══██╗██║    ██║██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  "█████╗  ██║     ██║   ██║██║ █╗ ██║██║     ██║   ██║██║  ██║█████╗  ",
  "██╔══╝  ██║     ██║   ██║██║███╗██║██║     ██║   ██║██║  ██║██╔══╝  ",
  "██║     ███████╗╚██████╔╝╚███╔███╔╝╚██████╗╚██████╔╝██████╔╝███████╗",
  "╚═╝     ╚══════╝ ╚═════╝  ╚══╝╚══╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
];
const ART_WIDTH = FLOWCODE_ART[0].length;

function ansiTrueColor(hex: string): string | null {
  const match = hex.trim().match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return null;
  const [, r, g, b] = match;
  return `\x1b[38;2;${parseInt(r, 16)};${parseInt(g, 16)};${parseInt(b, 16)}m`;
}

export function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** Renders label/value pairs as a bordered two-column table (box-drawing
 * chars), border in the accent color, labels dim - matches how the art
 * above and the rest of the splash are colored. */
function buildInfoTable(rows: [string, string][], accent: string, dim: string, reset: string): string[] {
  if (rows.length === 0) return [];

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const valueWidth = Math.max(...rows.map(([, value]) => value.length));

  const border = (left: string, mid: string, right: string) =>
    `${accent}${left}${"─".repeat(labelWidth + 2)}${mid}${"─".repeat(valueWidth + 2)}${right}${reset}`;

  const lines = [border("┌", "┬", "┐")];
  rows.forEach(([label, value], i) => {
    if (i > 0) lines.push(border("├", "┼", "┤"));
    lines.push(
      `${accent}│${reset} ${dim}${label.padEnd(labelWidth)}${reset} ${accent}│${reset} ${value.padEnd(valueWidth)} ${accent}│${reset}`,
    );
  });
  lines.push(border("└", "┴", "┘"));
  return lines;
}

/** Mirrors the backend's `SystemInfo` (see src-tauri/src/system.rs) -
 * snake_case field names, since this is deserialized straight from the
 * `system_info` command's JSON with no remapping. */
export interface BannerSystemInfo {
  os_name: string | null;
  os_version: string | null;
  arch: string;
  memory_total: number;
  memory_available: number;
  disk: { total: number; available: number } | null;
}

const CACHE_MAX_AGE_MS = 60_000;
let cache: { info?: BannerSystemInfo; version?: string; at: number } | null = null;

/** Remembers what the banner needs so a terminal opening right after
 * (e.g. from the New Tab page, which already queried it) can write the banner
 * synchronously instead of waiting on a round trip before spawning its shell. */
export function rememberBannerInfo(part: { info?: BannerSystemInfo; version?: string }) {
  cache = { ...(cache ?? { at: 0 }), ...part, at: Date.now() };
}

/** The remembered info once both halves are known and still fresh. */
export function cachedBannerInfo(): { info: BannerSystemInfo; version: string } | null {
  if (!cache?.info || !cache.version || Date.now() - cache.at > CACHE_MAX_AGE_MS) return null;
  return { info: cache.info, version: cache.version };
}

/** A small "splash" written once at the very top of a fresh tab, before any
 * real shell output - purely decorative/orienting (OS, free RAM/disk), never
 * load-bearing, so it quietly skips itself rather than risk looking broken:
 * too narrow a terminal for the art, or no accent color available yet.
 * `info` is optional - if the backend query hasn't resolved (or failed), the
 * banner still shows, just without the info lines below it. */
export function buildAsciiBanner(
  cols: number,
  info?: BannerSystemInfo,
  appVersion?: string,
  /** `null` leaves the frog out (the New Tab page draws its own over it). */
  pose: FrogPose | null = REST_POSE,
): string | null {
  if (cols < ART_WIDTH + 4) return null;

  const style = getComputedStyle(document.documentElement);
  const accent = ansiTrueColor(style.getPropertyValue("--accent")) ?? "\x1b[36m";
  const reset = "\x1b[0m";
  const dim = "\x1b[2m";

  const rows: [string, string][] = [];
  if (appVersion) {
    rows.push(["Flowcode", `v${appVersion}`]);
  }
  if (info) {
    // `os_version` on Windows duplicates/wraps `os_name`'s own trailing
    // number (e.g. name "Windows 11 Home", version "11 (26200)"), which
    // read as noisy nested parentheses - just the name, plus the actual
    // architecture, is the useful pair here.
    if (info.os_name) {
      rows.push([t("banner.system"), info.os_name]);
    }
    if (info.arch) {
      rows.push([t("banner.arch"), info.arch]);
    }
    rows.push([t("banner.ram"), `${gib(info.memory_available)} / ${gib(info.memory_total)} GiB`]);
    if (info.disk) {
      rows.push([t("banner.disk"), `${gib(info.disk.available)} / ${gib(info.disk.total)} GiB`]);
    }
  }

  const lines: string[] = [""];
  for (const row of FLOWCODE_ART) lines.push(`  ${accent}${row}${reset}`);
  // Plain text, not part of the block-font art - same accent color as the
  // wordmark above it (the theme's `--accent`, moss-green in both the light
  // and dark palette, so this reads as "always green" without hardcoding a
  // color that would drift from the art if the palette ever changes).
  lines.push(`  ${accent}${t("banner.tagline")}${reset}`);
  lines.push("");
  for (const tableLine of buildInfoTable(rows, accent, dim, reset)) lines.push(`  ${tableLine}`);
  lines.push("");

  // The frog, centered in the space right of the wordmark when the tab is
  // wide enough for it - placed with an absolute column move, so the lines
  // beside it keep their own text untouched.
  const place = pose ? frogPlacement(cols, lines.length) : null;
  if (place && pose) {
    const frog = frogRows(pose);
    while (lines.length < place.top + frog.length) lines.push("");
    frog.forEach((row, i) => {
      lines[place.top + i] += `\x1b[${place.col + 1}G${row}${reset}`;
    });
  }

  return lines.join("\r\n") + "\r\n";
}

/** First column right of the wordmark (its 2-space indent, the art, a gap). */
const FROG_COLUMN = ART_WIDTH + 4;
export const FROG_WIDTH = 40;
export const FROG_HEIGHT = 16;
/** The frog's drawing area in its own units (FrogLogo's viewBox, with room
 * above the head for a hop): one pixel is about 19 x 20 units, half a cell. */
export const FROG_BOX = { x: 130, y: 205, width: 764, height: 650 };

/** Where the frog goes in a banner of `lineCount` lines on a `cols`-wide
 * tab - 0-based column and line - or `null` when there's no room for it. */
export function frogPlacement(cols: number, lineCount: number): { col: number; top: number } | null {
  const free = cols - FROG_COLUMN;
  if (cols < ART_WIDTH + 4 || free < FROG_WIDTH + 4) return null;
  return {
    col: FROG_COLUMN + Math.floor((free - FROG_WIDTH) / 2),
    top: Math.max(0, Math.floor((Math.max(lineCount, FROG_HEIGHT + 2) - FROG_HEIGHT) / 2)),
  };
}

/** How the frog stands: where its pupils look (units, up to ~30 each way),
 * how far its lids are down (0 open - 1 shut), the body's scale, rotation
 * (degrees) and lift (units, up is negative) around its bottom center, and
 * whether the `_` cursor on its belly is lit. The terminal always prints
 * REST_POSE; the New Tab page animates the rest. */
export interface FrogPose {
  lookX: number;
  lookY: number;
  lid: number;
  scaleX: number;
  scaleY: number;
  rotate: number;
  lift: number;
  cursor: boolean;
}

export const REST_POSE: FrogPose = { lookX: 0, lookY: 6, lid: 0, scaleX: 1, scaleY: 1, rotate: 0, lift: 0, cursor: true };

/** The Flowcode frog (two eye circles over an oval body - the numbers of the
 * old SVG logo, viewBox 130 245 764 610) at a point, in `pose`. No outline: a
 * dark outline drawn as a foreground color against the terminal's own
 * background would get repainted by xterm's minimumContrastRatio. */
function frogPixel(px: number, py: number, pose: FrogPose): string | null {
  // Undo the body's transform around its bottom center to find the point
  // on the frog at rest.
  const ox = 512;
  const oy = 830;
  const angle = (-pose.rotate * Math.PI) / 180;
  const dx = px - ox;
  const dy = py - pose.lift - oy;
  const x = ox + (dx * Math.cos(angle) - dy * Math.sin(angle)) / pose.scaleX;
  const y = oy + (dx * Math.sin(angle) + dy * Math.cos(angle)) / pose.scaleY;

  const segment = (ax: number, ay: number, bx: number, by: number) => {
    const sx = bx - ax;
    const sy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * sx + (y - ay) * sy) / (sx * sx + sy * sy)));
    return Math.hypot(x - (ax + t * sx), y - (ay + t * sy));
  };
  for (const cx of [340, 684]) {
    // The lid comes down from the top of the eye, as far as `lid` says.
    if (pose.lid > 0 && Math.hypot(x - cx, y - 393) <= 89 && y <= 304 + 178 * pose.lid) return "A3E635";
    // The glint is a bit larger than the logo's so it survives this size.
    if (Math.hypot(x - (cx + 14 + pose.lookX), y - 378 - pose.lookY) <= 16) return "FFFFFF";
    if (Math.hypot(x - (cx + pose.lookX), y - 393 - pose.lookY) <= 45) return "14532D";
    if (Math.hypot(x - cx, y - 393) <= 85) return "FFFFFF";
  }
  const strokes: [number, number, number, number][] = [
    [396, 575, 472, 632],
    [472, 632, 396, 689],
  ];
  if (pose.cursor) strokes.push([526, 689, 636, 689]);
  if (strokes.some((s) => segment(...s) <= 24)) return "14532D";
  const body =
    Math.hypot(x - 340, y - 400) <= 135 ||
    Math.hypot(x - 684, y - 400) <= 135 ||
    ((x - 512) / 360) ** 2 + ((y - 610) / 220) ** 2 <= 1;
  return body ? "A3E635" : null;
}

let restCache: string[] | null = null;

/** The frog as FROG_HEIGHT lines of FROG_WIDTH cells, in `pose`. A cell with
 * one color is a space on that background (backgrounds are never
 * contrast-adjusted, unlike foregrounds); one with two is an upper half
 * block, top color as foreground over the bottom one. */
export function frogRows(pose: FrogPose = REST_POSE): string[] {
  if (pose === REST_POSE && restCache) return restCache;
  const sgr = (code: 38 | 48, hex: string) =>
    `\x1b[${code};2;${parseInt(hex.slice(0, 2), 16)};${parseInt(hex.slice(2, 4), 16)};${parseInt(hex.slice(4), 16)}m`;
  const sample = (col: number, row: number) =>
    frogPixel(
      FROG_BOX.x + ((col + 0.5) * FROG_BOX.width) / FROG_WIDTH,
      FROG_BOX.y + ((row + 0.5) * FROG_BOX.height) / (FROG_HEIGHT * 2),
      pose,
    );
  const rows: string[] = [];
  for (let r = 0; r < FROG_HEIGHT; r++) {
    let line = "";
    for (let c = 0; c < FROG_WIDTH; c++) {
      const top = sample(c, 2 * r);
      const bottom = sample(c, 2 * r + 1);
      if (!top && !bottom) line += "\x1b[0m ";
      else if (top === bottom) line += `\x1b[0m${sgr(48, top!)} `;
      else if (!bottom) line += `\x1b[0m${sgr(38, top!)}▀`;
      else if (!top) line += `\x1b[0m${sgr(38, bottom)}▄`;
      else line += `\x1b[0m${sgr(38, top)}${sgr(48, bottom)}▀`;
    }
    rows.push(line);
  }
  if (pose === REST_POSE) restCache = rows;
  return rows;
}

/** The cell grid of the last terminal laid out, so the New Tab page can draw
 * the banner and the prompt row on the very cells the terminal replacing it
 * will - its own measurements, not an estimate from the font size. */
export interface TermGrid {
  fontSize: number;
  /** The terminal container's width, padding included. */
  width: number;
  cols: number;
  cellWidth: number;
  cellHeight: number;
}

let lastGrid: TermGrid | null = null;

export function rememberTermGrid(grid: TermGrid) {
  lastGrid = grid;
}

export function lastTermGrid(): TermGrid | null {
  return lastGrid;
}
