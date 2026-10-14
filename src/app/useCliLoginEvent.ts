// The usage popover's "Sign in" button, which reaches the shell as a window
// event since the popover is portaled far from App.
import { useEffect, useRef } from "react";
import { CLI_INFO } from "../agents/cliInfo";

/** Only the known login commands are honoured. */
export function useCliLoginEvent(openTerminalWithCommand: (command: string, profileId?: string) => void) {
  const openLoginRef = useRef(openTerminalWithCommand);
  openLoginRef.current = openTerminalWithCommand;
  useEffect(() => {
    const onCliLogin = (e: Event) => {
      const { command, profile } = (e as CustomEvent<{ command?: string; profile?: string }>).detail ?? {};
      if (!command || !Object.values(CLI_INFO).some((c) => c.loginCommand === command)) return;
      openLoginRef.current(command, profile);
    };
    window.addEventListener("flowcode:cli-login", onCliLogin);
    return () => window.removeEventListener("flowcode:cli-login", onCliLogin);
  }, []);
}
