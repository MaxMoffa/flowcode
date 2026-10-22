// DEV ONLY: lets the UI render in a plain browser (open /?mock). Imported from
// main.tsx behind `import.meta.env.DEV`, so it never reaches a production build.
import { emit } from "@tauri-apps/api/event";
import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { chatMock, chatMockCaps, chatMockConnect, mockViews } from "./devMockChat";
import { termMock } from "./devMockTerm";

const tabs = [
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

const gauges = (a: number, b: number) => [
  { kind: "gauge", label: "5 ore", percent: a },
  { kind: "gauge", label: "Settimana", percent: b },
];

const L = { profile: "lavoro-1fa968", profileName: "Lavoro", profileColor: "#6f9bcf" };
const usage = [
  { pluginId: "mistral-vibe", label: "Mistral Vibe", metrics: [{ kind: "spend", label: "Questo mese", cost: 3.42, period: "month" }] },
  { pluginId: "codex-cli", label: "Codex", metrics: gauges(0.09, 0.78) },
  { pluginId: "claude-code", label: "Claude Code", metrics: gauges(0.42, 0.18) },
  { pluginId: "codex-cli", label: "Codex", ...L, metrics: gauges(0.22, 0.95) },
];

const mockProfiles = [
  { id: "lavoro-1fa968", name: "Lavoro", color: "#6f9bcf", loggedIn: { claude: true, codex: true, vibe: false, gemini: false } },
  { id: "personale-22b1c0", name: "Personale", color: "#22c55e", loggedIn: { claude: true, codex: false, vibe: false, gemini: false } },
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
  linkPreviews: "onClick",
  restoreSession: true,
  newTabPage: false,
  notify: { done: true, input: true, exited: false, limitReset: true },
  autoResume: { enabled: true, message: "continua" },
};

// What the desktop sends once the link is up: its features, the chats and the view plugins.
async function chatHello() {
  await emit("remote://msg", { t: "ready", deviceName: "Telefono", hostName: "Il mio PC", appVersion: "0.14.0", proto: 2, caps: ["rename", "profiles", "profileLogin", "profileAgents", "newTabProfile", "background", "gemini", "closeTab", ...chatMockCaps] });
  await chatMockConnect();
  await emit("remote://msg", { t: "views", views: mockViews });
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
            void emit("remote://msg", { t: "tabs", tabs });
            void emit("remote://msg", { t: "usage", items: usage });
            void emit("remote://msg", { t: "settings", settings: mockSettings });
            void emit("remote://msg", { t: "profiles", profiles: mockProfiles });
            void emit("remote://msg", { t: "actions", actions: mockActions });
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
          await emit("remote://msg", { t: "tabs", tabs });
          await emit("remote://msg", { t: "usage", items: usage });
          await emit("remote://msg", { t: "settings", settings: mockSettings });
          await emit("remote://msg", { t: "profiles", profiles: mockProfiles });
          await emit("remote://msg", { t: "actions", actions: mockActions });
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
        if (cmd === "send") chatMock((args as { msg?: Parameters<typeof chatMock>[0] }).msg);
        return termMock(cmd, args);
    }
  },
  { shouldMockEvents: true },
);
