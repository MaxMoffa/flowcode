// Wire types of the phone <-> desktop protocol, shared by the phone app
// (mobile/src/remote.ts) and the desktop (remotePublish.ts, the settings
// bridge). Types only, no runtime imports. The Rust source of truth is
// src-tauri/remote-proto/src/msg.rs (serde camelCase); keep the two in step.

export type AgentStatus = "busy" | "idle" | "waiting";

/** How full an agent's context window is (tokens). */
export interface TabContext {
  used: number;
  window: number;
  model?: string;
}

export interface Tab {
  ptyId: string;
  tabId: string;
  /** Label of the desktop window showing the tab. */
  window: string;
  label: string;
  cwd: string;
  cols: number;
  rows: number;
  /** Agent running in the tab (`claude`, `codex`, `vibe`, `gemini`). */
  cli?: string;
  /** Account profile the agent runs under; absent for the default one (and from desktops before 0.11.3). */
  profile?: string;
  status?: AgentStatus;
  context?: TabContext;
}

/** Every field but `kind` is optional and a client ignores a `kind` it doesn't know. */
export interface UsageMetric {
  kind: string;
  label?: string;
  /** 0-1. */
  percent?: number;
  /** When the window resets, as the CLI worded it. */
  resets?: string;
  command?: string;
  period?: string;
  cost?: number;
  tokens?: number;
  sessions?: number;
}

export interface UsageItem {
  pluginId: string;
  label: string;
  profile?: string;
  /** Of `profile`, for grouping on the phone; absent for the default profile. */
  profileName?: string;
  profileColor?: string;
  metrics: UsageMetric[];
}

export interface Action {
  id: string;
  label: string;
  icon?: string;
}

export interface LsEntry {
  name: string;
  dir: boolean;
  size?: number;
}

export type ProfileCli = "claude" | "codex" | "vibe" | "gemini";

/** An account profile on the desktop (the default one is not listed). */
export interface ProfileInfo {
  id: string;
  name: string;
  color: string;
  loggedIn: Record<ProfileCli, boolean>;
}

export type ProfileAction =
  | { op: "create"; name: string; color: string; copySettings: boolean }
  | { op: "update"; id: string; name: string; color: string }
  | { op: "delete"; id: string; deleteFiles: boolean }
  /** `id` `""` = the default profile (also for `logout`). */
  | { op: "login"; id: string; cli: ProfileCli }
  | { op: "logout"; id: string; cli: ProfileCli };

export interface MirroredPalette {
  id: string;
  name: string;
  bg: string;
  accent: string;
  accent2: string;
}

export interface MirroredSettings {
  theme: "auto" | "light" | "dark";
  resolvedTheme: "light" | "dark";
  palette: string;
  terminalPalette: string | null;
  contrast: number;
  glassOpacity: number;
  language: string;
  resolvedLanguage: string;
  languages: { id: string; name: string }[];
  colors: Record<string, string>;
  terminalColors: Record<string, string>;
  palettes: MirroredPalette[];
  terminalFontSize: number;
  bannerEnabled: boolean;
  confirmLinkOpen: boolean;
  restoreSession: boolean;
  newTabPage: boolean;
  notify: { done: boolean; input: boolean; exited: boolean; limitReset: boolean };
  autoResume: { enabled: boolean; message: string };
}

/** The keys of `set` the desktop accepts (see src/remote/settingDefs.ts). */
export type SettingKey =
  | "theme"
  | "palette"
  | "terminalPalette"
  | "contrast"
  | "glassOpacity"
  | "language"
  | "terminalFontSize"
  | "bannerEnabled"
  | "confirmLinkOpen"
  | "restoreSession"
  | "newTabPage"
  | `notify.${keyof MirroredSettings["notify"]}`
  | `autoResume.${keyof MirroredSettings["autoResume"]}`;

/**
 * Features a desktop advertises in `ready.caps` (Rust: `CAPABILITIES` in
 * remote-proto/src/lib.rs). A desktop that sends no `caps` is an old one.
 */
export type RemoteCap = "rename" | "profiles" | "profileLogin" | "profileAgents" | "newTabProfile" | "background" | "gemini";

export type ServerMsg =
  | { t: "ready"; deviceName: string; hostName: string; appVersion?: string; proto?: number; caps?: string[] }
  | { t: "error"; message: string; ptyId?: string; fatal: boolean }
  | { t: "tabs"; tabs: Tab[] }
  | { t: "snapshot"; ptyId: string; data: string; cols: number; rows: number }
  | { t: "output"; ptyId: string; data: string }
  | { t: "exit"; ptyId: string }
  | { t: "usage"; items: UsageItem[] }
  | { t: "actions"; actions: Action[] }
  | { t: "ls"; ptyId: string; path: string; entries: LsEntry[] }
  | { t: "file"; ptyId: string; path: string; text: string; truncated: boolean }
  | { t: "settings"; settings: MirroredSettings }
  | { t: "profiles"; profiles: ProfileInfo[]; defaultLoggedIn?: Record<ProfileCli, boolean> | null }
  | { t: "notify"; title: string; body: string; tabId?: string }
  | { t: "pong" };

export type ClientMsg =
  | { t: "list" }
  | { t: "open"; ptyId: string; cols?: number; rows?: number }
  | { t: "resize"; ptyId: string; cols: number; rows: number }
  | { t: "close"; ptyId: string }
  | { t: "input"; ptyId: string; data: string }
  | { t: "action"; id: string; ptyId?: string }
  /** Renames the desktop tab showing `ptyId`. */
  | { t: "rename"; ptyId: string; label: string }
  | { t: "ls"; ptyId: string; path?: string }
  | { t: "read"; ptyId: string; path: string }
  | { t: "set"; key: SettingKey; value: unknown }
  | ({ t: "profile" } & ProfileAction)
  /** Opens a new desktop terminal tab, in `cwd` (else the start folder), starting `cli` in it if given. */
  | { t: "newtab"; cwd?: string; cli?: string; /** Account profile id; "" = the default one; absent = automatic. */ profile?: string }
  /** Sent by the core itself when the app goes out of sight; listed for completeness. */
  | { t: "background"; on: boolean }
  | { t: "ping" };
