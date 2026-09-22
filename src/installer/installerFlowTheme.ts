import type { Theme } from "@flowkit-io/themes";
import { flowcodeFlowTheme } from "../welcome/flowcodeFlowTheme";

/** Same palette as the welcome flow's theme (`flowcodeFlowTheme.ts`), but
 * with a loading-bar progress indicator instead of dots - clearer at the
 * top of this flow's narrow 9:16 window. Cloned rather than mutating
 * `flowcodeFlowTheme` directly, since WelcomeFlow.tsx (shown once inside
 * the running app) shares that same object and keeps its own dots. */
export const installerFlowTheme: Theme = {
  ...flowcodeFlowTheme,
  light: { ...flowcodeFlowTheme.light, layout: { ...flowcodeFlowTheme.light.layout, progressVariant: "bar" } },
  dark: { ...flowcodeFlowTheme.dark, layout: { ...flowcodeFlowTheme.dark.layout, progressVariant: "bar" } },
};
