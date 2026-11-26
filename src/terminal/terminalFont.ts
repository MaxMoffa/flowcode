const LINUX = typeof navigator !== "undefined" && /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);

/** The terminals' font. On Linux, Menlo and Consolas are never asked for: fontconfig answers any
 * name with its closest font, and where it aliases them to a proportional one WebKitGTK takes it
 * (Omarchy) - xterm then lays each glyph in a fixed cell and the text comes out with ragged gaps.
 * There, real monospace families come first, then the generic one (fontconfig's `monospace`). */
export const TERMINAL_FONT = LINUX
  ? '"JetBrains Mono", "JetBrainsMono Nerd Font", "DejaVu Sans Mono", "Liberation Mono", "Noto Sans Mono", "Ubuntu Mono", monospace'
  : "Menlo, Consolas, monospace";

// For the CSS that must match a terminal cell for cell (the new tab page).
if (typeof document !== "undefined") document.documentElement.style.setProperty("--term-font", TERMINAL_FONT);
