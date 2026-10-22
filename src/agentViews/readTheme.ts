import { THEME_TOKENS, type ViewTheme } from "../../shared/agentViewBridge";

const MONO_FONT = "ui-monospace, Consolas, monospace";
/** Tokens that are another app variable under a name of their own. */
const TOKEN_ALIASES: Record<string, string> = { "--warning": "--ansi-bright-yellow", "--info": "--ansi-blue" };

/** The app's resolved colors and fonts, as the view gets them. */
export function readTheme(scheme: ViewTheme["scheme"]): ViewTheme {
  const root = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of THEME_TOKENS) {
    if (name === "--font-ui") tokens[name] = getComputedStyle(document.body).fontFamily;
    else if (name === "--font-mono") tokens[name] = root.getPropertyValue(name).trim() || MONO_FONT;
    else tokens[name] = root.getPropertyValue(TOKEN_ALIASES[name] ?? name).trim();
  }
  return { scheme, tokens };
}
