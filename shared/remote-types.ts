// Wire types of the phone <-> desktop protocol, shared by the phone app
// (mobile/src/remote.ts) and the desktop (remotePublish.ts, the settings
// bridge). Types only, no runtime imports. The Rust source of truth is
// src-tauri/remote-proto/src/msg.rs (serde camelCase); keep the two in step.

export type AgentStatus = "busy" | "idle" | "waiting";

/** How full an agent's context window is (tokens). */
interface TabContext {
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

/** A desktop chat tab (an agent hosted over ACP, see src/chat) a phone can follow. */
export interface ChatInfo {
  chatId: string;
  tabId: string;
  /** Label of the desktop window showing the tab. */
  window: string;
  label: string;
  /** `claude`, `codex`, `vibe` or `gemini`. */
  agent: string;
  cwd: string;
  /** Account profile the agent runs under; absent for the default one. */
  profile?: string;
  /** Absent until the agent has started. */
  sessionId?: string;
  status?: "starting" | "idle" | "busy" | "waiting" | "exited";
  /** The ACP `modes` object the agent announced (`{ currentModeId, availableModes }`). */
  modes?: unknown;
}

/** An installed agent view plugin offered to phones (its manifest, see
 * src-tauri/src/view_plugins.rs, plus what a phone needs to cache it). */
export interface ViewPackage {
  id: string;
  kind: "agentView";
  apiVersion: number;
  label: string;
  labels?: Record<string, string>;
  description?: string;
  version?: string;
  author?: string;
  entry: string;
  transport: "acp";
  devices: ("desktop" | "tablet" | "phone")[];
  permissions: ("send" | "cancel" | "setMode" | "openFile")[];
  /** SHA-256 (hex) over the package's files: a phone re-downloads only when it changes. */
  hash: string;
  files: { path: string; size: number }[];
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
  /** The agent CLI the action launches: the phone draws its logo instead of `icon`. */
  cli?: string;
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

interface MirroredPalette {
  id: string;
  name: string;
  bg: string;
  accent: string;
  accent2: string;
}

/** When a chat shows link previews: on its own, on a tap, or not at all. */
export type LinkPreviewMode = "always" | "onClick" | "never";

/** What the desktop read from a web page (Rust: `LinkPreview` in src/link_preview.rs). The pictures are `data:` URIs. */
export interface LinkPreview {
  url: string;
  finalUrl: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  favicon?: string;
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
  /** Read-only: when the desktop fetches link previews; "never" makes it refuse `linkpreview`. */
  linkPreviews: LinkPreviewMode;
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
export type RemoteCap =
  | "rename"
  | "profiles"
  | "profileLogin"
  | "profileAgents"
  | "newTabProfile"
  | "background"
  | "gemini"
  | "closeTab"
  /** `chats`, `chatevents` and the `chat*` / `newchat` client messages. */
  | "chat"
  /** `views` / `viewfile`: agent view plugins installed on the desktop. */
  | "agentViews"
  /** `linkpreview`: link preview cards fetched by the desktop. */
  | "linkPreview";

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
  /** Every chat tab of the desktop, sent on connect and whenever one changes. */
  | { t: "chats"; chats: ChatInfo[] }
  /** Events of a chat followed with `chatopen` (src/chat/chatTypes.ts ChatEvent):
   * `replay` = the answer to `chatopen` (every event after its `afterSeq`), then live batches. */
  | { t: "chatevents"; chatId: string; events: unknown[]; replay: boolean }
  /** The agent view plugins a phone may show (only those listing "phone" or "tablet"). */
  | { t: "views"; views: ViewPackage[] }
  /** One chunk of a view plugin's file, base64; chunks of one file arrive in order. */
  | { t: "viewfile"; viewId: string; hash: string; path: string; offset: number; total: number; data: string }
  /** Reply to `linkpreview`; `preview` is null when there is none (or the desktop's setting is "never"). Needs the "linkPreview" cap, which is not in `RemoteCap`: an older desktop just lacks previews, nothing to warn about. */
  | { t: "linkpreview"; url: string; preview: LinkPreview | null }
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
  /** Closes the desktop tab showing `ptyId` (not the last one of its window). */
  | { t: "closetab"; ptyId: string }
  | { t: "ls"; ptyId: string; path?: string }
  | { t: "read"; ptyId: string; path: string }
  | { t: "set"; key: SettingKey; value: unknown }
  | ({ t: "profile" } & ProfileAction)
  /** Opens a new desktop terminal tab, in `cwd` (else the start folder), starting `cli` in it if given. */
  | { t: "newtab"; cwd?: string; cli?: string; /** Account profile id; "" = the default one; absent = automatic. */ profile?: string }
  /** Follows a chat: the desktop answers with its events after `afterSeq`, then streams new ones. */
  | { t: "chatopen"; chatId: string; afterSeq: number }
  | { t: "chatclose"; chatId: string }
  | { t: "chatprompt"; chatId: string; text: string }
  | { t: "chatcancel"; chatId: string }
  /** Answers an agent's permission request; `optionId: null` cancels it. */
  | { t: "chatpermission"; chatId: string; requestId: unknown; optionId: string | null }
  | { t: "chatmode"; chatId: string; modeId: string }
  /** Hands the chat's session over to a desktop terminal tab (as Ctrl+` does on the desktop). */
  | { t: "chatterminal"; chatId: string }
  /** Opens a new desktop chat tab for `cli` in `cwd` (else the start folder). */
  | { t: "newchat"; cli: string; cwd?: string; /** "" = the default profile; absent = automatic. */ profile?: string }
  | { t: "views" }
  /** Asks for one file of a view plugin; answered with its `viewfile` chunks. */
  | { t: "viewfile"; viewId: string; path: string }
  /** Sent by the core itself when the app goes out of sight; listed for completeness. */
  /** The preview of a link in a chat (answered with `linkpreview`). */
  | { t: "linkpreview"; url: string }
  | { t: "background"; on: boolean }
  | { t: "ping" };
