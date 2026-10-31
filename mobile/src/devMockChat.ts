// DEV ONLY: chat sessions for the mock. Four chats - one waiting for a
// permission (with a diff and a plan in its history), one waiting for an
// answer to a question (then to a two-question form), one busy, one idle -
// that answer the chat messages the way the desktop does, in miniature.
import { emit } from "@tauri-apps/api/event";

const WINDOW = "w1";

const modes = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
    { id: "acceptEdits", name: "Accept edits" },
  ],
};

type Info = Record<string, unknown> & { chatId: string; status: string };
type Ev = Record<string, unknown> & { kind: string };

const infos: Info[] = [
  { chatId: "c1", tabId: "tc1", window: WINDOW, label: "Banner di riconnessione", agent: "claude", cwd: "C:/Users/massi/Progetti/flowcode", sessionId: "7f3c9e2a-41d0-4b6e-9a3a-2f6d1c8e5b10", status: "waiting", modes },
  { chatId: "c4", tabId: "tc4", window: WINDOW, label: "Scelta del database", agent: "claude", cwd: "C:/Users/massi/Progetti/api", sessionId: "d4a1c3f0-5b7e-42a9-8c16-9e0b7f2a6d41", status: "waiting", modes },
  { chatId: "c2", tabId: "tc2", window: WINDOW, label: "Documentazione API", agent: "codex", cwd: "C:/Users/massi/api", sessionId: "b21e07aa-91c4-48e3-8d0f-3a7c55d0e9f2", status: "busy" },
  { chatId: "c3", tabId: "tc3", window: "w2", label: "Idee", agent: "gemini", cwd: "C:/Users/massi/Progetti/docs", sessionId: "0c5a8d41-6e2b-4f7a-b3c9-e84d1a27f6b3", status: "idle" },
];

const update = (sessionUpdate: string, rest: Record<string, unknown>): Ev => ({ kind: "update", update: { sessionUpdate, ...rest } });
const text = (sessionUpdate: string, chunk: string): Ev => update(sessionUpdate, { content: { type: "text", text: chunk } });

const pic = (fill: string, label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="${fill}"/><text x="320" y="210" font-size="40" text-anchor="middle" fill="#fff" font-family="sans-serif">${label}</text></svg>`)}`;
const image = (sessionUpdate: string, fill: string, label: string): Ev => update(sessionUpdate, { content: { type: "image", uri: pic(fill, label), mimeType: "image/svg+xml" } });

/** The form schema of the agent's questions (an ACP elicitation, as AskUserQuestion is sent). */
const askSchema = (qs: { header: string; text: string; multi?: boolean; options: [string, string?][] }[]) => ({
  type: "object",
  properties: Object.fromEntries(
    qs.map((q, n) => {
      const opts = q.options.map(([label, description]) => ({ const: label, title: label, ...(description ? { description } : {}) }));
      return [`question_${n}`, { title: q.header, description: q.text, ...(q.multi ? { type: "array", items: { anyOf: opts } } : { type: "string", oneOf: opts }) }];
    }),
  ),
});

/** The scripted history of each chat; `seq` and `at` are filled in. */
const history: Record<string, Ev[]> = {
  c1: [
    { kind: "user", text: "Il banner di riconnessione resta visibile dopo che il collegamento torna online. Puoi sistemarlo?" },
    text("agent_message_chunk", "Guardo come `Reconnect.tsx` decide quando nascondere il banner. "),
    text("agent_message_chunk", "Prima leggo il file, poi **correggo** la condizione."),
    update("tool_call", { toolCallId: "t1", title: "Read mobile/src/Reconnect.tsx", kind: "read", status: "completed" }),
    text("agent_message_chunk", "\n\nIl banner dipende da `phase`, che non viene azzerato quando lo stato torna `online`:\n\n- `phase` resta `waiting`\n- `attempt` non riparte da zero\n\nCambio la condizione e aggiorno lo stato."),
    update("plan", {
      entries: [
        { content: "Leggere Reconnect.tsx", status: "completed" },
        { content: "Azzerare phase e attempt quando torna online", status: "in_progress" },
        { content: "Eseguire i test", status: "pending" },
      ],
    }),
    update("tool_call", {
      toolCallId: "t2",
      title: "Edit mobile/src/remote.ts",
      kind: "edit",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "mobile/src/remote.ts",
          oldText: 'set({ status, hostName, error, phase, attempt, retryAt });\nconst online = status === "online";\nreturn online;',
          newText: 'set({ status, hostName, error, ...(status === "online" ? { phase: undefined, attempt: 0 } : { phase, attempt }), retryAt });\nconst online = status === "online";\nif (online) clearRetry();\nreturn online;',
        },
      ],
    }),
    { kind: "permission", requestId: "r1", toolCall: { toolCallId: "t3", title: "npm run build", kind: "execute", status: "pending" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always allow", kind: "allow_always" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] },
  ],
  c2: [
    { kind: "user", text: "Scrivi la documentazione dell'endpoint /orders." },
    text("agent_message_chunk", "Leggo i controller degli ordini per elencare i parametri."),
    update("tool_call", { toolCallId: "t1", title: "grep -r \"orders\" src/", kind: "search", status: "in_progress" }),
  ],
  c4: [
    { kind: "user", text: "Aggiungi la persistenza alle API degli ordini." },
    text("agent_message_chunk", "Prima di scrivere codice mi serve una scelta."),
    { kind: "ask", requestId: "q1", message: "Quale database vuoi usare?", schema: askSchema([{ header: "Database", text: "Quale database vuoi usare?", options: [["SQLite (Recommended)", "Un file, nessun server"], ["PostgreSQL", "Server dedicato, più scalabile"], ["MySQL"]] }]) },
  ],
  c3: [
    { kind: "user", text: "Dammi tre nomi per l'app." },
    update("tool_call", { toolCallId: "t9", title: "browser_take_screenshot", kind: "other", status: "completed", content: [{ type: "content", content: { type: "image", uri: pic("#4f6e3a", "screenshot"), mimeType: "image/svg+xml" } }] }),
    image("agent_message_chunk", "#7a4f2a", "agent image"),
    text("agent_message_chunk", "Ecco tre idee:\n\n1. **Flowcode Pocket**\n2. **Tasca**\n3. **Pilota**"),
    { kind: "turnEnd", stopReason: "end_turn" },
  ],
};

const logs = new Map<string, Ev[]>();
const seqs = new Map<string, number>();
let started = false;

function append(chatId: string, ev: Ev): Ev {
  const seq = (seqs.get(chatId) ?? 0) + 1;
  seqs.set(chatId, seq);
  const full = { ...ev, seq, at: Date.now() };
  logs.set(chatId, [...(logs.get(chatId) ?? []), full]);
  return full;
}

function init() {
  if (started) return;
  started = true;
  for (const [chatId, evs] of Object.entries(history)) evs.forEach((e) => append(chatId, e));
}

const setStatus = (chatId: string, status: string) => {
  const info = infos.find((i) => i.chatId === chatId);
  if (info) info.status = status;
  void emit("remote://msgs", [{ t: "chats", chats: infos }]);
};

/** Appends events to a chat and streams them as the desktop would to a follower. */
function push(chatId: string, evs: Ev[]) {
  const full = evs.map((e) => append(chatId, e));
  void emit("remote://msgs", [{ t: "chatevents", chatId, events: full, replay: false }]);
}

const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

/** Sends what the dev server pretends the desktop sends on connect. */
export async function chatMockConnect() {
  init();
  await emit("remote://msgs", [{ t: "chats", chats: infos }]);
}

export const chatMockCaps = ["chat", "agentViews"];

export const mockViews = [
  {
    id: "mock-timeline",
    kind: "agentView",
    apiVersion: 1,
    label: "Timeline",
    labels: { it: "Cronologia", en: "Timeline" },
    entry: "index.html",
    transport: "acp",
    devices: ["phone", "tablet"],
    permissions: ["send", "cancel", "setMode"],
    hash: "0".repeat(64),
    files: [{ path: "index.html", size: 1200 }],
  },
];

export function chatMock(msg: { t?: string; chatId?: string; text?: string; afterSeq?: number; optionId?: string | null; requestId?: string; action?: string; content?: Record<string, unknown>; cli?: string; modeId?: string } | undefined) {
  if (!msg?.t) return;
  init();
  const { chatId = "" } = msg;
  switch (msg.t) {
    case "chatopen": {
      const past = (logs.get(chatId) ?? []).filter((e) => (e.seq as number) > (msg.afterSeq ?? 0));
      later(60, () => void emit("remote://msgs", [{ t: "chatevents", chatId, events: past, replay: true }]));
      break;
    }
    case "chatprompt":
      setStatus(chatId, "busy");
      later(150, () => push(chatId, [{ kind: "user", text: msg.text ?? "" }]));
      later(900, () => push(chatId, [text("agent_message_chunk", "Ricevuto. ")]));
      later(1500, () => push(chatId, [text("agent_message_chunk", "Ci lavoro subito."), { kind: "turnEnd", stopReason: "end_turn" }]));
      later(1600, () => setStatus(chatId, "idle"));
      break;
    case "chatpermission":
      push(chatId, [{ kind: "permissionResolved", requestId: msg.requestId, optionId: msg.optionId ?? null }]);
      setStatus(chatId, "busy");
      later(700, () => push(chatId, [update("tool_call", { toolCallId: "t3", title: "npm run build", kind: "execute", status: "completed", content: [{ type: "content", content: { type: "text", text: "vite v5 building...\n✓ 142 modules transformed.\nbuilt in 2.31s" } }] })]));
      later(1300, () => push(chatId, [text("agent_message_chunk", "\n\nLa build passa: il banner sparisce appena il collegamento torna online."), { kind: "turnEnd", stopReason: "end_turn" }]));
      later(1400, () => setStatus(chatId, "idle"));
      break;
    case "chatask":
      push(chatId, [{ kind: "askResolved", requestId: msg.requestId, action: msg.action, ...(msg.content ? { content: msg.content } : {}) }]);
      if (msg.requestId === "q1" && msg.action === "accept") {
        // The first answer brings a two-question form (a single and a multi-select one).
        later(500, () =>
          push(chatId, [
            { kind: "ask", requestId: "q2", message: "Due domande sul progetto", schema: askSchema([
              { header: "ORM", text: "Quale ORM preferisci?", options: [["Prisma (Recommended)", "Schema dichiarativo"], ["Drizzle"], ["Nessuno", "Query scritte a mano"]] },
              { header: "Estensioni", text: "Quali funzioni servono?", multi: true, options: [["Migrazioni"], ["Seed di prova", "Dati di esempio per i test"], ["Backup notturno"]] },
            ]) },
          ]),
        );
      } else {
        setStatus(chatId, "busy");
        later(700, () => push(chatId, [text("agent_message_chunk", "Va bene, procedo."), { kind: "turnEnd", stopReason: "end_turn" }]));
        later(800, () => setStatus(chatId, "idle"));
      }
      break;
    case "chatcancel":
      push(chatId, [{ kind: "turnEnd", stopReason: "cancelled" }]);
      setStatus(chatId, "idle");
      break;
    case "chatmode": {
      const info = infos.find((i) => i.chatId === chatId);
      if (info?.modes && msg.modeId) (info.modes as typeof modes).currentModeId = msg.modeId;
      push(chatId, [update("current_mode_update", { currentModeId: msg.modeId })]);
      break;
    }
    case "newchat": {
      const id = `c${infos.length + 1}`;
      infos.push({ chatId: id, tabId: `t${id}`, window: WINDOW, label: "Nuova chat", agent: msg.cli ?? "claude", cwd: "C:/Users/massi", status: "idle" });
      logs.set(id, []);
      later(200, () => void emit("remote://msgs", [{ t: "chats", chats: infos }]));
      break;
    }
  }
}
