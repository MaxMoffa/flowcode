import { createThemeTokens, type Theme } from "@flowkit-io/themes";

/** Maps Flowkit's token set onto Flowcode's own palette (src/themes/themes.css)
 * so the welcome flow reads as part of the app, not a bolted-on widget.
 * Values are copied straight from themes.css rather than re-derived, so the
 * two stay in sync whenever that file's palette changes. */
const light = createThemeTokens(
  {
    text: "#3a2b17",
    text2: "#8b7457",
    canvas: "#fffaf1",
    soft: "rgba(140, 88, 32, 0.06)",
    surface: "#fbf3e4",
    border: "rgba(120, 80, 36, 0.16)",
    accent: "#4f6e3a",
    accentSoft: "rgba(79, 110, 58, 0.16)",
    success: "#4f6e3a",
    successSoft: "rgba(79, 110, 58, 0.16)",
    warning: "#a8683a",
    warningSoft: "rgba(168, 104, 58, 0.18)",
    danger: "#d6544a",
    dangerSoft: "rgba(214, 84, 74, 0.14)",
  },
  {
    radiusSm: "6px",
    radiusMd: "10px",
    radiusLg: "14px",
    radiusXl: "20px",
    fonts: {
      heading: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      body: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    },
    layout: { progressVariant: "bar" },
    animation: { name: "fade", duration: 200 },
  },
);

const dark = createThemeTokens(
  {
    text: "#e7d8c5",
    text2: "#a08a6f",
    canvas: "#0e0a07",
    soft: "rgba(232, 184, 128, 0.05)",
    surface: "#161009",
    border: "rgba(232, 184, 128, 0.12)",
    accent: "#9db984",
    accentSoft: "rgba(139, 168, 118, 0.22)",
    success: "#9db984",
    successSoft: "rgba(139, 168, 118, 0.22)",
    warning: "#c9975a",
    warningSoft: "rgba(201, 151, 90, 0.2)",
    danger: "#e2645c",
    dangerSoft: "rgba(226, 100, 92, 0.16)",
  },
  {
    radiusSm: "6px",
    radiusMd: "10px",
    radiusLg: "14px",
    radiusXl: "20px",
    fonts: {
      heading: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      body: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    },
    layout: { progressVariant: "bar" },
    animation: { name: "fade", duration: 200 },
  },
);

export const flowcodeFlowTheme: Theme = {
  name: "flowcode",
  label: "Flowcode",
  light,
  dark,
};
