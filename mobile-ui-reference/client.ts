// WebSocket link to the Flowcode desktop. One instance for the page; screens
// subscribe to what they need.
export type Status = "connecting" | "online" | "offline";
export type AgentStatus = "busy" | "waiting" | "idle" | null;

export interface RemoteTab {
  ptyId: string;
  tabId: string;
  window: string;
  label: string;
  cwd: string;
  cli: string | null;
  status: AgentStatus;
  cols: number;
  rows: number;
}

export type ServerMsg =
  | { t: "ready"; deviceName: string }
  | { t: "error"; message: string }
  | { t: "tabs"; tabs: RemoteTab[] }
  | { t: "snapshot"; ptyId: string; data: string; cols: number; rows: number }
  | { t: "output"; ptyId: string; data: string }
  | { t: "exit"; ptyId: string }
  | { t: "pong" };

export const TOKEN_KEY = "flowcode.remote.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the pairing just won't survive a reload */
  }
}

const PING_MS = 20_000;
const MAX_BACKOFF_MS = 10_000;

export class RemoteClient {
  private ws: WebSocket | null = null;
  private ready = false;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private ping: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  /** Ptys the UI wants open - re-sent after a reconnect. */
  private open = new Set<string>();
  private messageListeners = new Set<(m: ServerMsg) => void>();
  private statusListeners = new Set<(s: Status) => void>();
  status: Status = "connecting";

  constructor(
    private token: string,
    private onAuthFailed: () => void,
  ) {
    this.connect();
  }

  private setStatus(s: Status) {
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  private connect() {
    if (this.stopped) return;
    this.setStatus(this.attempt === 0 ? "connecting" : "offline");
    // Plain ws: the traffic never leaves the VPN.
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    this.ws = ws;
    this.ready = false;
    ws.onopen = () => {
      this.send({ t: "auth", token: this.token });
      clearInterval(this.ping);
      this.ping = setInterval(() => this.send({ t: "ping" }), PING_MS);
    };
    ws.onmessage = (e) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(e.data as string) as ServerMsg;
      } catch {
        return;
      }
      if (m.t === "ready") {
        this.ready = true;
        this.attempt = 0;
        this.setStatus("online");
        this.send({ t: "list" });
        for (const id of this.open) this.send({ t: "open", ptyId: id });
      } else if (m.t === "error" && (!this.ready || /auth|token|unauthori|revoked|pair/i.test(m.message))) {
        // Rejected before being let in: the token is no good any more.
        this.stop();
        this.onAuthFailed();
        return;
      }
      this.messageListeners.forEach((l) => l(m));
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      if (this.ws !== ws || this.stopped) return;
      this.ready = false;
      this.setStatus("offline");
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt++);
      this.retry = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  openPty(ptyId: string) {
    this.open.add(ptyId);
    if (this.ready) this.send({ t: "open", ptyId });
  }

  closePty(ptyId: string) {
    this.open.delete(ptyId);
    if (this.ready) this.send({ t: "close", ptyId });
  }

  input(ptyId: string, data: string) {
    this.send({ t: "input", ptyId, data });
  }

  onMessage(l: (m: ServerMsg) => void) {
    this.messageListeners.add(l);
    return () => void this.messageListeners.delete(l);
  }

  onStatus(l: (s: Status) => void) {
    this.statusListeners.add(l);
    return () => void this.statusListeners.delete(l);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.ping);
    this.ws?.close();
  }
}
