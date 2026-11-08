// DEV ONLY: lets the UI render in a plain browser (open /?mock). Imported from
// main.tsx behind `import.meta.env.DEV`, so it never reaches a production build.
import { emit } from "@tauri-apps/api/event";
import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { chatMock, chatMockCaps, chatMockConnect, mockViews } from "./devMockChat";
import { termMock } from "./devMockTerm";
import { explorerMock } from "./devMockExplorer";
import { providerAuthMock } from "./devMockProviderAuth";
import type { ClientMsg, Tab } from "../../shared/remote-types";

const tabs: Tab[] = [
  { ptyId: "p1", tabId: "t1", window: "w1", label: "flowcode", cwd: "C:/Users/massi/Progetti/flowcode", cols: 80, rows: 24, cli: "claude", status: "waiting", context: { used: 16000, window: 200000 } },
  { ptyId: "p2", tabId: "t2", window: "w1", label: "api-server", cwd: "C:/Users/massi/api", cols: 80, rows: 24, cli: "codex", status: "busy", context: { used: 48000, window: 200000 } },
  { ptyId: "p3", tabId: "t3", window: "w1", label: "docs", cwd: "C:/Users/massi/Progetti/docs", cols: 80, rows: 24 },
  { ptyId: "p4", tabId: "t4", window: "w2", label: "PowerShell", cwd: "C:/Users/massi", cols: 80, rows: 24 },
];

const mockActions = [{ id: "commit", label: "Commit" }, { id: "usage", label: "Utilizzo Claude", icon: "M4 18a8 8 0 1 1 16 0M12 18l4-7" },
  { id: "pull", label: "Pull" },
  { id: "claude-code", label: "Claude Code", cli: "claude" },
  { id: "codex-cli", label: "Codex CLI", cli: "codex" },
];

/** A reset about two hours ahead, worded the way Claude Code words it ("3pm"). */
const soon = (() => {
  const h = new Date(Date.now() + 2 * 3_600_000).getHours();
  return `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
})();
/** A dated reset three days ahead ("Sep 19, 12am"). */
const later = (() => {
  const d = new Date(Date.now() + 3 * 86_400_000);
  return `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}, 12am`;
})();
const gauges = (a: number, b: number) => [
  { kind: "session", label: "Sessione 5 ore", percent: a, resets: soon },
  { kind: "week", label: "Settimana", percent: b, resets: later },
];

const L = { profile: "lavoro-1fa968", profileName: "Lavoro", profileColor: "#6f9bcf" };
const usage = [
  {
    pluginId: "mistral-vibe",
    label: "Mistral Vibe",
    metrics: [
      { kind: "spend", label: "Oggi", period: "today", cost: 1.84, tokens: 410_000, sessions: 3 },
      { kind: "spend", label: "7 giorni", period: "week", cost: 9.2, tokens: 2_100_000, sessions: 14 },
      { kind: "spend", label: "30 giorni", period: "month", cost: 31.6, tokens: 7_400_000, sessions: 52 },
    ],
  },
  { pluginId: "gemini-cli", label: "Gemini CLI", metrics: [{ kind: "loggedOut", label: "Non collegato", command: "gemini" }] },
  { pluginId: "opencode", label: "OpenCode", metrics: [{ kind: "other", label: "Collegato" }] },
  { pluginId: "codex-cli", label: "Codex", metrics: gauges(0.09, 0.78) },
  { pluginId: "claude-code", label: "Claude Code", metrics: gauges(0.42, 0.18) },
  { pluginId: "codex-cli", label: "Codex", ...L, metrics: gauges(1, 0.95) },
];

const mockProfiles = [
  { id: "lavoro-1fa968", name: "Lavoro", color: "#6f9bcf", loggedIn: { claude: true, codex: true, vibe: false, gemini: false, opencode: false } },
  { id: "personale-22b1c0", name: "Personale", color: "#22c55e", loggedIn: { claude: true, codex: false, vibe: false, gemini: false, opencode: false } },
];

const mockSettings = {
  theme: "dark",
  resolvedTheme: "dark",
  palette: "terracotta",
  terminalPalette: null,
  contrast: 0.5,
  glassOpacity: 0.6,
  language: "system",
  resolvedLanguage: "it",
  languages: [
    { id: "it", name: "Italiano" },
    { id: "en", name: "English" },
  ],
  colors: {},
  terminalColors: {},
  palettes: [
    { id: "terracotta", name: "Terracotta", bg: "#1a1511", accent: "#9db984", accent2: "#c9975a" },
    { id: "ocean", name: "Oceano", bg: "#0e1620", accent: "#6f9bcf", accent2: "#5ec2c2" },
  ],
  terminalFontSize: 13,
  bannerEnabled: true,
  confirmLinkOpen: true,
  linkPreviews: "never",
  restoreSession: true,
  newTabPage: false,
  notify: { done: true, input: true, exited: false, limitReset: true },
  autoResume: { enabled: true, message: "continua" },
};

/** Closing or renaming a terminal tab: the list the desktop would push next. */
function mockTabs(msg: ClientMsg | undefined) {
  if (msg?.t === "newtab") {
    const id = `new-${Date.now()}`;
    tabs.push({ ptyId: id, tabId: id, window: "w1", label: msg.cli ?? "Terminale", cwd: msg.cwd ?? "C:/Users/massi", cols: 80, rows: 24, ...(msg.cli ? { cli: msg.cli, status: "idle" as const } : {}) });
    setTimeout(() => void emit("remote://msgs", [{ t: "tabs", tabs: [...tabs] }]), 80);
    return;
  }
  if (msg?.t !== "rename" && msg?.t !== "closetab") return;
  const at = tabs.findIndex((x) => x.ptyId === msg?.ptyId);
  if (at < 0) return;
  if (msg?.t === "closetab") tabs.splice(at, 1);
  else if (msg?.t === "rename" && msg.label) tabs[at].label = msg.label;
  else return;
  void emit("remote://msgs", [{ t: "tabs", tabs: [...tabs] }]);
}

// What the desktop sends once the link is up: its features, the chats and the view plugins.
async function chatHello() {
  await emit("remote://msgs", [{ t: "ready", deviceName: "Telefono", hostName: "Il mio PC", appVersion: "0.14.0", proto: 2, caps: ["fileExplorer", "rename", "profiles", "profileLogin", "providerAuth", "profileAgents", "newTabProfile", "background", "gemini", "opencode", "closeTab", ...chatMockCaps] }]);
  await chatMockConnect();
  await emit("remote://msgs", [{ t: "views", views: mockViews }]);
}

// Plugin views load from the app's custom scheme; give the browser the URL shape the webview has.
mockConvertFileSrc("windows");

// ?mock=pairing starts unpaired (pairing never answers); ?mock=pairing-ok answers after 3 s.
const unpaired = location.search.includes("mock=pairing");
const answers = location.search.includes("pairing-ok");

mockIPC(
  (cmd, args) => {
    switch (cmd) {
      case "pairing_state":
        return unpaired ? { paired: false } : { paired: true, hostName: "Il mio PC" };
      case "inspect_ticket":
        return { hostName: "Il mio PC", fingerprint: "K3M9QD" };
      case "my_fingerprint":
        return "A7K9QX";
      case "pair":
        return new Promise((resolve) => {
          if (!answers) return;
          setTimeout(() => {
            resolve(null);
            void emit("remote://state", { status: "online", hostName: "Il mio PC" });
            void chatHello();
            void emit("remote://msgs", [{ t: "tabs", tabs }]);
            void emit("remote://msgs", [{ t: "usage", items: usage }]);
            void emit("remote://msgs", [{ t: "settings", settings: mockSettings }]);
            void emit("remote://msgs", [{ t: "profiles", profiles: mockProfiles }]);
            void emit("remote://msgs", [{ t: "actions", actions: mockActions }]);
          }, 3000);
        });
      case "plugin:barcode-scanner|check_permissions":
      case "plugin:barcode-scanner|request_permissions":
        return { camera: "granted" };
      case "plugin:barcode-scanner|scan":
        return new Promise(() => {});
      case "connect":
        setTimeout(async () => {
          await emit("remote://state", { status: "online", hostName: "Il mio PC" });
          await chatHello();
          await emit("remote://msgs", [{ t: "tabs", tabs }]);
          await emit("remote://msgs", [{ t: "usage", items: usage }]);
          await emit("remote://msgs", [{ t: "settings", settings: mockSettings }]);
          await emit("remote://msgs", [{ t: "profiles", profiles: mockProfiles }]);
          await emit("remote://msgs", [{ t: "actions", actions: mockActions }]);
        }, 50);
        return null;
      case "computers":
        return [{ id: "dev", hostName: "Il mio PC", active: true }];
      case "switch_computer":
      case "forget_computer":
        return undefined;
      case "platform":
        return "mobile";
      case "background_settings":
        return { enabled: false, capMinutes: 120 };
      case "request_notification_permission":
      case "notification_permission":
        return true;
      case "view_cache_has":
        return true;
      case "view_cache_write":
      case "view_cache_commit":
      case "view_cache_prune":
        return undefined;
      default:
        if (cmd === "send") mockTabs((args as { msg?: ClientMsg }).msg);
        if (cmd === "send") explorerMock((args as { msg?: ClientMsg }).msg);
        if (cmd === "send") providerAuthMock((args as { msg?: ClientMsg }).msg);
        if (cmd === "send") chatMock((args as { msg?: Parameters<typeof chatMock>[0] }).msg);
        return termMock(cmd, args);
    }
  },
  { shouldMockEvents: true },
);
