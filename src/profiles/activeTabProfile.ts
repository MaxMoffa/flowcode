import { createStore } from "../lib/externalStore";

/** The terminal tab in front in this window and the account profile it was
 * started with (`undefined` = the default one). Set by App; popups that pick
 * a profile start from it and drop their own choice when the tab changes. */
interface ActiveTabProfile {
  tabId: string | undefined;
  profileId: string | undefined;
}

export const activeTabProfile = createStore<ActiveTabProfile>(
  { tabId: undefined, profileId: undefined },
  (a, b) => a.tabId === b.tabId && a.profileId === b.profileId,
);
