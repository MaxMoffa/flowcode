import { t } from "./i18n";
import type { UsageItem } from "./remote";

export interface ProfileGroup {
  key: string;
  title: string;
  color?: string;
  items: UsageItem[];
}

const AGENT_ORDER = ["claude-code", "codex-cli", "mistral-vibe", "gemini-cli", "opencode", "cline"];

/** Usage plugin of each agent CLI (`Tab.cli`). */
const PLUGIN_OF: Record<string, string> = { claude: "claude-code", codex: "codex-cli", vibe: "mistral-vibe", gemini: "gemini-cli", opencode: "opencode", cline: "cline" };

/** The agent CLI (`Tab.cli`) of each usage plugin. */
export const CLI_OF: Record<string, string> = Object.fromEntries(Object.entries(PLUGIN_OF).map(([cli, plugin]) => [plugin, cli]));

/** `focus`: the agent of the terminal being viewed - its profile's group leads, and its card leads every group. */
export function groupByProfile(usage: UsageItem[], focus?: { plugin: string; profile: string }): ProfileGroup[] {
  const groups = new Map<string, ProfileGroup>();
  for (const u of usage) {
    const key = u.profile ?? "";
    let g = groups.get(key);
    if (!g) {
      g = { key, title: key ? (u.profileName ?? key) : t("defaultProfile"), color: u.profileColor, items: [] };
      groups.set(key, g);
    }
    g.color ??= u.profileColor;
    g.items.push(u);
  }
  const order = (id: string) => {
    if (id === focus?.plugin) return -1;
    const i = AGENT_ORDER.indexOf(id);
    return i < 0 ? AGENT_ORDER.length : i;
  };
  for (const g of groups.values()) g.items.sort((x, y) => order(x.pluginId) - order(y.pluginId));
  // The viewed agent's profile leads, then the default one, then the named ones in arrival order.
  const rank = (g: ProfileGroup) => (focus && g.key === focus.profile && g.items.some((u) => u.pluginId === focus.plugin) ? -2 : g.key === "" ? -1 : 0);
  return [...groups.values()].sort((x, y) => rank(x) - rank(y));
}
