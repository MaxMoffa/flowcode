import { createElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ViewPluginManifest } from "../../shared/agentViewBridge";
import "./builtins";
import { PluginViewHost } from "./PluginViewHost";
import { agentView, agentViews, registerAgentView, unregisterAgentView } from "./registry";
import type { AgentViewProps } from "./types";

/** The manifest each registered plugin view was built from: one that is
 * unchanged keeps its component, so an open view is not reloaded. */
const registered = new Map<string, string>();
/** Per view id, how many times it was reinstalled: part of the iframe's url, so
 * a reinstall with an unchanged manifest still loads the new files. */
const revisions = new Map<string, number>();

/** Reads the installed view plugins and brings the registry in line: views
 * gone are unregistered, the others (re)registered. Called at startup and
 * after an install or a delete. `reinstalled` is the id of a view whose files
 * were just replaced: its open instances are remounted even if its manifest is
 * the same. */
export async function loadPluginViews(reinstalled?: string) {
  if (reinstalled) {
    revisions.set(reinstalled, (revisions.get(reinstalled) ?? 0) + 1);
    registered.delete(reinstalled);
  }
  const manifests = await invoke<ViewPluginManifest[]>("view_plugins_list");
  // Offered here, and not shadowing a built-in view.
  const usable = manifests.filter((m) => m.devices.includes("desktop") && agentView(m.id)?.source !== "builtin");
  const keep = new Set(usable.map((m) => m.id));
  for (const view of agentViews()) {
    if (view.source === "plugin" && !keep.has(view.id)) {
      unregisterAgentView(view.id);
      registered.delete(view.id);
    }
  }
  for (const manifest of usable) {
    const signature = JSON.stringify(manifest);
    if (registered.get(manifest.id) === signature) continue;
    registered.set(manifest.id, signature);
    unregisterAgentView(manifest.id);
    const rev = revisions.get(manifest.id);
    registerAgentView({
      id: manifest.id,
      label: manifest.label,
      labels: manifest.labels,
      source: "plugin",
      transport: manifest.transport,
      devices: manifest.devices,
      component: (props: AgentViewProps) => createElement(PluginViewHost, { manifest, rev, ...props }),
    });
  }
}
