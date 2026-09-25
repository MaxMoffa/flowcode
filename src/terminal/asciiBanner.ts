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

function gib(bytes: number): string {
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

/** A small "splash" written once at the very top of a fresh tab, before any
 * real shell output - purely decorative/orienting (OS, free RAM/disk), never
 * load-bearing, so it quietly skips itself rather than risk looking broken:
 * too narrow a terminal for the art, or no accent color available yet.
 * `info` is optional - if the backend query hasn't resolved (or failed), the
 * banner still shows, just without the info lines below it. */
export function buildAsciiBanner(cols: number, info?: BannerSystemInfo, appVersion?: string): string | null {
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
  // Plain text, not part of the block-font art - same accent color as the
  // wordmark above it (the theme's `--accent`, moss-green in both the light
  // and dark palette, so this reads as "always green" without hardcoding a
  // color that would drift from the art if the palette ever changes).
  lines.push(`  ${accent}Il terminale che si adatta a te${reset}`);
  lines.push("");
  for (const tableLine of buildInfoTable(rows, accent, dim, reset)) lines.push(`  ${tableLine}`);
  lines.push("");

  return lines.join("\r\n") + "\r\n";
}
