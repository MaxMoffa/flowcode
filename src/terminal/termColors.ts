/** --term-bg's RGB as `#rrggbb00`: fully transparent to paint (see the
 * `background` comment below), but xterm still reads the RGB channels -
 * it's what `minimumContrastRatio` checks text against and what it reports
 * to apps that query the background (OSC 11). A plain `#00000000` made both
 * treat every theme as black: dark-tuned colors were left unreadable on the
 * light theme, and apps deriving a panel shade from the reported background
 * drew it off-tone. */
function termBackgroundHex(scope: HTMLElement): string {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;background:var(--term-bg)";
  scope.appendChild(probe);
  const bg = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const [r = 0, g = 0, b = 0] = (bg.match(/[\d.]+/g) ?? []).map(Number);
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}00`;
}

/** Reads the terminal's colours from its own container, not `:root`, so a
 * palette set only for the terminal (see `terminalPaletteId`) is picked up. */
export function readTermColors(scope: HTMLElement) {
  const style = getComputedStyle(scope);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    // The container div already paints --term-bg (same glass surface as the
    // rest of the window). Giving xterm's own canvas a background too would
    // stack two translucent layers on top of each other, compositing to a
    // darker/more opaque result than every other panel - so it stays transparent.
    // xterm.js only accepts hex colors here (it matches /#[\da-f]{3,8}/) -
    // the CSS keyword "transparent" and rgba() syntax silently fail to parse
    // and fall back to opaque black, so this must be 8-digit hex.
    background: termBackgroundHex(scope),
    foreground: v("--term-fg", "#e6e6e6"),
    cursor: v("--accent", "#e6e6e6"),
    cursorAccent: v("--term-bg", "#000000"),
    // xterm.js's own ANSI defaults assume a dark background (pure white/
    // near-white foreground colors), which goes unreadable against the
    // light theme - both palettes are supplied explicitly per theme in
    // themes.css instead of relying on the built-in ones.
    black: v("--ansi-black", "#3a2c1c"),
    red: v("--ansi-red", "#cd3131"),
    green: v("--ansi-green", "#0dbc79"),
    yellow: v("--ansi-yellow", "#e5e510"),
    blue: v("--ansi-blue", "#2472c8"),
    magenta: v("--ansi-magenta", "#bc3fbc"),
    cyan: v("--ansi-cyan", "#11a8cd"),
    white: v("--ansi-white", "#e5e5e5"),
    brightBlack: v("--ansi-bright-black", "#666666"),
    brightRed: v("--ansi-bright-red", "#f14c4c"),
    brightGreen: v("--ansi-bright-green", "#23d18b"),
    brightYellow: v("--ansi-bright-yellow", "#f5f543"),
    brightBlue: v("--ansi-bright-blue", "#3b8eea"),
    brightMagenta: v("--ansi-bright-magenta", "#d670d6"),
    brightCyan: v("--ansi-bright-cyan", "#29b8db"),
    brightWhite: v("--ansi-bright-white", "#e5e5e5"),
    selectionBackground: v("--term-selection-bg", "rgba(120, 150, 200, 0.3)"),
  };
}
