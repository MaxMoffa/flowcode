import { createElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NewTabPluginManifest } from "../../shared/newTabBridge";
import type { ViewPluginManifest } from "../../shared/agentViewBridge";
import "./builtins";
import { PluginNewTab } from "./PluginNewTab";
import { newTabLayout, newTabLayouts, registerNewTabLayout, unregisterNewTabLayout } from "./layouts";
import type { NewTabLayoutProps } from "./types";

/** The manifest each registered plugin layout was built from: one that is
 * unchanged keeps its component, so an open page is not reloaded. */
const registered = new Map<string, string>();
/** Per layout id, how many times it was reinstalled: part of the iframe's url, so
 * a reinstall with an unchanged manifest still loads the new files. */
const revisions = new Map<string, number>();

/** Reads the installed new tab plugins and brings the registry in line:
 * layouts gone are unregistered, the others (re)registered. Called at startup
 * and after an install or a delete. `reinstalled` is the id of a layout whose
 * files were just replaced: its open pages are remounted even if its manifest
 * is the same. */
export async function loadPluginNewTabs(reinstalled?: string) {
  if (reinstalled) {
    revisions.set(reinstalled, (revisions.get(reinstalled) ?? 0) + 1);
    registered.delete(reinstalled);
  }
  const manifests = await invoke<(ViewPluginManifest | NewTabPluginManifest)[]>("view_plugins_list");
  // Offered here, and not shadowing a built-in layout.
  const usable = manifests.filter(
    (m): m is NewTabPluginManifest => m.kind === "newTab" && m.devices.includes("desktop") && newTabLayout(m.id)?.source !== "builtin",
  );
  const keep = new Set(usable.map((m) => m.id));
  for (const layout of newTabLayouts()) {
    if (layout.source === "plugin" && !keep.has(layout.id)) {
      unregisterNewTabLayout(layout.id);
      registered.delete(layout.id);
    }
  }
  for (const manifest of usable) {
    const signature = JSON.stringify(manifest);
    if (registered.get(manifest.id) === signature) continue;
    registered.set(manifest.id, signature);
    unregisterNewTabLayout(manifest.id);
    const rev = revisions.get(manifest.id);
    registerNewTabLayout({
      id: manifest.id,
      label: manifest.label,
      labels: manifest.labels,
      source: "plugin",
      component: (props: NewTabLayoutProps) => createElement(PluginNewTab, { manifest, rev, ...props }),
    });
  }
}
