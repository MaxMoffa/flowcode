import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readString, writeString } from "../lib/storage";
import { CLI_INFO } from "../agents/cliInfo";
import {
  PLUGINS_SEEDED_KEY,
  PLUGINS_MIGRATED_KEY,
  VIBE_PLUGIN_SEEDED_KEY,
  GEMINI_PLUGIN_SEEDED_KEY,
  OPENCODE_PLUGIN_SEEDED_KEY,
  CLINE_PLUGIN_SEEDED_KEY,
} from "../app/appPrefs";
import { useI18n } from "../i18n";
import { builtinPlugins, examplePlugins } from "./registry";
import type { PluginDef, PluginManifest } from "./types";

/** The plugin list (built-in + the user's files), the toast and the dialog the
 * plugins raise, and the seeding/add/delete of the plugin files. */
export function usePluginHost(
  setQuickActionIds: (update: (prev: string[]) => string[]) => void,
  pinToQuickActions: (ids: string[]) => void,
) {
  const { t, language } = useI18n();
  const [customPlugins, setCustomPlugins] = useState<PluginDef[]>([]);
  const [pluginToast, setPluginToast] = useState<string | null>(null);
  const [pluginDialog, setPluginDialog] = useState<PluginDef | null>(null);
  const pluginToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Installs the example plugins (see registry.ts) once, ever - a flag in
   * localStorage (not "is the file missing") tracks that, so deleting one
   * later doesn't bring it back on the next launch. Also runs a one-time
   * migration for anyone who already had the first shipped shape of these
   * two (a "dialog" chooser popup) - superseded by launching directly on
   * click, with account status moved to the hover popover instead.
   * An install seeded before Mistral Vibe shipped gets its plugin added once
   * too - listed in the plugin menu, not pinned to a bar the user arranged. */
  async function seedExamplePlugins() {
    const seededBefore = !!readString(PLUGINS_SEEDED_KEY);
    try {
      const existing = await invoke<PluginManifest[]>("list_plugins");
      const byId = new Map(existing.map((p) => [p.id, p]));

      if (!readString(PLUGINS_MIGRATED_KEY)) {
        const migratedIds: string[] = [];
        for (const manifest of examplePlugins()) {
          const current = byId.get(manifest.id);
          if (current && current.action !== manifest.action) {
            await invoke("save_plugin", { plugin: manifest });
            migratedIds.push(manifest.id);
          }
        }
        // Pin them to the shortcut bar too - the account-status ring/popover
        // this migration exists for is only visible there.
        pinToQuickActions(migratedIds);
      }

      // The installer's "Integrazioni" step: enable and pin exactly what was
      // picked there (reinstalls included - an already-present plugin just
      // gets re-pinned), and skip the blanket seeding below, which would
      // otherwise add back whatever was left unchecked.
      const chosen = await invoke<string[] | null>("take_installer_features").catch(() => null);
      if (chosen) {
        const chosenIds: string[] = [];
        for (const manifest of examplePlugins()) {
          if (!chosen.includes(manifest.id)) continue;
          if (!byId.has(manifest.id)) await invoke("save_plugin", { plugin: manifest });
          chosenIds.push(manifest.id);
        }
        pinToQuickActions(chosenIds);
        writeString(PLUGINS_SEEDED_KEY, "1");
      }

      if (!readString(PLUGINS_SEEDED_KEY)) {
        const newIds: string[] = [];
        for (const manifest of examplePlugins()) {
          if (!byId.has(manifest.id)) {
            await invoke("save_plugin", { plugin: manifest });
            newIds.push(manifest.id);
          }
        }
        pinToQuickActions(newIds);
      } else if (seededBefore && !chosen && !readString(VIBE_PLUGIN_SEEDED_KEY) && !byId.has(CLI_INFO.vibe.pluginId)) {
        const vibe = examplePlugins().find((p) => p.id === CLI_INFO.vibe.pluginId);
        if (vibe) await invoke("save_plugin", { plugin: vibe });
      }
      if (seededBefore && !chosen && !readString(GEMINI_PLUGIN_SEEDED_KEY) && !byId.has(CLI_INFO.gemini.pluginId)) {
        const gemini = examplePlugins().find((p) => p.id === CLI_INFO.gemini.pluginId);
        if (gemini) await invoke("save_plugin", { plugin: gemini });
      }
    } catch {
      /* plugins folder unavailable (e.g. dev in a plain browser) */
    }
    writeString(PLUGINS_MIGRATED_KEY, "1");
    writeString(PLUGINS_SEEDED_KEY, "1");
    writeString(VIBE_PLUGIN_SEEDED_KEY, "1");
    writeString(GEMINI_PLUGIN_SEEDED_KEY, "1");
    writeString(OPENCODE_PLUGIN_SEEDED_KEY, "1");
    writeString(CLINE_PLUGIN_SEEDED_KEY, "1");
  }

  async function reloadCustomPlugins() {
    try {
      const list = await invoke<PluginManifest[]>("list_plugins");
      setCustomPlugins(list.map((m) => ({ ...m, builtin: false })));
    } catch {
      /* plugins folder unavailable (e.g. dev in a plain browser) */
    }
  }

  async function addPlugin(manifest: PluginManifest) {
    try {
      await invoke("save_plugin", { plugin: manifest });
      await reloadCustomPlugins();
    } catch (e) {
      window.alert(t("plugins.saveFailed", { error: String(e) }));
    }
  }

  async function deletePlugin(id: string) {
    try {
      await invoke("delete_plugin", { id });
      await reloadCustomPlugins();
      setQuickActionIds((prev) => prev.filter((x) => x !== id));
    } catch (e) {
      window.alert(t("plugins.deleteFailed", { error: String(e) }));
    }
  }

  useEffect(
    () => () => {
      if (pluginToastTimerRef.current) clearTimeout(pluginToastTimerRef.current);
    },
    [],
  );

  // Built-in labels come from t(), so a language change rebuilds them.
  const allPlugins = useMemo<PluginDef[]>(
    () => [...builtinPlugins(), ...customPlugins],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customPlugins, language],
  );

  function showPluginToast(message: string) {
    setPluginToast(message);
    if (pluginToastTimerRef.current) clearTimeout(pluginToastTimerRef.current);
    pluginToastTimerRef.current = setTimeout(() => setPluginToast(null), 2600);
  }

  return { allPlugins, pluginToast, pluginDialog, setPluginDialog, showPluginToast, seedExamplePlugins, reloadCustomPlugins, addPlugin, deletePlugin };
}
