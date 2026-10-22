import { useEffect, useState } from "react";
import { AGENT_CLIS, defaultCliStatus, type AgentCli } from "./cliInfo";
import type { ProfileInfo } from "../profiles/profiles";

/** Whether a CLI is installed and signed in under the default profile. A
 * failed check counts as available. */
const defaultProfileCliOk = (cli: AgentCli): Promise<boolean> =>
  defaultCliStatus(cli).then((st) => (st ? st.installed && st.logged_in : true));

/** The agent CLIs worth offering: the ones `account` is signed in to, or -
 * for the default profile (`account` undefined) - the ones installed and
 * signed in. Every CLI until the default profile's check is back. */
export function useAvailableClis(account: ProfileInfo | undefined): AgentCli[] {
  // Which CLIs are signed in under the default profile; empty until checked.
  const [defaultOk, setDefaultOk] = useState<Partial<Record<AgentCli, boolean>>>({});

  const useDefaultAccount = !account;
  useEffect(() => {
    if (!useDefaultAccount) return;
    let cancelled = false;
    void Promise.all(AGENT_CLIS.map((cli) => defaultProfileCliOk(cli).then((ok) => [cli, ok] as const))).then((entries) => {
      if (!cancelled) setDefaultOk(Object.fromEntries(entries) as Partial<Record<AgentCli, boolean>>);
    });
    return () => {
      cancelled = true;
    };
  }, [useDefaultAccount]);

  return AGENT_CLIS.filter((cli) => (account ? account.logged_in[cli] === true : (defaultOk[cli] ?? true)));
}
