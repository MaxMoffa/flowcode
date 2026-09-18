import type { ReactNode } from "react";
import type { PluginDef } from "./types";

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
};

const GENERIC_ICON = (
  <svg {...svgProps} strokeWidth={1.7}>
    <path d="M9 4.5h3v2.3a1.5 1.5 0 0 0 3 0V4.5h3v3h2.3a1.5 1.5 0 0 1 0 3H18v3h2.3a1.5 1.5 0 0 1 0 3H18v3h-3v-2.3a1.5 1.5 0 0 0-3 0V19.5H9v-3H6.7a1.5 1.5 0 0 1 0-3H9v-3H6.7a1.5 1.5 0 0 1 0-3H9z" />
  </svg>
);

/** Real icon for a plugin - hardcoded look for the app's own core actions,
 * the manifest's own SVG path for everything else, generic only when
 * neither is set. Shared by the header/menu and the Funzionalità table so
 * they never disagree. */
export function pluginIconNode(plugin: PluginDef): ReactNode {
  if (BUILTIN_ICONS[plugin.id]) return BUILTIN_ICONS[plugin.id];
  if (plugin.icon) {
    return (
      <svg {...svgProps} strokeWidth={1.7}>
        <path d={plugin.icon} />
      </svg>
    );
  }
  return GENERIC_ICON;
}
