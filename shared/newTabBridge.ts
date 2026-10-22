// Bridge protocol v1 between an installed "new tab" plugin (HTML running in a
// sandboxed iframe) and the app that hosts it. The sibling of
// agentViewBridge.ts - same handshake, same private MessageChannel, same
// manifest rules - for the page a new tab opens on. The desktop host is
// src/newtab/PluginNewTab.tsx. The protocol is documented for plugin authors
// in PLUGINS.md; the manifest is validated by the Rust side (view_plugins_list).

import { BRIDGE_API_VERSION, isHello, isRecord, type ViewPluginDevice, type ViewTheme } from "./agentViewBridge";

/** What a new tab page may ask the host to do; every other request is refused. */
type NewTabPermission = "launch";

/** An installed new tab plugin, as `view_plugins_list` answers. */
export interface NewTabPluginManifest {
  id: string;
  kind: "newTab";
  apiVersion: number;
  label: string;
  /** `label` by UI language code (`it`, `en`); the language missing here falls back to `label`. */
  labels?: Record<string, string>;
  description?: string;
  version?: string;
  author?: string;
  /** The HTML file, relative to the plugin folder. */
  entry: string;
  devices: ViewPluginDevice[];
  permissions: NewTabPermission[];
}

/** What a page can start. Ids are the host's own, valid for the `data` they came in. */
export type NewTabLaunchKind = "recent" | "favorite" | "shell" | "agent";

/** What the page shows, as the host lists it. A page never sends a path or a
 * command back: it names one of these entries by id. */
export interface NewTabData {
  recents: { id: string; label: string; path: string; shell?: string }[];
  favorites: { id: string; label: string; path: string }[];
  shells: { id: string; label: string }[];
  agents: { id: string; label: string }[];
  /** The account profile the tab is on; absent for the default one. */
  profile?: { id: string; label: string };
}

/** Host -> page, over the port. */
export type NewTabHostMessage =
  | {
      type: "init";
      apiVersion: number;
      viewId: string;
      permissions: NewTabPermission[];
      locale: string;
      theme: ViewTheme;
      data: NewTabData;
    }
  | { type: "data"; data: NewTabData }
  | { type: "theme"; theme: ViewTheme }
  | { type: "error"; code: "permission_denied" | "bad_request"; request: string };

/** Page -> host, over the port. */
type NewTabViewMessage = { type: "launch"; kind: NewTabLaunchKind; id: string } | { type: "customize" };

const LAUNCH_KINDS: readonly NewTabLaunchKind[] = ["recent", "favorite", "shell", "agent"];

/** The permission a request needs; absent: always allowed. */
const REQUIRED_PERMISSION: Partial<Record<NewTabViewMessage["type"], NewTabPermission>> = {
  launch: "launch",
};

/** `null`: not a request this protocol knows - ignore it. `ok: false`: a known
 * request with a bad shape, `request` is its type. */
export type ParsedNewTabMessage = { ok: true; message: NewTabViewMessage } | { ok: false; request: string };

export function parseNewTabMessage(data: unknown): ParsedNewTabMessage | null {
  if (!isRecord(data) || typeof data.type !== "string") return null;
  switch (data.type) {
    case "launch":
      return typeof data.kind === "string" &&
        LAUNCH_KINDS.includes(data.kind as NewTabLaunchKind) &&
        typeof data.id === "string" &&
        data.id !== ""
        ? { ok: true, message: { type: "launch", kind: data.kind as NewTabLaunchKind, id: data.id } }
        : { ok: false, request: "launch" };
    case "customize":
      return { ok: true, message: { type: "customize" } };
    default:
      return null;
  }
}

/** Where a new tab bridge host gets the page's data from and sends its requests to. */
interface NewTabBridgeSource {
  locale(): string;
  theme(): ViewTheme;
  data(): NewTabData;
  onData(listener: (data: NewTabData) => void): () => void;
  onTheme(listener: (theme: ViewTheme) => void): () => void;
  /** The host resolves `id` against its own lists and starts it, or ignores it. */
  launch(kind: NewTabLaunchKind, id: string): void;
  customize(): void;
}

interface NewTabBridgeHostOptions {
  /** The page's window, read at each hello: it is the only sender accepted. */
  iframeWindow: () => Window | null;
  manifest: Pick<NewTabPluginManifest, "id" | "permissions">;
  source: NewTabBridgeSource;
  /** The page said hello and has its channel. */
  onConnect?: () => void;
}

/** Runs the host side of the bridge for one page: the handshake, then over a
 * private MessageChannel the data and theme out, and the permission-gated,
 * validated requests in. */
export function createNewTabBridgeHost({ iframeWindow, manifest, source, onConnect }: NewTabBridgeHostOptions) {
  let port: MessagePort | null = null;

  const post = (message: NewTabHostMessage) => port?.postMessage(message);

  const stopData = source.onData((data) => post({ type: "data", data }));
  const stopTheme = source.onTheme((theme) => post({ type: "theme", theme }));

  function onRequest(e: MessageEvent) {
    const parsed = parseNewTabMessage(e.data);
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
    if (message.type === "launch") source.launch(message.kind, message.id);
    else source.customize();
  }

  function onHello(e: MessageEvent) {
    const frame = iframeWindow();
    if (!frame || e.source !== frame || !isHello(e.data)) return;
    // A second hello (the page reloaded) replaces the old channel.
    port?.close();
    const channel = new MessageChannel();
    channel.port1.onmessage = onRequest;
    port = channel.port1;
    // The page's origin is opaque (sandbox without allow-same-origin): "*" is the only target.
    frame.postMessage({ type: "flowcode:connect", apiVersion: BRIDGE_API_VERSION }, "*", [channel.port2]);
    post({
      type: "init",
      apiVersion: BRIDGE_API_VERSION,
      viewId: manifest.id,
      permissions: manifest.permissions,
      locale: source.locale(),
      theme: source.theme(),
      data: source.data(),
    });
    onConnect?.();
  }

  window.addEventListener("message", onHello);

  return {
    dispose() {
      window.removeEventListener("message", onHello);
      stopData();
      stopTheme();
      port?.close();
      port = null;
    },
  };
}
