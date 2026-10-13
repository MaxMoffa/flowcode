// DEV ONLY: lets the UI render in a plain browser (open /?mock). Imported from
// main.tsx behind `import.meta.env.DEV`, so it never reaches a production build.
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { termMock } from "./devMockTerm";

const tabs = [
  { ptyId: "p1", tabId: "t1", window: "w1", label: "flowcode", cwd: "C:/Users/massi/Progetti/flowcode", cols: 80, rows: 24, cli: "claude", status: "waiting", context: { used: 16000, window: 200000 } },
  { ptyId: "p2", tabId: "t2", window: "w1", label: "api-server", cwd: "C:/Users/massi/api", cols: 80, rows: 24, cli: "codex", status: "busy", context: { used: 48000, window: 200000 } },
  { ptyId: "p3", tabId: "t3", window: "w1", label: "docs", cwd: "C:/Users/massi/Progetti/docs", cols: 80, rows: 24 },
  { ptyId: "p4", tabId: "t4", window: "w2", label: "PowerShell", cwd: "C:/Users/massi", cols: 80, rows: 24 },
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
  restoreSession: true,
  newTabPage: false,
  notify: { done: true, input: true, exited: false, limitReset: true },
  autoResume: { enabled: true, message: "continua" },
};

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
            void emit("remote://msg", { t: "tabs", tabs });
            void emit("remote://msg", { t: "usage", items: usage });
            void emit("remote://msg", { t: "settings", settings: mockSettings });
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
          await emit("remote://msg", { t: "tabs", tabs });
          await emit("remote://msg", { t: "usage", items: usage });
          await emit("remote://msg", { t: "settings", settings: mockSettings });
        }, 50);
        return null;
      case "platform":
        return "mobile";
      default:
        return termMock(cmd, args);
    }
  },
  { shouldMockEvents: true },
);
