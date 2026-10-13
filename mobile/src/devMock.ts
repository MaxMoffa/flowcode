// DEV ONLY: lets the UI render in a plain browser (open /?mock). Imported from
// main.tsx behind `import.meta.env.DEV`, so it never reaches a production build.
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";

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

mockIPC(
  (cmd) => {
    switch (cmd) {
      case "pairing_state":
        return { paired: true, hostName: "Il mio PC" };
      case "connect":
        setTimeout(async () => {
          await emit("remote://state", { status: "online", hostName: "Il mio PC" });
          await emit("remote://msg", { t: "tabs", tabs });
          await emit("remote://msg", { t: "usage", items: usage });
        }, 50);
        return null;
      case "platform":
        return "mobile";
      default:
        return null;
    }
  },
  { shouldMockEvents: true },
);
