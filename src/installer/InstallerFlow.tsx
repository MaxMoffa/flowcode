import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
// Side-effect import: registers every builtin step component - see
// WelcomeFlow.tsx's own identical comment for why this (or `/lean` +
// `/steps/*`) has to be present alongside `/overlay`.
import "@flowkit-io/react";
import { FlowOverlay } from "@flowkit-io/react/overlay";
import type { FlowRunnerHandle } from "@flowkit-io/react";
import "@flowkit-io/react/style.css";
import "../welcome/welcome-overrides.css";
import "./installer.css";
// Side-effect import: registers the custom "directory" step type/component
// (flowkit ships no folder-picker step) before `installerFlow` (parsed at
// module load, below) can reference it.
import "./steps/directoryStepType";
import "./steps/DirectoryStepView";
import { installerFlowTheme } from "./installerFlowTheme";
import { installerFlow, type InstallableComponent } from "./installerFlowConfig";
import { cliInstallCommand } from "../cli/cliInstallCommands";

const COMPONENT_LABELS: Record<InstallableComponent, string> = {
  claude: "Claude Code CLI",
  codex: "Codex CLI",
};

/** Standalone installer wizard - a separate entry point from the main app
 * (see main.tsx's `#installer` route), meant to run as its own executable
 * (`flowcode-installer.exe`) pointed at this same built frontend. Does the
 * real install work on submit (copy files, shortcuts, uninstall registry
 * entry - see `installer_run` on the Rust side, a different backend from the
 * main app's), then reuses the same `run_plugin_command` contract the main
 * app's own "install missing CLI" prompt runs real install commands
 * through, so there's exactly one trusted code path for that, fronted by
 * two different UIs. Runs each selected component's install command
 * headlessly and in sequence - genuinely executes on the machine once
 * "Installa" is pressed, no dry-run mode. */
export function InstallerFlow() {
  const [open, setOpen] = useState(false);
  const [defaultLocation, setDefaultLocation] = useState<string | null>(null);
  const flowRef = useRef<FlowRunnerHandle>(null);
  // FlowOverlay portals into `document.body` by default (`container` prop,
  // see @flowkit-io/react/overlay) - as a direct child of <body> it sat
  // *outside* `.installer-flow-region` in the real DOM despite being nested
  // there in JSX, so its `position: fixed` overlay covered the titlebar
  // above it completely (and the `transform` containing-block trick in
  // installer.css never applied, since that only affects DOM descendants).
  // Pointing `container` at this div directly fixes both. `useState`, not a
  // plain ref, because the portal target has to exist as of the *next*
  // render for `createPortal` to receive a non-null node - a ref alone
  // wouldn't trigger that re-render when it first attaches.
  const [flowRegion, setFlowRegion] = useState<HTMLDivElement | null>(null);
  // No ThemeProvider here (this runs standalone, before the main app's own
  // state exists) - read the OS preference directly, once, same source
  // ThemeContext's own "auto" mode uses.
  const [mode] = useState<"light" | "dark">(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  // The confirmation step has a review step above it, so flowkit's own
  // submit path already ran by the time it's reached - its primary button
  // ("Apri Flowcode") just resets the flow's internal state back to the
  // first step instead (flowkit's "torna alla home" behavior with no
  // `homeUrl` set). `onStepChange` reports that reset as a *second*
  // "initial" direction (the first is the flow's own mount) - same signal
  // WelcomeFlow.tsx uses for its own confirmation CTA, since flowkit exposes
  // no direct "confirmation CTA clicked" callback.
  const initialStepHits = useRef(0);
  const installDirRef = useRef("");

  useEffect(() => {
    invoke<string>("installer_default_dir")
      .then((dir) => {
        installDirRef.current = dir;
        setDefaultLocation(dir);
        setOpen(true);
      })
      .catch(() => {
        // No default resolvable (e.g. running outside the installer
        // binary) - still open, just with an empty field the user fills in.
        setDefaultLocation("");
        setOpen(true);
      });
  }, []);

  async function handleSubmit(answers: Record<string, unknown>) {
    const location = typeof answers.location === "string" && answers.location.trim() ? answers.location.trim() : installDirRef.current;
    installDirRef.current = location;
    const desktopShortcut = Boolean(answers.desktop_shortcut);

    try {
      await invoke("installer_run", { installDir: location, desktopShortcut });
    } catch (e) {
      flowRef.current?.showError({ title: "Installazione non riuscita", message: String(e) });
      throw e;
    }

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
        title: "Alcuni componenti non sono stati installati",
        message: failures.join("\n"),
      });
      // Re-throwing keeps the review step's own submit state (and flowkit's
      // "don't advance past a failed submit") consistent - `showError`
      // alone only surfaces the message, it doesn't stop the flow moving on.
      throw new Error(failures.join("; "));
    }
  }

  function handleStepChange(info: { direction: string }) {
    if (info.direction !== "initial") return;
    initialStepHits.current += 1;
    if (initialStepHits.current > 1) {
      invoke("installer_launch_app", { installDir: installDirRef.current })
        .catch(() => {})
        .finally(() => getCurrentWindow().close());
    }
  }

  if (!open || defaultLocation === null) return null;

  return (
    <div className="installer-shell">
      <header className="installer-titlebar" data-tauri-drag-region>
        <div className="installer-titlebar-controls">
          <button
            type="button"
            className="installer-icon-button"
            aria-label="Minimizza"
            title="Minimizza"
            onClick={() => getCurrentWindow().minimize()}
          >
            <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round">
              <line x1="6" y1="12" x2="18" y2="12" />
            </svg>
          </button>
          <button
            type="button"
            className="installer-icon-button installer-icon-button--close"
            aria-label="Chiudi"
            title="Chiudi"
            onClick={() => getCurrentWindow().close()}
          >
            <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round">
              <line x1="6.5" y1="6.5" x2="17.5" y2="17.5" />
              <line x1="17.5" y1="6.5" x2="6.5" y2="17.5" />
            </svg>
          </button>
        </div>
      </header>
      <div className="installer-flow-region" ref={setFlowRegion}>
        {flowRegion && (
          <FlowOverlay
            ref={flowRef}
            flow={installerFlow}
            theme={installerFlowTheme}
            mode={mode}
            open={open}
            onOpenChange={setOpen}
            onSubmit={handleSubmit}
            onStepChange={handleStepChange}
            initialAnswers={{ location: defaultLocation, desktop_shortcut: true }}
            presentation="fullscreen"
            dismissible={false}
            showCloseButton={false}
            ariaLabel="Installazione di Flowcode"
            container={flowRegion}
          />
        )}
      </div>
    </div>
  );
}
