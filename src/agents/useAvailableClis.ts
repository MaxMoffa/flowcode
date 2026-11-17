import { useEffect, useState } from "react";
import { AGENT_CLIS, cachedCliStatus, defaultCliStatus, type AgentCli } from "./cliInfo";
import type { ProfileInfo } from "../profiles/profiles";

type Installed = Partial<Record<AgentCli, boolean>>;

/** Whether a CLI is installed under the default profile. A
 * failed check counts as available. */
const defaultProfileCliOk = (cli: AgentCli): Promise<boolean> =>
  defaultCliStatus(cli).then((st) => (st ? st.installed : true));

/** What the status cache already knows - so a later open renders its final list at once. */
function cachedInstalled(): Installed {
  const known: Installed = {};
  for (const cli of AGENT_CLIS) {
    const st = cachedCliStatus(cli);
    if (st) known[cli] = st.installed;
  }
  return known;
}

/** Installed agents remain available before their first login: launch opens
 * the provider dialog when authentication is missing. Only agents confirmed
 * installed show: until the probe answers, an unknown one stays out rather
 * than appearing and vanishing. */
export function useAvailableClis(account: ProfileInfo | undefined): AgentCli[] {
  // Installation is shared across account profiles; login is checked at launch.
  const [defaultOk, setDefaultOk] = useState<Installed>(cachedInstalled);

  const profileId = account?.id;
  useEffect(() => {
    let cancelled = false;
    void Promise.all(AGENT_CLIS.map((cli) => defaultProfileCliOk(cli).then((ok) => [cli, ok] as const))).then((entries) => {
      if (!cancelled) setDefaultOk(Object.fromEntries(entries) as Installed);
    });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  return AGENT_CLIS.filter((cli) => defaultOk[cli] ?? false);
}
