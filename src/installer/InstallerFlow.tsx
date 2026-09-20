import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
// Side-effect import: registers every builtin step component - see
// WelcomeFlow.tsx's own identical comment for why this (or `/lean` +
// `/steps/*`) has to be present alongside `/overlay`.
import "@flowkit-io/react";
import { FlowOverlay } from "@flowkit-io/react/overlay";
import type { FlowRunnerHandle } from "@flowkit-io/react";
import "@flowkit-io/react/style.css";
import "../welcome/welcome-overrides.css";
import { flowcodeFlowTheme } from "../welcome/flowcodeFlowTheme";
import { installerFlow, type InstallableComponent } from "./installerFlowConfig";
import { cliInstallCommand } from "../cli/cliInstallCommands";

const COMPONENT_LABELS: Record<InstallableComponent, string> = {
  claude: "Claude Code CLI",
  codex: "Codex CLI",
};

/** Standalone installer wizard - a separate entry point from the main app
 * (see main.tsx's `#installer` route), not something opened from inside a
 * running Flowcode. Reuses the same `run_plugin_command` backend command the
 * main app's own "install missing CLI" prompt already runs real install
 * commands through, so there's exactly one trusted code path for that,
 * fronted by two different UIs. Runs each selected component's install
 * command headlessly and in sequence - genuinely executes on the machine
 * once "Installa" is pressed, no dry-run mode. */
export function InstallerFlow() {
  const [open, setOpen] = useState(true);
  const flowRef = useRef<FlowRunnerHandle>(null);
  // No ThemeProvider here (this runs standalone, before the main app's own
  // state exists) - read the OS preference directly, once, same source
  // ThemeContext's own "auto" mode uses.
  const [mode] = useState<"light" | "dark">(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );

  async function handleSubmit(answers: Record<string, unknown>) {
    const raw = answers.components;
    const selected = (Array.isArray(raw) ? raw : raw ? [raw] : []) as InstallableComponent[];

    const isWindows = document.documentElement.dataset.platform === "windows";
    const failures: string[] = [];
    for (const component of selected) {
      try {
        await invoke<string>("run_plugin_command", { command: cliInstallCommand(component, isWindows) });
      } catch (e) {
        failures.push(`${COMPONENT_LABELS[component]}: ${e}`);
      }
    }

    if (failures.length > 0) {
      flowRef.current?.showError({
        title: "Installazione non riuscita",
        message: failures.join("\n"),
      });
      // Re-throwing keeps the review step's own submit state (and flowkit's
      // "don't advance past a failed submit") consistent - `showError`
      // alone only surfaces the message, it doesn't stop the flow moving on.
      throw new Error(failures.join("; "));
    }
  }

  return (
    <FlowOverlay
      ref={flowRef}
      flow={installerFlow}
      theme={flowcodeFlowTheme}
      mode={mode}
      open={open}
      onOpenChange={setOpen}
      onSubmit={handleSubmit}
      presentation="fullscreen"
      dismissible={false}
      showCloseButton={false}
      ariaLabel="Installazione di Flowcode"
    />
  );
}
