/** The terminals' font. Linux has neither Menlo nor Consolas, and there the bare generic `monospace`
 * can resolve to a proportional font (WebKitGTK on Omarchy): xterm then lays each glyph in a fixed
 * cell and the text comes out with ragged gaps. Real monospace families of the Linux desktops
 * come before the generic one. */
export const TERMINAL_FONT = 'Menlo, Consolas, "JetBrains Mono", "DejaVu Sans Mono", "Liberation Mono", "Noto Sans Mono", "Ubuntu Mono", monospace';
