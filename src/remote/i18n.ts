// Tiny catalog for the phone client: it runs outside Tauri, so the desktop
// i18n module (which talks to the backend) can't be reused.
const it = {
  pairTitle: "Collega questo dispositivo",
  pairBody: "Dai un nome a questo telefono per riconoscerlo in Flowcode.",
  deviceName: "Nome del dispositivo",
  pairButton: "Collega",
  pairing: "Collegamento...",
  pairFailed: "Collegamento non riuscito",
  unpairedTitle: "Dispositivo non collegato",
  unpairedBody: "Apri Flowcode sul computer, vai in Impostazioni > Agenti > Accesso remoto e scansiona il codice QR con la fotocamera.",
  connecting: "Connessione...",
  offline: "Offline - riprovo",
  tabs: "Terminali",
  noTabs: "Nessun terminale aperto sul computer.",
  window: "Finestra {n}",
  back: "Indietro",
  ended: "Sessione terminata",
  send: "Invia",
  typeHere: "Scrivi un comando",
  forget: "Scollega",
  status_busy: "al lavoro",
  status_waiting: "in attesa",
  status_idle: "inattivo",
};
const en: typeof it = {
  pairTitle: "Pair this device",
  pairBody: "Give this phone a name so you can recognise it in Flowcode.",
  deviceName: "Device name",
  pairButton: "Pair",
  pairing: "Pairing...",
  pairFailed: "Pairing failed",
  unpairedTitle: "Device not paired",
  unpairedBody: "Open Flowcode on your computer, go to Settings > Agents > Remote access and scan the QR code with your camera.",
  connecting: "Connecting...",
  offline: "Offline - retrying",
  tabs: "Terminals",
  noTabs: "No terminal is open on the computer.",
  window: "Window {n}",
  back: "Back",
  ended: "Session ended",
  send: "Send",
  typeHere: "Type a command",
  forget: "Unpair",
  status_busy: "working",
  status_waiting: "waiting",
  status_idle: "idle",
};

const catalog = typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("it") ? it : en;

export type Key = keyof typeof it;

export function t(key: Key, vars?: Record<string, string | number>): string {
  const s = catalog[key];
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}
