import { useRef, useState } from "react";
// Side-effect import: registers every builtin step component (intro,
// long-content, select-cards, confirmation...) - `/overlay` itself registers
// none, per its own docs, and needs this (or `/lean` + `/steps/*`) alongside it.
import "@flowkit-io/react";
import { FlowOverlay } from "@flowkit-io/react/overlay";
import "@flowkit-io/react/style.css";
import "./welcome-overrides.css";
import { useTheme } from "../themes/ThemeContext";
import { welcomeFlow } from "./welcomeFlowConfig";
import { flowcodeFlowTheme } from "./flowcodeFlowTheme";

/** Same try/catch-guarded localStorage pattern as SHOW_HIDDEN_KEY
 * (src/sidebar/FileTree.tsx) - a missing/blocked storage just means the
 * flow shows again next launch instead of throwing. */
const WELCOME_SEEN_KEY = "flowcode.hasSeenWelcome";

function hasSeenWelcome(): boolean {
  try {
    return localStorage.getItem(WELCOME_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markWelcomeSeen() {
  try {
    localStorage.setItem(WELCOME_SEEN_KEY, "1");
  } catch {
    /* storage unavailable */
  }
}

/** First-launch-only welcome/onboarding flow, built on flowkit-io's
 * `FlowOverlay` (a dialog with its own ✕ close button) - mounted inside
 * ThemeProvider (see App.tsx) so it can both read the app's current theme
 * and apply the user's pick from the "theme" step live, via
 * useTheme().setMode - the same store the Settings page itself writes to. */
export function WelcomeFlow() {
  const [open, setOpen] = useState(() => !hasSeenWelcome());
  const { theme, setMode } = useTheme();
  // The confirmation step has no review step above it, so flowkit never runs
  // its own submit path (that only exists for a "review" final step) - its
  // primary button ("Vai a Flowcode") just resets the flow's internal state
  // back to the first step instead (flowkit's "torna alla home" behavior with
  // no `homeUrl` set). `onStepChange` reports that reset as a *second*
  // "initial" direction (the first is the flow's own mount) - that's the only
  // way that direction repeats, since the restart button is hidden
  // (`showRestartButton: false`), so it's a reliable "user finished" signal.
  const initialStepHits = useRef(0);

  function applyThemeAnswer(answers: Record<string, unknown>) {
    const raw = answers.theme;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === "light" || value === "dark" || value === "auto") setMode(value);
  }

  function handleOpenChange(next: boolean) {
    // Every dismissal channel (✕, backdrop, Escape, the confirmation step's
    // own "Vai a Flowcode") lands here - all of them mean the welcome flow is
    // done for good, not just closed for this session.
    if (!next) markWelcomeSeen();
    setOpen(next);
  }

  function handleStepChange(info: { direction: string }) {
    if (info.direction !== "initial") return;
    initialStepHits.current += 1;
    if (initialStepHits.current > 1) handleOpenChange(false);
  }

  // Inverted vs. the terminal's own theme (`theme` from ThemeContext, same
  // value Terminal.tsx reads): a dark terminal sits on a dark OS/desktop
  // background, so a dark flow overlay blends in and loses contrast against
  // it - flipping it keeps the overlay readable regardless of which theme
  // the terminal is on.
  const flowMode = theme === "dark" ? "light" : "dark";

  return (
    <FlowOverlay
      flow={welcomeFlow}
      theme={flowcodeFlowTheme}
      mode={flowMode}
      open={open}
      onOpenChange={handleOpenChange}
      onChange={applyThemeAnswer}
      onStepChange={handleStepChange}
      presentation="dialog"
      showCloseButton
      ariaLabel="Benvenuto in Flowcode"
    />
  );
}
