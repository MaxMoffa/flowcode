import { useEffect, useState } from "react";
import { AGENT_CLIS, defaultCliStatus, type AgentCli } from "./cliInfo";
import type { ProfileInfo } from "../profiles/profiles";

/** Whether a CLI is installed under the default profile. A
 * failed check counts as available. */
const defaultProfileCliOk = (cli: AgentCli): Promise<boolean> =>
  defaultCliStatus(cli).then((st) => (st ? st.installed : true));

/** Installed agents remain available before their first login: launch opens
 * the provider dialog when authentication is missing. */
export function useAvailableClis(account: ProfileInfo | undefined): AgentCli[] {
  // Installation is shared across account profiles; login is checked at launch.
  const [defaultOk, setDefaultOk] = useState<Partial<Record<AgentCli, boolean>>>({});

  const profileId = account?.id;
  useEffect(() => {
    let cancelled = false;
    void Promise.all(AGENT_CLIS.map((cli) => defaultProfileCliOk(cli).then((ok) => [cli, ok] as const))).then((entries) => {
      if (!cancelled) setDefaultOk(Object.fromEntries(entries) as Partial<Record<AgentCli, boolean>>);
    });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  return AGENT_CLIS.filter((cli) => defaultOk[cli] ?? true);
}
