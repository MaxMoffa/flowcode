import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentCli } from "../../shared/agentRegistry";

/** Whether each CLI is signed in under a profile - read off its files, see
 * `login_state` in src-tauri/src/profiles.rs. */
export interface LoginState {
  claude: boolean;
  codex: boolean;
  vibe: boolean;
  gemini: boolean;
  opencode: boolean;
}

/** Who a CLI is signed in as - read off its files, see `AccountIdent` in src-tauri/src/profiles.rs. */
export interface AccountIdent {
  kind: "account" | "apiKey";
  label: string | null;
  detail: string | null;
}
export type Accounts = Partial<Record<AgentCli, AccountIdent | null>>;

/** An account profile: its own CLAUDE_CONFIG_DIR / CODEX_HOME / VIBE_HOME / GEMINI_CLI_HOME / OPENCODE_CONFIG_DIR
 * under `dir`. The default profile (the CLIs' usual folders) is never in this
 * list - everywhere it's an absent / `null` / `undefined` profile id. */
export interface ProfileInfo {
  id: string;
  name: string;
  color: string;
  dir: string;
  logged_in: LoginState;
  accounts?: Accounts;
}

interface ProfilesState {
  profiles: ProfileInfo[];
  /** Normalized project folder -> profile id. */
  project_defaults: Record<string, string>;
  /** The default profile's login state (null when its folders can't be found). */
  default_logged_in: LoginState | null;
  /** The default profile's accounts (null when its folders can't be found). */
  default_accounts?: Accounts | null;
}

const EMPTY: ProfilesState = { profiles: [], project_defaults: {}, default_logged_in: null, default_accounts: null };

let state: ProfilesState = EMPTY;
let loaded = false;
let inFlight: Promise<void> | null = null;
/** A refresh was asked for while one was running: that one may predate the
 * change that prompted this call, so one more read follows it. */
let queued = false;
const listeners = new Set<() => void>();

/** Re-reads the profiles from the backend and tells every subscriber. The
 * returned promise settles after a read that started no earlier than this
 * call, so a caller that just changed something sees it. */
export function refreshProfiles(): Promise<void> {
  if (inFlight) {
    queued = true;
    return inFlight;
  }
  const run = (): Promise<void> =>
    invoke<ProfilesState>("profiles_list")
      .then((next) => {
        state = next;
        loaded = true;
        listeners.forEach((listener) => listener());
      })
      // A failed read still counts as loaded (with what was known), or a
      // stored profile choice would hold its usage back forever.
      .catch(() => {
        loaded = true;
        listeners.forEach((listener) => listener());
      })
      .then(() => {
        if (!queued) return;
        queued = false;
        return run();
      });
  inFlight = run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Non-hook access for code outside React (the remote publisher). */
export function getProfilesState(): ProfilesState {
  return state;
}

export function onProfilesChanged(listener: () => void): () => void {
  return subscribe(listener);
}

/** Loads the profiles once if nobody has yet. */
export function ensureProfilesLoaded(): void {
  if (!loaded) void refreshProfiles();
}

/** The profiles, shared by every component that shows them (settings page,
 * "+" menu, tab badges, usage popover): one cache, loaded on first use and
 * re-read after every change made through the helpers below. */
export function useProfiles(): ProfilesState {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (!loaded) void refreshProfiles();
  }, []);
  return snapshot;
}

/** Whether the profiles have been read from the backend at least once - until
 * then a stored profile id can't be told apart from a deleted one. */
export function useProfilesLoaded(): boolean {
  useSyncExternalStore(subscribe, () => state);
  return loaded;
}

/** One line for an account: the email (plus organization/plan with `withDetail`), or "API key · …a1B2". Null when there's nothing to show. */
export function accountText(a: AccountIdent | null | undefined, apiKeyLabel: string, withDetail: boolean): string | null {
  if (!a) return null;
  if (a.kind === "account") {
    if (!a.label) return null;
    return withDetail && a.detail ? `${a.label} · ${a.detail}` : a.label;
  }
  return [apiKeyLabel, a.label, withDetail ? a.detail : null].filter(Boolean).join(" · ");
}

/** The account a CLI is signed in with under a profile (`null`/`undefined`: the default one). */
export function useAccount(profile: string | null | undefined, cli: AgentCli | undefined): AccountIdent | null {
  const { profiles, default_accounts } = useProfiles();
  if (!cli) return null;
  const accounts = profile ? profiles.find((p) => p.id === profile)?.accounts : default_accounts;
  return accounts?.[cli] ?? null;
}

/** The profile with `id`, if it still exists. */
export function profileById(profiles: ProfilesState, id: string | null | undefined): ProfileInfo | undefined {
  return id ? profiles.profiles.find((p) => p.id === id) : undefined;
}

export async function createProfile(name: string, color: string, copySettings: boolean): Promise<string> {
  const created = await invoke<{ id: string }>("profile_create", { name, color, copySettings });
  await refreshProfiles();
  return created.id;
}

export async function updateProfile(id: string, name: string, color: string): Promise<void> {
  await invoke("profile_update", { id, name, color });
  await refreshProfiles();
}

export async function deleteProfile(id: string, deleteFiles: boolean): Promise<void> {
  await invoke("profile_delete", { id, deleteFiles });
  await refreshProfiles();
}

/** Signs `cli` out of profile `id` (null = the default profile). */
export async function logoutProfile(id: string | null, cli: keyof LoginState): Promise<void> {
  try {
    await invoke("profile_logout", { id, cli });
  } finally {
    await refreshProfiles();
  }
}

/** The profile a project folder (or a parent of it) is set to use, if any. */
export function profileForPath(path: string): Promise<string | null> {
  return invoke<string | null>("profile_for_path", { path }).catch(() => null);
}
