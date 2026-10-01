import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from "react";
import { listShellOptions, shellOptionLabel, type ShellOption } from "../terminal/shellOptions";
import { shellOptionIcon } from "../terminal/TabStrip";
import type { PromptAnchor } from "../terminal/Terminal";
import { sameShell, toWslPath, wslDistroOfPath, wslDistroOfShell } from "../terminal/wslPath";
import { listFavorites, subscribeFavorites, type FavoriteFolder } from "../favorites/favoritesStore";
import { listRecentTerminals, subscribeRecentTerminals, type RecentTerminal } from "./recentTerminals";
import { isWindowsPlatform } from "../lib/path";
import { flushSync } from "react-dom";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import {
  FROG_BOX,
  FROG_HEIGHT,
  FROG_WIDTH,
  buildAsciiBanner,
  frogPlacement,
  lastTermGrid,
  rememberBannerInfo,
  type BannerSystemInfo,
} from "../terminal/asciiBanner";
import { useFrogPose, type CatchFrame, type FlyArea } from "./useFrogPose";
import { MOUTH, sceneBounds, sceneColor, sceneRgb, toWorld, tongueTip } from "./frog3d";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { historyFor } from "./commandHistory";
import { useI18n } from "../i18n";
import "./newtab.css";

/** What the page hands back once the user picks something: the shell to
 * start (`undefined` = the configured default), where (`undefined` = that
 * shell's start folder), and a command to run - or, with `typeOnly`, to
 * leave typed on the prompt. */
export interface NewTabLaunch {
  shell?: string;
  cwd?: string;
  command?: string;
  typeOnly?: boolean;
}

interface NewTabPageProps {
  hidden: boolean;
  /** The configured default shell id (Impostazioni > Shell predefinita). */
  defaultShell: string;
  /** The folder a default-shell terminal would start in - shown on the
   * prompt; empty while it's still being looked up. */
  startDir: string;
  /** Font size of the terminal this page turns into: the page draws its
   * banner and prompt on that terminal's cell grid. */
  termFontSize: number;
  /** Fired on launch: mount the terminal now, so its shell spins up
   * underneath while the page is still on top (see `is-overlay`) - it stays
   * until it has faded out and calls `onDone`. */
  onLaunch: (launch: NewTabLaunch) => void;
  /** Where the terminal underneath will draw its first prompt, once its
   * banner (if any) is on screen. */
  anchor?: PromptAnchor;
  /** The terminal's shell has drawn its first prompt (`null`: it never
   * will - the shell failed to start). */
  promptShown?: PromptAnchor | null;
  /** The chosen shell changed (`undefined` = the configured default) - the
   * tab's folder follows to that shell's start folder. */
  onShellChange: (shell: string | undefined) => void;
  onDone: () => void;
}

/** The page draws the terminal's banner and prompt on the cells the terminal
 * will, so on launch the prompt barely moves: it settles onto the real row
 * (a few px at most, or more when the shell prints a greeting first). */
const FLIGHT_MS = 240;
const HAND_OFF_EASING = "cubic-bezier(.16,1,.3,1)";
/** Settle on the page's own row if the terminal hasn't reported where its
 * prompt will be by now. */
const ANCHOR_WAIT_MS = 80;
/** The prompt slides to the real one when the shell printed lines of its own
 * first (a profile's greeting). */
const NUDGE_MS = 120;
/** Fade anyway if the terminal never reports in. */
const READY_TIMEOUT_MS = 1800;
const OVERLAY_FADE_MS = 90;

const RECENTS_SHOWN = 6;

/** The terminal's font (see Terminal.tsx) - the page's banner and prompt are
 * set in it so they line up cell for cell with what replaces them. */
const TERM_FONT = "Menlo, Consolas, monospace";
/** What a terminal's columns leave out of its width: `.terminal-container`'s
 * horizontal padding (terminal.css) and the scrollbar FitAddon reserves. */
const TERM_GUTTER_X = 28 + 14;
/** `.terminal-container`'s top and left padding, where its first cell is. */
const TERM_PADDING_TOP = 14;
const TERM_PADDING_LEFT = 14;

/** The prompt the chosen shell would print - only its shape (PowerShell's
 * `PS C:\...>`, cmd's `C:\...>`, a POSIX `$`), so the page's prompt reads as
 * that shell's first line. */
function promptFor(shell: string, defaultLabel: string, dir: string): string {
  if (wslDistroOfShell(shell) !== undefined) {
    const posix = dir ? toWslPath(wslDistroOfPath(dir) ?? "", dir) : null;
    return `${posix ?? "~"} $ `;
  }
  const where = dir || "~";
  if (shell === "cmd") return `${where}>`;
  if (isPowerShell(shell, defaultLabel) || (shell === "system" && isWindowsPlatform())) return `PS ${where}> `;
  return `${where} $ `;
}

/** Whether `shell` starts PowerShell - the default one too, which on Windows
 * is PowerShell unless its label says otherwise. */
function isPowerShell(shell: string, defaultLabel: string): boolean {
  if (shell === "powershell" || shell === "pwsh") return true;
  return shell === "system" && (/powershell/i.test(defaultLabel) || (isWindowsPlatform() && !defaultLabel));
}

/** A favorite's folder as the list shows it: a WSL folder by its POSIX
 * path, the way its shell prints it. Wrapped in LRM marks so the column's
 * `direction: rtl` (which trims long paths from the left) doesn't move the
 * leading `\\` or a trailing slash to the other end. */
function shownPath(path: string): string {
  const distro = wslDistroOfPath(path);
  const posix = distro ? toWslPath(distro, path) : null;
  return `\u200e${posix ?? path}\u200e`;
}

function useRelativeTime() {
  const { language } = useI18n();
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  return (at: number) => {
    const minutes = Math.round((at - Date.now()) / 60000);
    if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return format.format(hours, "hour");
    return format.format(Math.round(hours / 24), "day");
  };
}

interface Segment {
  text: string;
  style: CSSProperties;
}

/** The banner exactly as the terminal will draw it: `buildAsciiBanner`'s own
 * output, read back into styled runs per line. Understands what that output
 * uses - SGR reset, dim, truecolor (and the cyan fallback) foreground and
 * background, and the absolute column move that places the frog. */
function bannerLines(ansi: string): Segment[][] {
  return ansi
    .replace(/\r\n$/, "")
    .split("\r\n")
    .map((line) => {
      const segments: Segment[] = [];
      let style: CSSProperties = {};
      let width = 0;
      let last = 0;
      const push = (text: string) => {
        if (!text) return;
        segments.push({ text, style });
        width += [...text].length;
      };
      for (const match of line.matchAll(/\x1b\[([0-9;]*)([mG])/g)) {
        push(line.slice(last, match.index));
        last = match.index! + match[0].length;
        const params = match[1].split(";").map(Number);
        if (match[2] === "G") {
          const pad = (params[0] || 1) - 1 - width;
          if (pad > 0) {
            const keep = style;
            style = {};
            push(" ".repeat(pad));
            style = keep;
          }
          continue;
        }
        for (let i = 0; i < params.length; i++) {
          const p = params[i];
          if (p === 0) style = {};
          else if (p === 2) style = { ...style, opacity: 0.55 };
          else if (p === 36) style = { ...style, color: "var(--accent)" };
          else if ((p === 38 || p === 48) && params[i + 1] === 2) {
            const rgb = `rgb(${params[i + 2]}, ${params[i + 3]}, ${params[i + 4]})`;
            style = p === 38 ? { ...style, color: rgb } : { ...style, background: rgb };
            i += 4;
          }
        }
      }
      push(line.slice(last));
      return segments;
    });
}

/** Drawing units per pixel of the frog (two pixels per character cell). */
const UNIT_X = FROG_BOX.width / FROG_WIDTH;
const UNIT_Y = FROG_BOX.height / (FROG_HEIGHT * 2);

/** "Fly" in the app's languages: typed on the prompt, the frog eats it. */
const FLY_WORDS = /(?<![\p{L}\p{N}_-])(mosca|mosche|fly|flies)(?![\p{L}\p{N}_-])/giu;
/** How long the line has to sit still before the frog goes for the word -
 * never mid-typing. */
const FLY_WORD_IDLE_MS = 700;

/** A fly word on `line` the frog may eat: not one that's the command of a
 * longer line (`fly deploy` runs Fly.io's CLI), so only a word on its own
 * or among a command's arguments. */
function flyWordIn(line: string): { word: string; index: number } | null {
  for (const match of line.matchAll(FLY_WORDS)) {
    const index = match.index!;
    const isCommand = line.slice(0, index).trim() === "" && line.slice(index + match[0].length).trim() !== "";
    if (!isCommand) return { word: match[0], index };
  }
  return null;
}

/** The page's cell grid, as the catch sees it: where cell (0, 0) is on
 * screen, the cell size, and where the frog's box sits in it. */
interface CatchGrid {
  originX: number;
  originY: number;
  cellWidth: number;
  cellHeight: number;
  cols: number;
  rows: number;
  frogAt: { col: number; top: number };
}

/** A cell column / pixel row (two per cell row) in the frog's drawing units. */
const toUnits = (g: CatchGrid, col: number, pixelRow: number) => ({
  x: FROG_BOX.x + (col - g.frogAt.col + 0.5) * UNIT_X,
  y: FROG_BOX.y + (pixelRow - 2 * g.frogAt.top + 0.5) * UNIT_Y,
});

/** Things on the page the fly can land on, besides the banner's: the
 * prompt, the list's headings and names, the shell buttons, the key hints. */
const LANDING_SELECTORS = [".newtab-ps", ".newtab-heading", ".newtab-row-name", ".newtab-chip", ".newtab-keys"];

/** Where the fly can go: spots on top of the wordmark's letters, the
 * tagline, the system table's top edge and the page's own elements - one
 * group each - and the visible page to flutter about in. */
function flyArea(g: CatchGrid, lines: Segment[][], root: HTMLElement): FlyArea {
  const groups: { x: number; y: number }[][] = [];
  const onLine = (line: number, test: (ch: string) => boolean) => {
    const cells = toCells(lines[line] ?? []);
    return cells.flatMap((c, col) => (test(c.ch) ? [toUnits(g, col, 2 * line)] : []));
  };
  // The wordmark's top row of blocks, the tagline under it, the table's top.
  groups.push(onLine(1, (ch) => ch === "\u2588"));
  groups.push(onLine(7, (ch) => ch !== " "));
  const tableTop = lines.findIndex((l) => toCells(l).some((c) => c.ch === "\u250c"));
  if (tableTop >= 0) groups.push(onLine(tableTop, (ch) => ch === "\u2500"));
  for (const selector of LANDING_SELECTORS) {
    const spots: { x: number; y: number }[] = [];
    for (const el of root.querySelectorAll<HTMLElement>(selector)) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0) continue;
      const row = Math.floor((2 * (r.top + r.height / 2 - g.originY)) / g.cellHeight / 2) * 2;
      if (row < 0 || row >= 2 * g.rows) continue;
      const from = Math.round((r.left - g.originX) / g.cellWidth);
      const to = Math.round((r.right - g.originX) / g.cellWidth) - 1;
      for (let col = Math.max(1, from); col <= Math.min(g.cols - 2, to); col++) spots.push(toUnits(g, col, row));
    }
    groups.push(spots);
  }
  const corner = toUnits(g, 2, 0);
  const far = toUnits(g, g.cols - 3, 2 * g.rows - 2);
  return { spots: groups, bounds: { left: corner.x, right: far.x, top: corner.y, bottom: far.y } };
}

interface Cell {
  ch: string;
  style: CSSProperties;
}

function toCells(segments: Segment[]): Cell[] {
  return segments.flatMap((s) => [...s.text].map((ch) => ({ ch, style: s.style })));
}

function fromCells(cells: Cell[]): Segment[] {
  const out: Segment[] = [];
  for (const cell of cells) {
    const last = out[out.length - 1];
    if (last && last.style === cell.style) last.text += cell.ch;
    else out.push({ text: cell.ch, style: cell.style });
  }
  return out;
}

const hex = (color: string) => `#${color}`;

/** A frame of the catch as rows of cells over the whole page - the 3D frog,
 * its tongue and the fly; blank (see-through) everywhere else. */
function drawCatch(g: CatchGrid, frame: CatchFrame): Segment[][] {
  const fly = frame.fly;
  // The fly is one dark pixel with a light wing either side, beating up a
  // pixel and back while it flies, folded level while it sits.
  const flyPx = fly
    ? [g.frogAt.col + Math.floor((fly.x - FROG_BOX.x) / UNIT_X), 2 * g.frogAt.top + Math.floor((fly.y - FROG_BOX.y) / UNIT_Y)]
    : null;
  const flyColor = (px: number, py: number): string | null => {
    if (!flyPx || !fly) return null;
    const [fx, fy] = flyPx;
    if (px === fx && py === fy) return "52525B";
    const wingRow = fly.flap ? fy - 1 : fy;
    if ((px === fx - 1 || px === fx + 1) && py === wingRow) return "F4F4F5";
    return null;
  };
  // The scene is only worth asking about where the frog and its tongue can be.
  const box = sceneBounds(frame.scene);
  const colOf = (x: number) => g.frogAt.col + (x - FROG_BOX.x) / UNIT_X;
  const rowOf = (y: number) => g.frogAt.top + (y - FROG_BOX.y) / (2 * UNIT_Y);
  const [c0, c1] = [Math.max(0, Math.floor(colOf(box.left))), Math.min(g.cols - 1, Math.ceil(colOf(box.right)))];
  const [r0, r1] = [Math.max(0, Math.floor(rowOf(box.top))), Math.min(g.rows - 1, Math.ceil(rowOf(box.bottom)))];
  // A word being carried off sits on the tongue's tip, its letters in the
  // cells there - instead of a fly.
  const word = fly?.word ? { text: [...fly.word], col: flyPx![0] - Math.floor(fly.word.length / 2), row: Math.floor(flyPx![1] / 2) } : null;
  const rows: Segment[][] = [];
  for (let row = 0; row < g.rows; row++) {
    const cells: Cell[] = [];
    const inRows = row >= r0 && row <= r1;
    const flyRow = flyPx && !word && Math.abs(2 * row - flyPx[1]) <= 2;
    if (!inRows && !flyRow) {
      rows.push([]);
      continue;
    }
    for (let col = 0; col < g.cols; col++) {
      if (word && row === word.row && col >= word.col && col < word.col + word.text.length) {
        cells.push({ ch: word.text[col - word.col], style: WORD_STYLE });
        continue;
      }
      const pixel = (half: number) => {
        const flyHere = word ? null : flyColor(col, 2 * row + half);
        if (flyHere) return flyHere;
        if (!inRows || col < c0 || col > c1) return null;
        const { x, y } = toUnits(g, col, 2 * row + half);
        return sceneColor(x, y, frame.scene);
      };
      const top = pixel(0);
      const bottom = pixel(1);
      if (!top && !bottom) cells.push({ ch: " ", style: NO_STYLE });
      else if (top === bottom) cells.push({ ch: " ", style: { background: hex(top!) } });
      else if (!bottom) cells.push({ ch: "\u2580", style: { color: hex(top!) } });
      else if (!top) cells.push({ ch: "\u2584", style: { color: hex(bottom) } });
      else cells.push({ ch: "\u2580", style: { color: hex(top), background: hex(bottom) } });
    }
    rows.push(fromCells(cells));
  }
  return rows;
}

const NO_STYLE: CSSProperties = {};
/** A word on the tongue: the prompt's own text color, on the tongue's pink. */
const WORD_STYLE: CSSProperties = { color: "var(--fg)", background: "#EC4899", fontWeight: 700 };

/** A frame of the real-frog catch onto `canvas`, over the whole page: the
 * scene ray-traced at a pixel size that shrinks from the ASCII cell (half a
 * cell tall) to near the screen's own as the frog turns real - with bands
 * slipping sideways while it glitches - plus a soft shadow under it and a
 * real fly. */
function drawRealCatch(canvas: HTMLCanvasElement, g: CatchGrid, frame: CatchFrame) {
  const real = frame.real!;
  const width = g.cols * g.cellWidth;
  const height = g.rows * g.cellHeight;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // Drawing units <-> page px.
  const pxPerUnitX = g.cellWidth / UNIT_X;
  const pxPerUnitY = g.cellHeight / (2 * UNIT_Y);
  const toPxX = (x: number) => (g.frogAt.col + (x - FROG_BOX.x) / UNIT_X) * g.cellWidth;
  const toPxY = (y: number) => (g.frogAt.top + (y - FROG_BOX.y) / (2 * UNIT_Y)) * g.cellHeight;
  const toUnitX = (px: number) => FROG_BOX.x + (px / g.cellWidth - g.frogAt.col) * UNIT_X;
  const toUnitY = (py: number) => FROG_BOX.y + (py / g.cellHeight - g.frogAt.top) * 2 * UNIT_Y;

  const scene = frame.scene;
  // A soft shadow on the ground under it, fainter the higher it hops.
  if (real.amount > 0) {
    const gx = toPxX(512 + scene.shiftX);
    const gy = toPxY(840);
    const rx = 330 * pxPerUnitX;
    const ry = 40 * pxPerUnitY;
    const shadow = ctx.createRadialGradient(gx, gy, 0, gx, gy, rx);
    shadow.addColorStop(0, `rgba(0, 0, 0, ${0.35 * real.amount * (1 + scene.lift / 200)})`);
    shadow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.save();
    ctx.translate(gx, gy);
    ctx.scale(1, ry / rx);
    ctx.translate(-gx, -gy);
    ctx.fillStyle = shadow;
    ctx.fillRect(gx - rx, gy - rx, rx * 2, rx * 2);
    ctx.restore();
  }

  // The pixel size: the ASCII cell's at first, fine once it's real.
  const k = real.amount ** 0.6;
  // Not the screen's own pixels: ray-tracing those is too slow in a frame,
  // and smoothed up from a few px it reads as a real, soft image anyway.
  const fine = 3;
  const stepX = g.cellWidth + (fine - g.cellWidth) * k;
  const stepY = g.cellHeight / 2 + (fine - g.cellHeight / 2) * k;
  const box = sceneBounds(scene);
  const x0 = Math.max(0, Math.floor(toPxX(box.left) / stepX) * stepX);
  const y0 = Math.max(0, Math.floor(toPxY(box.top) / stepY) * stepY);
  const x1 = Math.min(width, toPxX(box.right));
  const y1 = Math.min(height, toPxY(box.bottom));
  const nx = Math.max(1, Math.ceil((x1 - x0) / stepX));
  const ny = Math.max(1, Math.ceil((y1 - y0) / stepY));
  const image = new ImageData(nx, ny);
  // Only rays near the frog's own box or along its tongue can hit anything.
  const own = sceneBounds({ ...scene, tongue: null });
  const tip = tongueTip(scene);
  const [mx, my] = toWorld(MOUTH, scene);
  const [tx, ty] = tip ? toWorld(tip, scene) : [mx, my];
  const nearTongue = (x: number, y: number) => {
    if (!tip) return false;
    const [sx, sy] = [tx - mx, ty - my];
    const u = Math.max(0, Math.min(1, ((x - mx) * sx + (y - my) * sy) / (sx * sx + sy * sy || 1)));
    return Math.hypot(x - (mx + u * sx), y - (my + u * sy)) < 60;
  };
  for (let j = 0; j < ny; j++) {
    const y = toUnitY(y0 + (j + 0.5) * stepY);
    for (let i = 0; i < nx; i++) {
      const x = toUnitX(x0 + (i + 0.5) * stepX);
      if (!(x >= own.left && x <= own.right && y >= own.top && y <= own.bottom) && !nearTongue(x, y)) continue;
      const c = sceneRgb(x, y, scene);
      if (!c) continue;
      const o = (j * nx + i) * 4;
      image.data[o] = c[0];
      image.data[o + 1] = c[1];
      image.data[o + 2] = c[2];
      image.data[o + 3] = 255;
    }
  }
  const buffer = document.createElement("canvas");
  buffer.width = nx;
  buffer.height = ny;
  buffer.getContext("2d")!.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = k > 0.7;
  if (real.glitch > 0.08) {
    // Glitching: horizontal bands of it slip sideways, a few each frame.
    const bands = 6 + Math.floor(real.glitch * 10);
    for (let b = 0; b < bands; b++) {
      const sy = (b / bands) * ny;
      const sh = ny / bands;
      const slip = Math.random() < real.glitch * 0.6 ? (Math.random() - 0.5) * 40 * real.glitch : 0;
      ctx.drawImage(buffer, 0, sy, nx, sh, x0 + slip, y0 + sy * stepY, nx * stepX, sh * stepY);
    }
  } else {
    ctx.drawImage(buffer, x0, y0, nx * stepX, ny * stepY);
  }

  // The fly, real too once the frog mostly is.
  const fly = frame.fly;
  if (fly?.word) {
    ctx.font = `700 ${g.cellHeight * 0.8}px Menlo, Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--fg") || "#fff";
    ctx.fillText(fly.word, toPxX(fly.x), toPxY(fly.y));
  } else if (fly) {
    const fx = toPxX(fly.x);
    const fy = toPxY(fly.y);
    if (real.amount > 0.5) {
      ctx.save();
      ctx.translate(fx, fy);
      ctx.scale(1.6, 1.6);
      for (const side of [-1, 1]) {
        ctx.save();
        ctx.rotate(side * (fly.flap ? 1.0 : 0.35));
        ctx.beginPath();
        ctx.ellipse(side * 3, -2, 3.6, 1.6, 0, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(220, 232, 255, 0.55)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
        ctx.lineWidth = 0.4;
        ctx.stroke();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.ellipse(0, 0.5, 2.6, 1.8, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#1c1917";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(-2.4, 0, 1.3, 0, Math.PI * 2);
      ctx.fillStyle = "#3f1d1d";
      ctx.fill();
      ctx.restore();
    } else {
      // Still the pixel fly: a dark half cell with a light wing either side.
      const col = Math.floor(fx / g.cellWidth);
      const half = Math.floor(fy / (g.cellHeight / 2));
      const h = g.cellHeight / 2;
      ctx.fillStyle = "#52525B";
      ctx.fillRect(col * g.cellWidth, half * h, g.cellWidth, h);
      ctx.fillStyle = "#F4F4F5";
      const wing = fly.flap ? half - 1 : half;
      ctx.fillRect((col - 1) * g.cellWidth, wing * h, g.cellWidth, h);
      ctx.fillRect((col + 1) * g.cellWidth, wing * h, g.cellWidth, h);
    }
  }
}

/** The terminal's cell grid at `width`: the last terminal's own measurements
 * when it was laid out at this font size (and its column count when at this
 * very width), otherwise the font measured here the way xterm measures it. */
function useTermGrid(fontSize: number, width: number) {
  const [measured, setMeasured] = useState<{ fontSize: number; cellWidth: number; cellHeight: number } | null>(null);
  const grid = lastTermGrid();
  const known = grid && grid.fontSize === fontSize ? grid : null;
  useLayoutEffect(() => {
    if (known || measured?.fontSize === fontSize) return;
    const probe = document.createElement("span");
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${TERM_FONT};font-size:${fontSize}px;line-height:normal`;
    probe.textContent = "W".repeat(32);
    document.body.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    setMeasured({ fontSize, cellWidth: rect.width / 32, cellHeight: Math.ceil(rect.height) });
  }, [known, measured, fontSize]);
  const cell = known ?? (measured?.fontSize === fontSize ? measured : null);
  if (!cell || width <= 0) return null;
  const cols =
    known && Math.abs(known.width - width) < 1 ? known.cols : Math.max(1, Math.floor((width - TERM_GUTTER_X) / cell.cellWidth));
  return { cols, cellWidth: cell.cellWidth, cellHeight: cell.cellHeight };
}

export function NewTabPage({ hidden, defaultShell, startDir, termFontSize, onLaunch, anchor, promptShown, onShellChange, onDone }: NewTabPageProps) {
  const { t } = useI18n();
  const { bannerEnabled } = useTerminalSettings();
  const relativeTime = useRelativeTime();
  const [options, setOptions] = useState<ShellOption[]>([]);
  const [shell, setShell] = useState(defaultShell || "system");
  const [command, setCommand] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [flyPrompt, setFlyPrompt] = useState<string | null>(null);
  const [phase, setPhase] = useState<"page" | "overlay" | "fading">("page");
  /** The list row picked with the arrow keys (-1: the prompt itself). */
  const [selected, setSelected] = useState(-1);
  /** The chosen shell's command history, oldest first, and how far back
   * the up arrow has gone into it (-1: not at all - the line is the user's
   * own draft, kept in `draftRef` while walking). */
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const draftRef = useRef("");
  const [width, setWidth] = useState(0);
  const favorites = useSyncExternalStore(subscribeFavorites, listFavorites, listFavorites);
  const recents = useSyncExternalStore(subscribeRecentTerminals, listRecentTerminals, listRecentTerminals).slice(
    0,
    RECENTS_SHOWN,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLLabelElement>(null);
  const psRef = useRef<HTMLSpanElement>(null);
  /** The measurements the hand-off needs, taken when it was launched - the
   * prompt only moves once the terminal says where its own is. */
  const flightRef = useRef<{ text: DOMRect; started: boolean; landedTop: number } | null>(null);
  const finishingRef = useRef(false);
  const timersRef = useRef<number[]>([]);
  const [version, setVersion] = useState("");
  const [system, setSystem] = useState<BannerSystemInfo | null>(null);
  const [flightDone, setFlightDone] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const grid = useTermGrid(termFontSize, width);

  useEffect(() => {
    let cancelled = false;
    void listShellOptions().then((opts) => {
      if (cancelled) return;
      setOptions(opts);
      const match = opts.find((o) => sameShell(o.id, defaultShell));
      if (match) setShell(match.id);
    });
    return () => {
      cancelled = true;
    };
  }, [defaultShell]);

  useEffect(() => {
    void getVersion()
      .then((v) => {
        setVersion(v);
        rememberBannerInfo({ version: v });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    void invoke<BannerSystemInfo>("system_info")
      .then((info) => {
        rememberBannerInfo({ info });
        if (!cancelled) setSystem(info);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => timersRef.current.forEach(window.clearTimeout), []);

  useEffect(() => {
    if (!hidden) inputRef.current?.focus({ preventScroll: true });
  }, [hidden]);

  useEffect(() => {
    if (selected >= 0) document.getElementById(`newtab-row-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => setWidth(root.getBoundingClientRect().width));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // "Default (X)" is just X: drop it when a chip for X exists and let that
  // chip stand for the default instead of listing the shell twice.
  const systemLabel = options.find((o) => o.id === "system")?.label;
  const twin = systemLabel ? options.find((o) => o.id !== "system" && o.label === systemLabel) : undefined;
  const chipShell = (opt: ShellOption) => (opt === twin && sameShell(defaultShell, "system") ? "system" : opt.id);
  // The configured default always comes first.
  const shown = twin ? options.filter((o) => o.id !== "system") : options;
  const isDefaultChip = (opt: ShellOption) => sameShell(chipShell(opt), defaultShell);
  const chips = [...shown.filter(isDefaultChip), ...shown.filter((o) => !isDefaultChip(o))];
  const defaultLabel = options.find((o) => o.id === "system")?.label ?? "";
  const labelOf = (id: string | undefined) => {
    const opt = options.find((o) => sameShell(o.id, id ?? defaultShell));
    // "Predefinita (PowerShell)" is just PowerShell to the reader: name the shell.
    if (opt?.id === "system" && opt.label) return opt.label;
    return opt ? shellOptionLabel(opt) : (id ?? "");
  };

  // The up arrow walks the history of the shell the prompt belongs to.
  const powershell = isPowerShell(shell, defaultLabel);
  useEffect(() => {
    let cancelled = false;
    setHistoryIndex(-1);
    void historyFor(shell, powershell).then((list) => {
      if (!cancelled) setHistory(list);
    });
    return () => {
      cancelled = true;
    };
  }, [shell, powershell]);

  /** Puts a history entry (or the draft) on the line, caret at its end. */
  function showLine(text: string, index: number) {
    setHistoryIndex(index);
    setCommand(text);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(text.length, text.length));
  }

  // The same banner a fresh terminal writes (none when it's turned off or
  // the tab is too narrow for it), so the prompt below it sits on the row
  // the shell will print its own on. Built without the frog first: that's
  // what the frog is placed against, and what the catch is drawn over.
  const bare = bannerEnabled && grid ? buildAsciiBanner(grid.cols, system ?? undefined, version || undefined, null) : null;
  const bareLines = bare ? bannerLines(bare) : [];
  const frogAt = grid && bareLines.length > 0 ? frogPlacement(grid.cols, bareLines.length) : null;
  /** The page's cell grid as it stands, for the catch. */
  const catchGrid = (): CatchGrid | null => {
    const root = rootRef.current;
    if (!root || !grid || !frogAt) return null;
    const r = root.getBoundingClientRect();
    return {
      originX: r.left + TERM_PADDING_LEFT,
      originY: r.top + TERM_PADDING_TOP - root.scrollTop,
      cellWidth: grid.cellWidth,
      cellHeight: grid.cellHeight,
      cols: grid.cols,
      rows: Math.max(1, Math.floor((root.clientHeight - 2 * TERM_PADDING_TOP) / grid.cellHeight)),
      frogAt,
    };
  };
  // The frog comes alive on the page; it stands still - the pose the
  // terminal prints - once the hand-off starts.
  const { pose, catching, huntWord } = useFrogPose({
    active: !hidden && !leaving && !!frogAt,
    frogRect: () => {
      const root = rootRef.current;
      if (!root || !grid || !frogAt) return null;
      const r = root.getBoundingClientRect();
      return new DOMRect(
        r.left + TERM_PADDING_LEFT + frogAt.col * grid.cellWidth,
        r.top + TERM_PADDING_TOP - root.scrollTop + frogAt.top * grid.cellHeight,
        FROG_WIDTH * grid.cellWidth,
        FROG_HEIGHT * grid.cellHeight,
      );
    },
    caret: () => {
      const input = inputRef.current;
      if (!input || document.activeElement !== input || !command || !grid) return null;
      const r = input.getBoundingClientRect();
      return { x: r.left + Math.min(r.width, input.value.length * grid.cellWidth), y: r.top + r.height / 2 };
    },
    flyArea: () => {
      const g = catchGrid();
      return g && rootRef.current ? flyArea(g, bareLines, rootRef.current) : null;
    },
  });
  const banner =
    catching || !bannerEnabled || !grid ? null : buildAsciiBanner(grid.cols, system ?? undefined, version || undefined, pose);
  const lines = catching ? bareLines : banner ? bannerLines(banner) : [];
  const catchGridNow = catching ? catchGrid() : null;
  // The real-frog catch is painted on a canvas instead - except for the odd
  // frame mid-glitch, which flickers back to the ASCII one.
  const realFrame = !!catching?.real && !(catching.real.glitch > 0.6 && Math.random() < 0.3);
  const catchRows = catching && catchGridNow && !realFrame ? drawCatch(catchGridNow, catching) : null;
  const realCanvasRef = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = realCanvasRef.current;
    if (canvas && realFrame && catching && catchGridNow) drawRealCatch(canvas, catchGridNow, catching);
  });

  // "mosca" or "fly" left on the line: the frog catches it and eats it,
  // taking it off the line.
  useEffect(() => {
    if (leaving || hidden) return;
    const found = flyWordIn(command);
    if (!found) return;
    const timer = window.setTimeout(() => {
      const input = inputRef.current;
      const g = catchGrid();
      if (!input || !g) return;
      // The word's middle on screen: the line is monospace, scrolled by the
      // input when it overflows.
      const r = input.getBoundingClientRect();
      const px = r.left - input.scrollLeft + (found.index + found.word.length / 2) * g.cellWidth;
      const col = Math.floor((px - g.originX) / g.cellWidth);
      const row = Math.floor((r.top + r.height / 2 - g.originY) / g.cellHeight);
      const spot = {
        x: FROG_BOX.x + (col - g.frogAt.col + 0.5) * UNIT_X,
        y: FROG_BOX.y + (2 * (row - g.frogAt.top) + 1) * UNIT_Y,
      };
      huntWord(found.word, spot, () => {
        setCommand((line) => {
          const at = line.slice(found.index, found.index + found.word.length) === found.word ? found.index : line.search(FLY_WORDS);
          if (at < 0) return line;
          // Gone, with the space it leaves behind.
          return (line.slice(0, at) + line.slice(at + found.word.length)).replace(/ {2,}/g, " ").trimStart();
        });
        setHistoryIndex(-1);
      });
    }, FLY_WORD_IDLE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, leaving, hidden]);

  /** Hands the tab over to the terminal: mounts it underneath, keeps the
   * banner and prompt in place over it while everything else clears away,
   * then lets the prompt settle onto the shell's own before fading. */
  function launch(next: NewTabLaunch) {
    if (leaving) return;
    // The prompt the terminal will print: for a recent or favorite that is
    // its own folder and shell, not the ones shown now.
    flushSync(() => {
      setLeaving(true);
      setSelected(-1);
      if (next.cwd !== undefined || next.shell !== undefined) {
        setFlyPrompt(promptFor(next.shell ?? defaultShell, defaultLabel, next.cwd ?? startDir));
      }
    });
    const root = rootRef.current;
    const ps = psRef.current;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!root || !ps || reduceMotion) {
      onLaunch(next);
      onDone();
      return;
    }
    const text = ps.getBoundingClientRect();
    flightRef.current = { text, started: false, landedTop: text.top };
    setPhase("overlay");
    onLaunch(next);
    timersRef.current.push(window.setTimeout(() => setTimedOut(true), READY_TIMEOUT_MS));
    // Where the terminal's prompt lands depends on its banner, which it
    // reports as soon as it is written; staying put is the fallback.
    timersRef.current.push(
      window.setTimeout(() => settle({ left: text.left, top: text.top, cellHeight: text.height }), ANCHOR_WAIT_MS),
    );
  }

  /** Moves the prompt onto the terminal's prompt row - by nothing or a few
   * px when the grids agree. */
  function settle(a: PromptAnchor) {
    const f = flightRef.current;
    const prompt = promptRef.current;
    if (!f || f.started || !prompt) return;
    f.started = true;
    f.landedTop = a.top;
    const dx = a.left - f.text.left;
    const dy = a.top + a.cellHeight / 2 - (f.text.top + f.text.height / 2);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
      setFlightDone(true);
      return;
    }
    const animation = prompt.animate([{ transform: "translate(0, 0)" }, { transform: `translate(${dx}px, ${dy}px)` }], {
      duration: FLIGHT_MS,
      easing: HAND_OFF_EASING,
      fill: "forwards",
    });
    animation.onfinish = () => setFlightDone(true);
  }

  useEffect(() => {
    if (anchor) settle(anchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  // Once the prompt has landed and the shell has drawn its own, fade the
  // page out to reveal it - after sliding onto the real row if the shell
  // printed something of its own first.
  useEffect(() => {
    if (phase !== "overlay" || !flightDone || finishingRef.current) return;
    if (promptShown === undefined && !timedOut) return;
    finishingRef.current = true;
    const finish = () => {
      setPhase("fading");
      timersRef.current.push(window.setTimeout(onDone, OVERLAY_FADE_MS));
    };
    const delta = promptShown && flightRef.current ? promptShown.top - flightRef.current.landedTop : 0;
    const prompt = promptRef.current;
    if (prompt && Math.abs(delta) > 2) {
      const slide = prompt.animate(
        [{ transform: "translateY(0)" }, { transform: `translateY(${delta}px)` }],
        { duration: NUDGE_MS, easing: HAND_OFF_EASING, composite: "add", fill: "forwards" },
      );
      slide.onfinish = finish;
    } else {
      finish();
    }
  }, [phase, flightDone, promptShown, timedOut, onDone]);

  const shellChangedRef = useRef(false);
  useEffect(() => {
    // Nothing to do for the initial default: the tab already starts there.
    if (!shellChangedRef.current) {
      shellChangedRef.current = true;
      return;
    }
    if (!leaving) onShellChange(chosenShell());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell]);

  const chosenShell = () => (sameShell(shell, defaultShell) ? undefined : shell);

  const launchRecent = (r: RecentTerminal) =>
    launch({ shell: r.shell, cwd: r.cwd, command: r.command, typeOnly: true });
  const launchFavorite = (f: FavoriteFolder) => launch({ shell: f.shell, cwd: f.path });
  /** Recents first, then favorites: one list, walked with the arrow keys and
   * numbered in that order. */
  const rowCount = recents.length + favorites.length;
  const launchRow = (index: number) => {
    if (index < recents.length) launchRecent(recents[index]);
    else if (favorites[index - recents.length]) launchFavorite(favorites[index - recents.length]);
  };
  /** The digit that picks row `i` from an empty command line - only the
   * first nine rows have one. */
  const rowKey = (i: number) => (i < 9 ? String(i + 1) : " ");
  const rowId = (i: number) => `newtab-row-${i}`;

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Up and down on the prompt walk the shell's history, like a real
    // prompt; down past the newest entry (the user's own line) walks into
    // the list below instead, and up from its first row comes back.
    if (e.key === "ArrowUp" && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      if (selected >= 0) {
        setSelected((s) => s - 1);
      } else if (historyIndex + 1 < history.length) {
        if (historyIndex < 0) draftRef.current = command;
        showLine(history[history.length - 2 - historyIndex], historyIndex + 1);
      }
      return;
    }
    if (e.key === "ArrowDown" && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      if (historyIndex >= 0) {
        const next = historyIndex - 1;
        showLine(next < 0 ? draftRef.current : history[history.length - 1 - next], next);
      } else if (rowCount > 0) {
        setSelected((s) => Math.min(rowCount - 1, s + 1));
      }
      return;
    }
    if (e.key === "Escape" && selected >= 0) {
      e.preventDefault();
      setSelected(-1);
      return;
    }
    // An empty line plus a digit picks that row, like `[1]` on screen.
    if (!command && !e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      const index = Number(e.key) - 1;
      if (index < rowCount) {
        e.preventDefault();
        launchRow(index);
        return;
      }
    }
    if (e.altKey && /^[1-9]$/.test(e.key)) {
      const opt = chips[Number(e.key) - 1];
      if (opt) {
        e.preventDefault();
        setShell(chipShell(opt));
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (selected >= 0) {
        launchRow(selected);
        return;
      }
      const trimmed = command.trim();
      launch({ shell: chosenShell(), command: trimmed || undefined });
    }
  }

  const row = (i: number, name: string, detail: string, isPath: boolean, shellId: string | undefined, when: string, title: string, onClick: () => void) => (
    <button
      key={rowId(i)}
      id={rowId(i)}
      type="button"
      className={"newtab-row" + (i === selected ? " is-selected" : "")}
      title={title}
      tabIndex={-1}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className="newtab-row-mark" aria-hidden="true">
        {i === selected ? "▸" : ""}
      </span>
      <span className="newtab-row-key">{rowKey(i)}</span>
      <span className="newtab-row-name">{name}</span>
      <span className={"newtab-row-cmd" + (isPath ? " is-path" : "")}>{detail}</span>
      <span className="newtab-row-shell">
        <span className="newtab-shell-icon">{shellOptionIcon(shellId ?? defaultShell)}</span>
        {labelOf(shellId)}
      </span>
      <span className="newtab-row-when">{when}</span>
    </button>
  );

  const style = {
    "--newtab-cell": grid ? `${grid.cellHeight}px` : `${Math.round(termFontSize * 1.2)}px`,
    fontSize: termFontSize,
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className={
        "newtab" +
        (leaving ? " is-leaving" : "") +
        (phase !== "page" ? " is-overlay" : "") +
        (phase === "fading" ? " is-fading" : "")
      }
      style={style}
      hidden={hidden}
    >
      {realFrame && <canvas ref={realCanvasRef} className="newtab-catch" aria-hidden="true" />}

      {catchRows && (
        <div className="newtab-catch" aria-hidden="true">
          {catchRows.map((segments, i) => (
            <div key={i} className="newtab-line">
              {segments.map((s, j) => (
                <span key={j} style={s.style}>
                  {s.text}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      {lines.length > 0 && (
        <div className="newtab-banner" aria-hidden="true">
          {lines.map((segments, i) => (
            <div key={i} className="newtab-line">
              {segments.map((s, j) => (
                <span key={j} style={s.style}>
                  {s.text}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      <label ref={promptRef} className="newtab-prompt">
        <span ref={psRef} className="newtab-ps">
          {flyPrompt ?? promptFor(shell, defaultLabel, startDir)}
        </span>
        <input
          ref={inputRef}
          id="newtab-command"
          className={"newtab-input" + (selected >= 0 ? " is-away" : "")}
          value={command}
          onChange={(e) => {
            setCommand(e.target.value);
            setSelected(-1);
            setHistoryIndex(-1);
          }}
          onKeyDown={onKeyDown}
          placeholder={t("newTab.placeholder")}
          autoComplete="off"
          spellCheck={false}
          aria-label={t("newTab.commandLabel")}
          aria-controls="newtab-list"
          aria-activedescendant={selected >= 0 ? rowId(selected) : undefined}
        />
      </label>

      <div className="newtab-below">
        <div id="newtab-list" className="newtab-list">
          <section className="newtab-section">
            <h2 className="newtab-heading">
              <span>#</span> {t("newTab.recents")}
            </h2>
            {recents.length === 0 ? (
              <p className="newtab-empty">{t("newTab.recentsEmpty")}</p>
            ) : (
              recents.map((r, i) =>
                row(i, r.name, r.command, false, r.shell, relativeTime(r.at), r.cwd, () => launchRecent(r)),
              )
            )}
          </section>
          <section className="newtab-section">
            <h2 className="newtab-heading">
              <span>#</span> {t("favorites.title")}
            </h2>
            {favorites.length === 0 ? (
              <p className="newtab-empty">{t("newTab.favoritesEmpty")}</p>
            ) : (
              favorites.map((f, i) =>
                row(recents.length + i, f.name, shownPath(f.path), true, f.shell, "", f.path, () => launchFavorite(f)),
              )
            )}
          </section>
        </div>

        <div className="newtab-foot">
          <div className="newtab-chips" role="group" aria-label={t("newTab.shellLabel")}>
            {chips.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className="newtab-chip"
                aria-pressed={chipShell(opt) === shell}
                onClick={() => {
                  setShell(chipShell(opt));
                  inputRef.current?.focus();
                }}
              >
                <span className="newtab-shell-icon">{shellOptionIcon(opt.id)}</span>
                {shellOptionLabel(opt)}
              </button>
            ))}
          </div>
          <span className="newtab-keys">
            {selected >= 0 ? t("newTab.keysList") : t("newTab.keys", { count: Math.min(chips.length, 9) })}
          </span>
        </div>
      </div>
    </div>
  );
}
