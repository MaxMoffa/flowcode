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
  toggleAgentsSidebar: (
    <svg {...svgProps} strokeWidth={1.7}>
      <rect x="4" y="6.5" width="16" height="12" rx="3" />
      <circle cx="9.5" cy="12.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="12.5" r="1.4" fill="currentColor" stroke="none" />
      <line x1="12" y1="6.5" x2="12" y2="3.5" />
      <circle cx="12" cy="2.7" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  ),
};

const GENERIC_ICON = (
  <svg {...svgProps} strokeWidth={1.7}>
    <path d="M9 4.5h3v2.3a1.5 1.5 0 0 0 3 0V4.5h3v3h2.3a1.5 1.5 0 0 1 0 3H18v3h2.3a1.5 1.5 0 0 1 0 3H18v3h-3v-2.3a1.5 1.5 0 0 0-3 0V19.5H9v-3H6.7a1.5 1.5 0 0 1 0-3H9v-3H6.7a1.5 1.5 0 0 1 0-3H9z" />
  </svg>
);

/** The two example CLI plugins get their real vendor mark instead of the
 * generic line-icon treatment: unlike everything else here these are
 * filled logo paths (not a stroke sketch), so they need their own viewBox
 * and an explicit fill/stroke rather than the shared `svgProps`. Sources:
 * Anthropic's Claude symbol and OpenAI's 2025 blossom symbol, both single
 * `<path>` marks. */
const LOGO_ICONS: Record<string, { viewBox: string; path: string }> = {
  "claude-code": {
    // The official mark is drawn edge-to-edge (no built-in margin) - unlike
    // this app's own hand-drawn icons, which sit inset by roughly 15% on
    // each side within their 24x24 box. Padding the viewBox out (rather
    // than the path data itself) shrinks it to read at the same optical
    // size as the rest of the icon set instead of looking oversized.
    viewBox: "-3.6 -3.6 31.2 31.2",
    path: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  },
  "codex-cli": {
    // Same reasoning as claude-code above: the official blossom mark's
    // viewBox is cropped tight to the shape, so it's padded out ~15% here.
    viewBox: "-0.82 -0.73 21.65 21.45",
    path: "M11.248 18.25q-.825 0-1.568-.314a4.3 4.3 0 0 1-1.32-.874 4 4 0 0 1-1.304.214 4 4 0 0 1-2.046-.544 4.27 4.27 0 0 1-1.518-1.485 4 4 0 0 1-.56-2.095q0-.48.131-1.04A4.4 4.4 0 0 1 2.04 10.71a4.07 4.07 0 0 1 .017-3.4 4.2 4.2 0 0 1 1.056-1.418 3.8 3.8 0 0 1 1.6-.842 3.9 3.9 0 0 1 .76-1.683q.593-.759 1.451-1.188a4.04 4.04 0 0 1 1.832-.429q.825 0 1.567.313.742.314 1.32.875a4 4 0 0 1 1.304-.215q1.106 0 2.046.545a4.14 4.14 0 0 1 1.501 1.485q.578.941.578 2.095 0 .48-.132 1.04.66.61 1.023 1.419.363.792.363 1.666 0 .892-.38 1.717a4.3 4.3 0 0 1-1.072 1.435 3.8 3.8 0 0 1-1.584.825 3.8 3.8 0 0 1-.775 1.683 4.06 4.06 0 0 1-1.436 1.188 4.04 4.04 0 0 1-1.832.429m-4.076-2.062q.825 0 1.435-.347l3.103-1.782a.36.36 0 0 0 .164-.313v-1.42L7.881 14.62a.67.67 0 0 1-.726 0l-3.118-1.798a.5.5 0 0 1-.017.115v.198q0 .841.396 1.551.413.693 1.139 1.089a3.2 3.2 0 0 0 1.617.412m.165-2.69a.4.4 0 0 0 .181.05q.083 0 .165-.05l1.238-.71-3.977-2.31a.7.7 0 0 1-.363-.643v-3.58q-.825.362-1.32 1.122a2.9 2.9 0 0 0-.495 1.65q0 .809.413 1.55.412.743 1.072 1.123zm3.91 3.663q.875 0 1.585-.396a2.96 2.96 0 0 0 1.534-2.64v-3.564a.32.32 0 0 0-.165-.297l-1.254-.726v4.604a.7.7 0 0 1-.363.643l-3.119 1.799a3 3 0 0 0 1.783.577m.627-6.039V8.878L10.01 7.822 8.129 8.878v2.244l1.881 1.056zM7.057 5.859a.7.7 0 0 1 .363-.644l3.119-1.798a3 3 0 0 0-1.782-.578q-.874 0-1.584.396A2.96 2.96 0 0 0 6.05 4.324a3.07 3.07 0 0 0-.396 1.551v3.547q0 .199.165.314l1.237.726zm8.383 7.887q.825-.364 1.303-1.123.495-.758.495-1.65a3.15 3.15 0 0 0-.412-1.55q-.413-.743-1.073-1.123l-3.086-1.782q-.099-.065-.181-.049a.3.3 0 0 0-.165.05l-1.238.692 3.993 2.327a.6.6 0 0 1 .264.264.64.64 0 0 1 .1.363zm-3.317-8.382a.63.63 0 0 1 .726 0l3.135 1.831v-.297q0-.792-.396-1.501a2.86 2.86 0 0 0-1.105-1.155q-.71-.43-1.65-.43-.825 0-1.436.347L8.294 5.941a.36.36 0 0 0-.165.314v1.418z",
  },
};

function renderLogo(logo: { viewBox: string; path: string }): ReactNode {
  return (
    <svg viewBox={logo.viewBox}>
      <path d={logo.path} fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Maps a CLI binary short id (`"claude"` / `"codex"`, as reported by the
 * backend's `list_agent_sessions`) to its vendor logo - used by the Agents
 * sidebar, which knows about a running CLI process but not the plugin id
 * that happens to be bundled with it (`claude-code` / `codex-cli`). Falls
 * back to the generic icon for anything else. */
export function agentCliIcon(cli: string): ReactNode {
  const logo = cli === "claude" ? LOGO_ICONS["claude-code"] : cli === "codex" ? LOGO_ICONS["codex-cli"] : undefined;
  return logo ? renderLogo(logo) : GENERIC_ICON;
}

/** Real icon for a plugin - hardcoded look for the app's own core actions,
 * a real vendor logo for the two example CLI plugins, the manifest's own
 * SVG path for everything else, generic only when none of those apply.
 * Shared by the header/menu and the Funzionalità table so they never
 * disagree. */
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
