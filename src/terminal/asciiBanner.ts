/** "Flowcode" (only the F capitalized) in a 5-row block font - the F is a
 * full-height uppercase glyph, "lowcode" sits in the lower 3 rows (x-height)
 * with "l"/"d" reaching the full height for their ascenders, same as real
 * lowercase letterforms. Verified character-by-character (see the generator
 * script used to build it) so every row is exactly 47 columns wide. */
const FLOWCODE_ART_BASE = [
  "█████   █                               █      ",
  "█       █                               █      ",
  "████    █    ███  █   █  ████  ███   ████  ███ ",
  "█       █   █   █ █ █ █ █     █   █ █   █ █████",
  "█       █    ███   █ █   ████  ███   ████  ███ ",
];

/** Nearest-neighbor upscale of the base art - the source glyphs (esp. the
 * trailing "e", squeezed into the 3-row x-height band) read as noise at 1x
 * in a real terminal's cell aspect ratio. Doubling every pixel keeps every
 * proportion byte-for-byte identical to the verified source while making
 * each glyph's shape actually legible. */
function scaleArt(rows: string[], factor: number): string[] {
  const scaled: string[] = [];
  for (const row of rows) {
    const wideRow = row.replace(/./gs, (ch) => ch.repeat(factor));
    for (let i = 0; i < factor; i++) scaled.push(wideRow);
  }
  return scaled;
}

const FLOWCODE_ART = scaleArt(FLOWCODE_ART_BASE, 2);
const ART_WIDTH = FLOWCODE_ART[0].length;

function ansiTrueColor(hex: string): string | null {
  const match = hex.trim().match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return null;
  const [, r, g, b] = match;
  return `\x1b[38;2;${parseInt(r, 16)};${parseInt(g, 16)};${parseInt(b, 16)}m`;
}

function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
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

/** A small "splash" written once at the very top of a fresh tab, before any
 * real shell output - purely decorative/orienting (OS, free RAM/disk), never
 * load-bearing, so it quietly skips itself rather than risk looking broken:
 * too narrow a terminal for the art, or no accent color available yet.
 * `info` is optional - if the backend query hasn't resolved (or failed), the
 * banner still shows, just without the info lines below it. */
export function buildAsciiBanner(cols: number, info?: BannerSystemInfo): string | null {
  if (cols < ART_WIDTH + 4) return null;

  const style = getComputedStyle(document.documentElement);
  const accent = ansiTrueColor(style.getPropertyValue("--accent")) ?? "\x1b[36m";
  const reset = "\x1b[0m";
  const dim = "\x1b[2m";

  const rows: [string, string][] = [];
  if (info) {
    // `os_version` on Windows duplicates/wraps `os_name`'s own trailing
    // number (e.g. name "Windows 11 Home", version "11 (26200)"), which
    // read as noisy nested parentheses - just the name, plus the actual
    // architecture, is the useful pair here.
    if (info.os_name) {
      rows.push(["Sistema", info.os_name]);
    }
    if (info.arch) {
      rows.push(["Architettura", info.arch]);
    }
    rows.push(["RAM disponibile", `${gib(info.memory_available)} / ${gib(info.memory_total)} GiB`]);
    if (info.disk) {
      rows.push(["Spazio disponibile", `${gib(info.disk.available)} / ${gib(info.disk.total)} GiB`]);
    }
  }

  const lines: string[] = [""];
  for (const row of FLOWCODE_ART) lines.push(`  ${accent}${row}${reset}`);
  lines.push("");
  for (const [label, value] of rows) lines.push(`  ${dim}${label}:${reset} ${value}`);
  lines.push("");

  return lines.join("\r\n") + "\r\n";
}
