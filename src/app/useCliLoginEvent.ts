// The usage popover's "Sign in" button, which reaches the shell as a window
// event since the popover is portaled far from App.
import { useEffect } from "react";
import { AGENT_CLIS, CLI_INFO } from "../agents/cliInfo";
import { openProviderAuth } from "../profiles/providerAuth";

/** Only the known login commands are honoured. */
export function useCliLoginEvent() {
  useEffect(() => {
    const onCliLogin = (e: Event) => {
      const { command, profile } = (e as CustomEvent<{ command?: string; profile?: string }>).detail ?? {};
      const cli = AGENT_CLIS.find((candidate) => CLI_INFO[candidate].loginCommand === command);
      if (cli) void openProviderAuth(cli, profile);
    };
    window.addEventListener("flowcode:cli-login", onCliLogin);
    return () => window.removeEventListener("flowcode:cli-login", onCliLogin);
  }, []);
}
