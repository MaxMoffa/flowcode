import type { ReactNode } from "react";
import type { PluginDef } from "./types";
import { AGENT_LOGOS } from "../../shared/agentLogos";

const svgProps = {
  viewBox: "0 0 24 24",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  fill: "none",
  stroke: "currentColor",
};

/** The app's own core plugins don't carry an `icon` manifest field (they
 * predate it, and their look is part of the app chrome) - hardcoded here so
 * both the header menu and the Funzionalità table draw the same icon
 * instead of falling back to the generic one. */
const BUILTIN_ICONS: Record<string, ReactNode> = {
  newTab: (
    <svg {...svgProps} strokeWidth={1.8}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <polyline points="7 9.5 10.5 12.5 7 15.5" />
      <line x1="12.5" y1="15.5" x2="16.5" y2="15.5" />
    </svg>
  ),
  clearTerminal: (
    <svg {...svgProps} strokeWidth={1.8}>
      <path d="M4 15.5 13.5 6a2 2 0 0 1 2.8 0l1.7 1.7a2 2 0 0 1 0 2.8L8.5 20H4z" />
      <line x1="12" y1="20" x2="20.5" y2="20" />
    </svg>
  ),
  toggleSidebar: (
    <svg {...svgProps} strokeWidth={1.7}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <line x1="9.5" y1="4.5" x2="9.5" y2="19.5" />
    </svg>
  ),
  browser: (
    <svg {...svgProps} strokeWidth={1.7}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z" />
    </svg>
  ),
};

const GENERIC_ICON = (
  <svg {...svgProps} strokeWidth={1.7}>
    <path d="M9 4.5h3v2.3a1.5 1.5 0 0 0 3 0V4.5h3v3h2.3a1.5 1.5 0 0 1 0 3H18v3h2.3a1.5 1.5 0 0 1 0 3H18v3h-3v-2.3a1.5 1.5 0 0 0-3 0V19.5H9v-3H6.7a1.5 1.5 0 0 1 0-3H9v-3H6.7a1.5 1.5 0 0 1 0-3H9z" />
  </svg>
);

/** The example CLI plugins and "Apri in VS Code" get their real vendor
 * mark instead of the generic line-icon treatment: unlike everything else
 * here these are filled logo paths (not a stroke sketch), so they need their
 * own viewBox and an explicit fill/stroke rather than the shared `svgProps`.
 * Sources: Anthropic's Claude symbol, OpenAI's 2025 blossom symbol and the
 * Visual Studio Code mark (as published by Simple Icons), all single
 * `<path>` marks. */
const LOGO_ICONS: Record<string, { viewBox: string; path: string }> = {
  // The agent marks live in shared/ (the phone draws them too).
  "claude-code": AGENT_LOGOS.claude,
  "codex-cli": AGENT_LOGOS.codex,
  "mistral-vibe": AGENT_LOGOS.vibe,
  "gemini-cli": AGENT_LOGOS.gemini,
  openInVsCode: {
    // Drawn edge-to-edge in its 24x24 box, like the Claude mark: padded the
    // same way so it doesn't look oversized next to the other icons.
    viewBox: "-3.6 -3.6 31.2 31.2",
    path: "M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z",
  },
};

function renderLogo(logo: { viewBox: string; path: string }): ReactNode {
  return (
    <svg viewBox={logo.viewBox}>
      <path d={logo.path} fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Maps a CLI binary short id (`"claude"` / `"codex"` / `"vibe"`, as reported by the
 * backend's `list_agent_sessions`) to its vendor logo - used by the Agents
 * sidebar, which knows about a running CLI process but not the plugin id
 * that happens to be bundled with it (`claude-code` / `codex-cli`). Falls
 * back to the generic icon for anything else. */
export function agentCliIcon(cli: string): ReactNode {
  const logo =
    cli === "claude"
      ? LOGO_ICONS["claude-code"]
      : cli === "codex"
        ? LOGO_ICONS["codex-cli"]
        : cli === "vibe"
          ? LOGO_ICONS["mistral-vibe"]
          : cli === "gemini"
            ? LOGO_ICONS["gemini-cli"]
            : undefined;
  return logo ? renderLogo(logo) : GENERIC_ICON;
}

/** Real icon for a plugin - hardcoded look for the app's own core actions,
 * a real vendor logo for the two example CLI plugins and VS Code, the
 * manifest's own SVG path for everything else, generic only when none of
 * those apply. Shared by the header/menu and the Funzionalità table so they
 * never disagree. */
export function pluginIconNode(plugin: PluginDef): ReactNode {
  if (BUILTIN_ICONS[plugin.id]) return BUILTIN_ICONS[plugin.id];
  const logo = LOGO_ICONS[plugin.id];
  if (logo) return renderLogo(logo);
  if (plugin.icon) {
    return (
      <svg {...svgProps} strokeWidth={1.7}>
        <path d={plugin.icon} />
      </svg>
    );
  }
  return GENERIC_ICON;
}
