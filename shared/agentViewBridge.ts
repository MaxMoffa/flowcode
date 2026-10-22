// Bridge protocol v1 between an installed "agent view" plugin (HTML running in
// a sandboxed iframe) and the app that hosts it. Types plus a few pure
// helpers, no React: the desktop host (src/agentViews/PluginViewHost.tsx) and
// the phone app share it. The protocol is documented for plugin authors in
// PLUGINS.md; the manifest is validated by the Rust side (view_plugins_list).

export const BRIDGE_API_VERSION = 1;

export type ViewPluginDevice = "desktop" | "tablet" | "phone";

/** What a view may ask the host to do; every other request is refused. */
type ViewPermission = "send" | "cancel" | "setMode" | "openFile";

/** An installed view plugin, as `view_plugins_list` answers. */
export interface ViewPluginManifest {
  id: string;
  kind: "agentView";
  apiVersion: number;
  label: string;
  /** `label` by UI language code (`it`, `en`); the language missing here falls back to `label`. */
  labels?: Record<string, string>;
  description?: string;
  version?: string;
  author?: string;
  /** The HTML file, relative to the plugin folder. */
  entry: string;
  transport: "acp";
  devices: ViewPluginDevice[];
  permissions: ViewPermission[];
}

/** The theme custom properties a view receives (`ViewTheme.tokens`), by name.
 * The values are the app's resolved colors and fonts. */
export const THEME_TOKENS = [
  "--fg",
  "--fg-muted",
  "--bg-elevated",
  "--sidebar-hover",
  "--border",
  "--accent",
  "--accent-2",
  "--danger",
  "--warning",
  "--info",
  "--font-ui",
  "--font-mono",
] as const;

export interface ViewTheme {
  scheme: "dark" | "light";
  tokens: Record<string, string>;
}

/** The conversation's modes (a chat's `ChatModes`). */
interface ViewModes {
  currentModeId: string;
  availableModes: { id: string; name: string; description?: string }[];
}

interface ViewSessionInfo {
  agent: string;
  agentLabel: string;
  cwd: string;
  sessionId: string | null;
  title: string;
}

/** Safe-area insets in CSS pixels (a phone's notch and home bar). */
interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** What changes while a session runs, besides its events. */
export interface ViewStatus {
  status: string;
  queued: string[];
  currentModeId: string | null;
}

/** Host -> view, over the port. `Event` is the backend's chat event (src/chat/chatTypes.ts).
 * A new `init` means a new conversation: the view drops what it knew. */
export type HostMessage<Event = unknown> =
  | {
      type: "init";
      apiVersion: number;
      viewId: string;
      session: ViewSessionInfo;
      modes: ViewModes | null;
      permissions: ViewPermission[];
      locale: string;
      device: ViewPluginDevice;
      /** Only where the screen has unsafe edges. */
      insets?: ViewInsets;
      theme: ViewTheme;
    }
  | { type: "events"; events: Event[] }
  | ({ type: "status" } & ViewStatus)
  | { type: "theme"; theme: ViewTheme }
  | { type: "error"; code: "permission_denied" | "bad_request"; request: string };

/** View -> host, over the port. */
type ViewMessage =
  | { type: "send"; text: string }
  | { type: "cancel" }
  | { type: "setMode"; modeId: string }
  | { type: "openFile"; path: string }
  | { type: "switchView"; viewId: string };

/** The permission a request needs; absent: always allowed. */
const REQUIRED_PERMISSION: Partial<Record<ViewMessage["type"], ViewPermission>> = {
  send: "send",
  cancel: "cancel",
  setMode: "setMode",
  openFile: "openFile",
};

/** The view's first message, posted to `window.parent`. */
export function isHello(data: unknown): boolean {
  return isRecord(data) && data.type === "flowcode:hello" && data.apiVersion === BRIDGE_API_VERSION;
}

/** `null`: not a request this protocol knows - ignore it. `ok: false`: a known
 * request with a bad shape, `request` is its type. */
export type ParsedViewMessage = { ok: true; message: ViewMessage } | { ok: false; request: string };

export function parseViewMessage(data: unknown): ParsedViewMessage | null {
  if (!isRecord(data) || typeof data.type !== "string") return null;
  const bad = { ok: false, request: data.type } as const;
  const good = (message: ViewMessage): ParsedViewMessage => ({ ok: true, message });
  switch (data.type) {
    case "send":
      return typeof data.text === "string" && data.text.trim() !== "" ? good({ type: "send", text: data.text }) : bad;
    case "cancel":
      return good({ type: "cancel" });
    case "setMode":
      return typeof data.modeId === "string" && data.modeId !== "" ? good({ type: "setMode", modeId: data.modeId }) : bad;
    case "openFile":
      return typeof data.path === "string" && data.path !== "" ? good({ type: "openFile", path: data.path }) : bad;
    case "switchView":
      return typeof data.viewId === "string" && data.viewId !== "" ? good({ type: "switchView", viewId: data.viewId }) : bad;
    default:
      return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The URL of a plugin file under `root` (the `flowcode-plugin` scheme's root as
 * `convertFileSrc` gives it). `convertFileSrc` encodes the whole path as one
 * component, slashes included, which would make the page's relative `view.css`
 * resolve to the scheme root: each segment is encoded on its own instead. */
export function pluginFileUrl(root: string, path: string): string {
  return `${root.replace(/\/+$/, "")}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** A path split into its root (drive or UNC share, "" on POSIX) and segments. */
function splitPath(path: string, windows: boolean): { root: string; segments: string[] } | null {
  const parts = path.split(windows ? /[\\/]+/ : /\/+/).filter((part) => part !== "" && part !== ".");
  let root = "";
  if (windows) {
    if (/^[\\/]{2}/.test(path)) {
      if (parts.length < 2) return null;
      root = `\\\\${parts[0]}\\${parts[1]}`;
      parts.splice(0, 2);
    } else if (/^[A-Za-z]:$/.test(parts[0] ?? "")) {
      root = parts.shift()!;
    } else {
      return null;
    }
  }
  const segments: string[] = [];
  for (const part of parts) {
    if (part !== "..") segments.push(part);
    else if (segments.pop() === undefined) return null;
  }
  return { root, segments };
}

/** `path` (absolute, or relative to `cwd`) made absolute and normalized, or
 * null when it isn't strictly inside `cwd` - `..` climbs, another drive, a
 * sibling that merely shares a prefix. Windows paths (drive or UNC) compare
 * case-insensitively. */
export function resolveInsideCwd(cwd: string, path: string): string | null {
  const windows = /^([A-Za-z]:|[\\/]{2})/.test(cwd);
  const sep = windows ? "\\" : "/";
  const absolute = windows ? /^([A-Za-z]:|[\\/]{2})/.test(path) : path.startsWith("/");
  const base = splitPath(cwd, windows);
  const target = splitPath(absolute ? path : `${cwd}${sep}${path}`, windows);
  if (!base || !target) return null;
  const fold = (s: string) => (windows ? s.toLowerCase() : s);
  if (fold(base.root) !== fold(target.root) || target.segments.length <= base.segments.length) return null;
  if (!base.segments.every((segment, i) => fold(segment) === fold(target.segments[i]))) return null;
  return target.root + sep + target.segments.join(sep);
}

/** Where a bridge host gets the session from and sends the view's requests to:
 * the desktop app's Tauri commands, the phone's remote link. */
export interface BridgeSource<Event extends { seq: number }> {
  device: ViewPluginDevice;
  insets?: ViewInsets;
  locale(): string;
  session(): ViewSessionInfo;
  modes(): ViewModes | null;
  status(): ViewStatus;
  theme(): ViewTheme;
  /** Live events; resolves once the subscription is in place. */
  subscribe(listener: (event: Event) => void): Promise<() => void>;
  /** Every event so far. */
  replay(): Promise<Event[]>;
  onStatus(listener: (status: ViewStatus) => void): () => void;
  onTheme(listener: (theme: ViewTheme) => void): () => void;
  send(text: string): void;
  cancel(): void;
  setMode(modeId: string): void;
  /** An absolute path already checked to be inside the session's cwd. */
  openFile(path: string): void;
  switchView(viewId: string): void;
}

interface BridgeHostOptions<Event extends { seq: number }> {
  /** The view's window, read at each hello: it is the only sender accepted. */
  iframeWindow: () => Window | null;
  manifest: Pick<ViewPluginManifest, "id" | "permissions">;
  source: BridgeSource<Event>;
  /** The view said hello and has its channel. */
  onConnect?: () => void;
}

/** Runs the host side of the bridge for one view: the handshake, then over a
 * private MessageChannel the events (replay first, deduped by seq), status and
 * theme out, and the permission-gated, validated requests in. There is
 * deliberately no request that could answer an agent's permission prompt. */
export function createBridgeHost<Event extends { seq: number }>({ iframeWindow, manifest, source, onConnect }: BridgeHostOptions<Event>) {
  const received = new Map<number, Event>();
  let outbox: Event[] = [];
  let replayed = false;
  let delivered = false;
  let port: MessagePort | null = null;
  let disposed = false;

  const post = (message: HostMessage<Event>) => port?.postMessage(message);

  /** The whole log the first time, live batches after. */
  function deliver() {
    if (!port || !replayed) return;
    if (!delivered) {
      delivered = true;
      outbox = [];
      post({ type: "events", events: [...received.values()].sort((a, b) => a.seq - b.seq) });
    } else if (outbox.length > 0) {
      const events = outbox;
      outbox = [];
      post({ type: "events", events });
    }
  }

  // Subscribe first, then fetch the replay, so no event falls in between.
  let stopEvents: (() => void) | null = null;
  void (async () => {
    const stop = await source.subscribe((event) => {
      if (received.has(event.seq)) return;
      received.set(event.seq, event);
      outbox.push(event);
      deliver();
    });
    if (disposed) {
      stop();
      return;
    }
    stopEvents = stop;
    const past = await source.replay();
    if (disposed) return;
    for (const event of past) if (!received.has(event.seq)) received.set(event.seq, event);
    replayed = true;
    deliver();
  })().catch(() => {});
  const stopStatus = source.onStatus((status) => post({ type: "status", ...status }));
  const stopTheme = source.onTheme((theme) => post({ type: "theme", theme }));

  function onRequest(e: MessageEvent) {
    const parsed = parseViewMessage(e.data);
    if (!parsed) return;
    if (!parsed.ok) {
      post({ type: "error", code: "bad_request", request: parsed.request });
      return;
    }
    const { message } = parsed;
    const needed = REQUIRED_PERMISSION[message.type];
    if (needed && !manifest.permissions.includes(needed)) {
      post({ type: "error", code: "permission_denied", request: message.type });
      return;
    }
    switch (message.type) {
      case "send":
        source.send(message.text);
        break;
      case "cancel":
        source.cancel();
        break;
      case "setMode":
        source.setMode(message.modeId);
        break;
      case "openFile": {
        const path = resolveInsideCwd(source.session().cwd, message.path);
        if (path) source.openFile(path);
        else post({ type: "error", code: "permission_denied", request: "openFile" });
        break;
      }
      case "switchView":
        source.switchView(message.viewId);
        break;
    }
  }

  function onHello(e: MessageEvent) {
    const frame = iframeWindow();
    if (!frame || e.source !== frame || !isHello(e.data)) return;
    // A second hello (the view reloaded) replaces the old channel.
    port?.close();
    const channel = new MessageChannel();
    channel.port1.onmessage = onRequest;
    port = channel.port1;
    delivered = false;
    // The page's origin is opaque (sandbox without allow-same-origin): "*" is the only target.
    frame.postMessage({ type: "flowcode:connect", apiVersion: BRIDGE_API_VERSION }, "*", [channel.port2]);
    post({
      type: "init",
      apiVersion: BRIDGE_API_VERSION,
      viewId: manifest.id,
      session: source.session(),
      modes: source.modes(),
      permissions: manifest.permissions,
      locale: source.locale(),
      device: source.device,
      insets: source.insets,
      theme: source.theme(),
    });
    post({ type: "status", ...source.status() });
    deliver();
    onConnect?.();
  }

  window.addEventListener("message", onHello);

  return {
    dispose() {
      disposed = true;
      window.removeEventListener("message", onHello);
      stopEvents?.();
      stopStatus();
      stopTheme();
      port?.close();
      port = null;
    },
  };
}
