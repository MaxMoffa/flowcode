import { invoke } from "@tauri-apps/api/core";
import { toWslPath, wslDistroOfPath } from "../terminal/wslPath";
import { examplePlugins } from "../plugins/registry";
import { pluginIconNode } from "../plugins/icons";
import type { PluginDef, PluginButtonDef } from "../plugins/types";
import { readJson, writeJson } from "../lib/storage";
import { atShellPrompt } from "../terminal/shellDialect";
import { cliOfPlugin } from "../agents/cliInfo";
import { PLUGIN_APPROVALS_KEY, isStringArray, commandStamp } from "./appPrefs";
import type { PluginActionsCtx } from "./shellContext";

/** Running plugins (shortcuts bar, Funzionalità menu, dialog buttons). */
export function usePluginActions(S: PluginActionsCtx) {
  const {
    activeTerminal, activeTerminalId, allPlugins, checkCliAndMaybeLaunch, openNewTab, pluginDialog, quickActionIds,
    runInTabLike, runPluginRef, setPluginDialog, showPluginToast, t, tabForeground, termRefs, toggleQuickAction,
    confirm,
  } = S;
  /** Runs the one thing a plugin (or a dialog-plugin's button) is allowed to
   * do - see PLUGINS.md at the repo root for why this stays a fixed, safe
   * vocabulary instead of arbitrary code. */
  function runPlugin(plugin: PluginDef | PluginButtonDef) {
    const command = plugin.action === "runCommand" || plugin.action === "commandOutput" ? plugin.command : undefined;
    // A plugin is a file anyone can drop in the plugins folder (or send): its
    // command is shown and confirmed before the first run, not just typed.
    // The app's own plugins - built in, or an unedited shipped example - are
    // trusted.
    const shipped = "id" in plugin ? examplePlugins().find((p) => p.id === plugin.id) : undefined;
    const trusted =
      !command ||
      ("builtin" in plugin && !!plugin.builtin) ||
      (!!shipped && shipped.action === plugin.action && shipped.command === command);
    if (trusted) {
      runPluginAction(plugin);
      return;
    }
    // A dialog's button belongs to the dialog plugin that is open.
    const owner = "id" in plugin ? plugin.id : (pluginDialog?.id ?? "");
    const approvalKey = `${owner}:${commandStamp(command)}`;
    const approved = readJson(PLUGIN_APPROVALS_KEY, isStringArray, []);
    if (approved.includes(approvalKey)) {
      runPluginAction(plugin);
      return;
    }
    void confirm({
      title: t("plugin.confirmRun.title"),
      message: t("plugin.confirmRun.message", { name: "id" in plugin ? plugin.label : (pluginDialog?.label ?? plugin.label), command }),
      confirmLabel: t("plugin.confirmRun.confirm"),
    }).then((ok) => {
      if (!ok) return;
      writeJson(PLUGIN_APPROVALS_KEY, [...readJson(PLUGIN_APPROVALS_KEY, isStringArray, []), approvalKey]);
      runPluginAction(plugin);
    });
  }

  function runPluginAction(plugin: PluginDef | PluginButtonDef) {
    switch (plugin.action) {
      case "newTerminal":
        openNewTab();
        break;
      case "clearTerminal":
        S.activeTermHandle()?.clear();
        break;
      case "toggleSidebar":
        S.togglePanel("sidebar");
        break;
      case "toggleAgentsSidebar":
        S.toggleAgentTab();
        break;
      case "toggleBrowser":
        S.togglePanel("browser");
        break;
      case "runCommand": {
        if (!plugin.command) break;
        const term = termRefs.current.get(activeTerminalId);
        // Claude Code / Codex CLI / Mistral Vibe take over the whole screen the moment
        // they start - unlike an arbitrary user-defined runCommand plugin,
        // there's no reason to leave the typed launch command sitting in
        // the scrollback above their UI. They're also the only plugins with
        // a known CLI binary behind them, which is what makes the
        // install/login pre-check possible - a plain runCommand plugin has
        // no such notion and always just runs.
        const cliBin = "id" in plugin ? cliOfPlugin(plugin.id) : undefined;
        if (cliBin) {
          checkCliAndMaybeLaunch(cliBin, plugin.command, term, activeTerminalId);
        } else {
          const tabId = activeTerminalId;
          const command = plugin.command;
          void tabForeground(tabId).then((fg) => {
            if (fg && !atShellPrompt(fg)) runInTabLike(tabId, command);
            else term?.runCommand(command);
          });
        }
        break;
      }
      case "notify":
        showPluginToast(plugin.message || plugin.label);
        break;
      case "dialog":
        // Only a top-level PluginDef can carry `action: "dialog"` - a
        // button's action type deliberately excludes it (dialogs don't nest).
        setPluginDialog(plugin as PluginDef);
        break;
      case "commandOutput":
        if (!plugin.command) break;
        // The backend resolves the command from the installed manifest: only the plugin id (and a dialog button's index) goes over.
        invoke<string>("run_plugin_command", {
          pluginId: "id" in plugin ? plugin.id : (pluginDialog?.id ?? ""),
          button: "id" in plugin ? null : (pluginDialog?.buttons?.indexOf(plugin as PluginButtonDef) ?? -1),
        })
          .then((output) => setPluginDialog({ id: "__result", label: plugin.label, action: "dialog", title: plugin.label, message: output }))
          .catch((err) =>
            setPluginDialog({ id: "__result", label: plugin.label, action: "dialog", title: plugin.label, message: String(err) }),
          );
        break;
      case "openInVsCode":
        void openInVsCode();
        break;
    }
  }

  /** The "Apri in VS Code" feature: the active terminal's folder (or the
   * one the explorer is on, before the shell has reported any). A folder
   * inside WSL opens through VS Code's WSL remote, by its Linux path. */
  async function openInVsCode() {
    const tab = activeTerminal;
    if (tab?.nestedShell === "remote") {
      showPluginToast(t("plugin.openInVsCode.remote"));
      return;
    }
    const folder = tab?.cwd || tab?.explorerPath || "";
    if (!folder) {
      showPluginToast(t("plugin.openInVsCode.noFolder"));
      return;
    }
    const distro = wslDistroOfPath(folder);
    const posix = distro ? toWslPath(distro, folder) : null;
    try {
      await invoke("open_in_vscode", { folder: posix ?? folder, wslDistro: posix ? distro : null });
    } catch (e) {
      showPluginToast(
        String(e) === "vscode-not-found"
          ? t("plugin.openInVsCode.notInstalled")
          : t("app.openFailed", { name: "VS Code", error: String(e) }),
      );
    }
  }

  function pluginMenuEntries() {
    return allPlugins.map((p) => ({
      id: p.id,
      label: p.label,
      agent: cliOfPlugin(p.id) !== undefined,
      icon: pluginIconNode(p),
      detail: p.description || (p.builtin ? t("features.builtin") : undefined),
      pinned: quickActionIds.includes(p.id),
      run: () => runPlugin(p),
      onTogglePin: () => toggleQuickAction(p.id),
    }));
  }
  runPluginRef.current = runPlugin;
  return {
    runPlugin, pluginMenuEntries,
  };
}
