import { useEffect, useMemo, useRef, useState } from "react";
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
import { useI18n } from "../i18n";
import "./installer.css";
// Side-effect import: registers the custom "directory" step type/component
// (flowkit ships no folder-picker step) before `buildInstallerFlow` (parsed
// once the existing-install check settles, below) can reference it.
import "./steps/directoryStepType";
import "./steps/DirectoryStepView";
import { flowcodeFlowTheme } from "../welcome/flowcodeFlowTheme";
import {
  buildInstallerFlow,
  INSTALLABLE_COMPONENTS,
  EXISTING_STEP_ID,
  UPDATE_ACTION,
  type ExistingInstall,
  type InstallableComponent,
} from "./installerFlowConfig";

/** Standalone installer wizard - a separate entry point from the main app
 * (see main.tsx's `#installer` route), meant to run as its own executable
 * (`flowcode-installer.exe`) pointed at this same built frontend. Does the
 * real install work on submit (copy files, shortcuts, uninstall registry
 * entry - see `installer_run` on the Rust side, a different backend from the
 * main app's) and records which integrations were picked, for the app to
 * enable on its first launch - no CLI is installed from here. */
export function InstallerFlow() {
  const { t } = useI18n();
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
  // A Flowcode already on this machine turns the wizard into a one-click
  // update (see buildInstallerFlow) - looked up before the flow is built,
  // since that choice decides both the flow's first step and its wording.
  const [existing, setExisting] = useState<ExistingInstall | null>(null);
  const [installerVersion, setInstallerVersion] = useState("");

  useEffect(() => {
    Promise.all([
      invoke<string>("installer_default_dir").catch(() => ""),
      invoke<ExistingInstall | null>("installer_existing_install").catch(() => null),
      invoke<string>("installer_version").catch(() => ""),
    ]).then(([dir, found, version]) => {
      // No default resolvable (e.g. running outside the installer binary) -
      // still open, just with an empty field the user fills in. An existing
      // install's folder wins, so "Installazione personalizzata" starts from
      // where Flowcode already is rather than a second copy elsewhere.
      const location = found?.dir || dir;
      installDirRef.current = location;
      setExisting(found);
      setInstallerVersion(version);
      setDefaultLocation(location);
      setOpen(true);
    });
  }, []);

  const flow = useMemo(() => buildInstallerFlow(existing, installerVersion), [existing, installerVersion]);

  async function handleSubmit(answers: Record<string, unknown>) {
    try {
      await runInstall(answers);
    } catch (e) {
      // Re-thrown as an `Error` carrying the final text, on top of passing
      // `onSubmitError`: FlowOverlay (flowkit 1.11.0) doesn't forward that
      // prop to its inner FlowRunner, which then falls back to `.message`.
      throw new Error(installErrorMessage(e));
    }
  }

  async function runInstall(answers: Record<string, unknown>) {
    if (existing && answers.action === UPDATE_ACTION) {
      // Update in place: no shortcut/integration choices were asked, so
      // none are sent - the backend keeps the desktop shortcut as it was
      // and leaves the app's integrations untouched.
      installDirRef.current = existing.dir;
      await invoke("installer_run", { installDir: existing.dir, desktopShortcut: null, features: null });
      return;
    }
    const location = typeof answers.location === "string" && answers.location.trim() ? answers.location.trim() : installDirRef.current;
    installDirRef.current = location;
    const desktopShortcut = Boolean(answers.desktop_shortcut);
    const raw = answers.components;
    const features = (Array.isArray(raw) ? raw : raw ? [raw] : []) as InstallableComponent[];

    await invoke("installer_run", { installDir: location, desktopShortcut, features });
  }

  /** `onSubmitError`: turns a failed `installer_run` into the message shown
   * on the review step. Tauri rejects with the backend's plain error string
   * (not an `Error`), which flowkit on its own would only replace with its
   * generic text - the real reason (folder not writable, Flowcode still
   * running, ...) is exactly what the user needs to see here. */
  function installErrorMessage(error: unknown): string {
    const reason = (error instanceof Error ? error.message : typeof error === "string" ? error : "").trim();
    const failed = t("installer.failedShort");
    if (reason.startsWith(failed)) return reason; // already mapped by handleSubmit
    return reason ? `${failed}: ${reason}` : t("installer.failed");
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
            aria-label={t("window.minimize")}
            title={t("window.minimize")}
            onClick={() => getCurrentWindow().minimize()}
          >
            <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round">
              <line x1="6" y1="12" x2="18" y2="12" />
            </svg>
          </button>
          <button
            type="button"
            className="installer-icon-button installer-icon-button--close"
            aria-label={t("window.close")}
            title={t("window.close")}
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
            flow={flow}
            // Already installed: open straight on "update or customize?".
            initialStep={existing ? EXISTING_STEP_ID : undefined}
            theme={flowcodeFlowTheme}
            mode={mode}
            open={open}
            onOpenChange={setOpen}
            onSubmit={handleSubmit}
            onSubmitError={installErrorMessage}
            onStepChange={handleStepChange}
            // Both integrations pre-checked: matches what a Flowcode started
            // without the installer gets (every example plugin, pinned).
            initialAnswers={{ location: defaultLocation, desktop_shortcut: true, components: [...INSTALLABLE_COMPONENTS] }}
            presentation="fullscreen"
            dismissible={false}
            showCloseButton={false}
            ariaLabel={t("installer.title")}
            container={flowRegion}
          />
        )}
      </div>
    </div>
  );
}
