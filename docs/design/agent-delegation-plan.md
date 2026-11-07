# Agent delegation + Flowcode MCP — implementation spec

Approved UI: variant C of `docs/design/agent-delegation-variants.html` (open with `?v=c`).
Read that file for every visual detail; it was built from the real app CSS.

## Goal

A chat agent (Claude, Codex, Gemini... any ACP chat) can delegate a task to another
agent type, like a subagent. The child is a real Flowcode chat that receives ONLY the
prompt (no parent context), runs one turn, and its last assistant message is
returned to the orchestrator. The same Flowcode MCP server also handles
`open_in_browser` (replacing the stream-sniffing prototype). Everything can be turned
off in a new settings section.

## Architecture

### Transport: file IPC (works on Windows and inside WSL, no network)

- The MCP server stays a stdio Node script (`src-tauri/src/flowcode-mcp.cjs`), launched by
  the agent from `mcpServers` in `session/new` / `session/load`.
- The app gives it, via the MCP server `env`:
  - `FLOWCODE_MCP_DIR`: an IPC directory under app local data (`mcp/ipc`). For a WSL chat,
    the Linux path of it (`/mnt/c/...`, via `to_wsl_path`).
  - `FLOWCODE_MCP_TOKEN`: a random per-chat token (uuid v4). It identifies the calling
    chat; unknown tokens are rejected.
  - `FLOWCODE_MCP_TOOLS`: comma list of enabled tools, so `tools/list` only lists those.
- Request: script writes `<dir>/req-<uuid>.json` atomically (write `.tmp` then rename):
  `{ "id", "token", "tool", "args", "deadline_ms" }` (deadline as epoch milliseconds). Then polls (150 ms) for `<dir>/res-<uuid>.json`,
  reads it, deletes it, answers the MCP call. Gives up after the tool's timeout with an error.
- App: one background thread polls the dir (150 ms), handles each `req-*.json` (delete it
  first), writes `res-<id>.json` atomically: `{ "ok": true, "text": "..." }` or
  `{ "ok": false, "error": "..." }`. Stale files (> 10 min) are removed at start.
- Long waits never block the poller: each request runs on its own thread / blocking task.

### Tools (MCP names; agents see them prefixed per their own convention)

| Tool | Args | Result |
|---|---|---|
| `open_in_browser` | `target` (http(s) URL or previewable file path) | "Opened in Flowcode." / error |
| `list_agents` | — | agents the user allowed for delegation, with availability |
| `delegate_task` | `agent`, `prompt`, `title` (short, ≤ 60 chars) | `task_id`; then waits up to 45 s; if the child finished, includes its final answer |
| `get_task_result` | `task_id`, `wait_seconds` (0–45, default 45) | status (`running` / `waiting_for_user` / `done` / `failed` / `cancelled`) + final answer when done |
| `cancel_task` | `task_id` | ok |

Tool descriptions must tell the model: the child sees only the prompt, so the prompt must
be self-contained; use `get_task_result` to wait; several tasks may run in parallel.

### Delegation rules (enforced in the backend, never trusted from the agent)

- Delegation enabled in settings, and `agent` in the allowed list, and available
  (`chat_adapter_ready`).
- Children are depth 1: a child gets `open_in_browser` only, never the delegation tools.
- Max concurrent running children per orchestrator: setting (default 3).
- Child cwd = orchestrator cwd; same shell (WSL or not) as the orchestrator; no profile
  unless the orchestrator's agent is the same CLI (then same profile).
- Child permissions and questions are NEVER auto-answered; they go to the user.
- Closing the orchestrator chat closes its children. Cancel kills the child turn
  (`chat_cancel`), status `cancelled`.
- Final answer = concatenated `agent_message_chunk` text of the child's last turn
  (reset when its prompt is sent). Error → `failed` with the error message.

### Events (so the desktop window and the phones both see them)

Emitted as `ChatBody::Ext` into the chat logs (replayed on reload, sent to phones):

- On the ORCHESTRATOR chat, method `_flowcode/delegate`, params:
  `{ taskId, childChatId, agent, title, prompt, status, startedAt, endedAt?, result?, error?, lastActivity?, steps }`
  — emitted at start and on every status change; `lastActivity` (title of the child's
  latest tool call or "thinking") at most once per 2 s. Frontend keeps the latest per taskId.
- On the ORCHESTRATOR chat, method `_flowcode/delegate_request`, params:
  `{ taskId, childChatId, agent, title, kind: "permission" | "ask", requestId, toolCall?, options?, message?, schema? }`
  when the child emits `Permission`/`Ask`; and `_flowcode/delegate_request_resolved`
  `{ taskId, childChatId, requestId }` when resolved (from either side).
  Answering = invoke the existing `chat_permission` / `chat_ask` with `childChatId`.
- On the CHILD chat, method `_flowcode/task`, params:
  `{ taskId, parentChatId, parentAgent, parentTitle, prompt }` emitted first, before the prompt.
- `open_in_browser`: on the calling chat, method `_flowcode/open`, params `{ target, cwd }`.
  The frontend routes it with the existing `routeAgentOpen(..., direct: true)` (live
  events only, never on replay). The old stream detection of the flowcode tool in
  `shared/agentOpen.ts` (`openToolTarget`) is removed; shell openers detection stays.

The child chat is a normal entry in `ChatState.sessions`, owned by the orchestrator's
window, so `chat_events` / `chat-event` work for it unchanged.

### Settings (frontend, localStorage; passed to the backend)

New section "Strumenti agenti" (id `agentTools`, EN "Agent tools"), placed after "Agenti":

- Master switch: "Server MCP di Flowcode" — gives chat agents Flowcode's tools. Off = no
  server is injected at all.
- Group "Apri nel browser": on/off; sub-option "Senza chiedere il permesso" (auto-allow,
  default on).
- Group "Delega ad altri agenti": on/off; checkboxes of the agents that can be delegated to
  (installed ones: Claude, Codex, Gemini, …), default all installed; "Deleghe in parallelo"
  1–5 (default 3). Note: children ask permission like any chat; answers always yours.
- Short explanation + "Si applica alle nuove chat".

Defaults: master ON, open ON (auto-allow ON), delegation ON.
`chat_start` gets a new optional param `tools: { enabled, open, openAutoAllow, delegate, delegateAgents: string[], maxParallel }`;
missing = everything off (old callers, mobile-started chats get the same defaults the
desktop sends — check how mobile starts chats and pass the setting through if it goes via
the desktop).

`auto_allow`: only for `open_in_browser` and only if `openAutoAllow`; match the tool name
per agent (Claude: `_meta.claudeCode.toolName == "mcp__flowcode__open_in_browser"`;
others: the toolCall `title`/`kind` as the adapter reports it — verify with the adapters,
if unknown leave it to the user). Never allow_always.

## Frontend UI (variant C)

1. Orchestrator chat timeline: each `_flowcode/delegate` renders as a delegate card
   (`.chat-subcard` look: title, "Delegato a Codex" tag, step count, live line, progress
   bar, open button) anchored where the delegate tool call is. Several delegates of the
   same turn group under "N deleghe avviate".
2. Child requests: queued in the orchestrator's composer as the ask-in-composer card
   (`AskComposer`) with header "<logo> Gemini · <title> chiede", options, "1 di N"
   navigation, "Apri la chat". Answer → `chat_permission`/`chat_ask` on the child.
3. Child tab: opening a delegate (card, left list, right panel) opens a tab in the tab
   bar next to the orchestrator; its chat attaches to the existing `childChatId`
   (`useChat` attach mode: no `chat_start`, no `chat_close` on unmount). Yellow tab border
   when waiting for the user. Child view: "Compito da <parent>" block on top, locked
   footer "Gestita dall'orchestratore · sola lettura" + "Interrompi" (`cancel_task`
   equivalent: invoke a new command `delegate_cancel(taskId)`).
4. Left history: orchestrator row gets chip "N delegati" with status pips; expand shows
   child rows. Child sessions are hidden as top-level rows. Mapping orchestrator session
   id → child session ids persisted in localStorage so it survives restarts.
5. Right agents panel (`AgentInsightPanel`): tabs become Contesto / Consumi / Delegati
   (only when the delegation feature is enabled; otherwise Contesto / Consumi).
   "Strumenti" merges into Contesto as collapsible legend groups (memory, skill, Server MCP
   count). Delegati tab: delegate rows + peek; on a child: "Delegata da <parent>".

## Phases

1. Backend: IPC, tools, delegation, events, `chat_start` tools param, `delegate_cancel`. Tests.
2. Frontend core: settings section, `_flowcode/open` routing, `useChat` attach mode,
   delegate state from Ext events, child tab + child view, delegate cards, request queue.
3. Frontend panels: right panel tabs merge + Delegati; left history chip + mapping.
4. Later (not now): mobile UI for delegates, terminal (PTY) agents as orchestrators,
   MCP token estimates.

## Implementation status — 2026-11-07

Phases 1–3 are implemented. The interrupted Claude session stopped during fixes
from its correctness review. Those fixes are now complete:

- Child requests use both the child chat and request id. Permission choices carry
  their option ids, including when display labels match.
- Delegate tabs close when their orchestrator ends or changes conversation.
  History settles interrupted tasks even when final backend events arrive after
  the chat view has detached. An unavailable attached child shows an ended chat.
- Diagnostic errors no longer fail a task prematurely; rejected prompts do.
  Completed tasks keep their results while at most three completed child
  processes remain per orchestrator. Parent shutdown cancels remaining tasks.
- Child startup checks parent registration before and after adoption and checks
  the MCP deadline. Interrupted or timed-out starts close their child process.
- Browser file targets stay within the chat folder or the user's home, with WSL
  home support, directory-boundary checks, network-path rejection and link checks.
- Default delegation targets come from the installed, signed-in CLIs. Same-agent
  delegation remains available. Terminal statuses ignore stale reader snapshots.

Validation: desktop/mobile TypeScript checks and production builds passed;
85 Vitest files / 775 tests passed; Rust tests passed (307 passed, 4 ignored).
Clippy completed with existing warnings. A Node MCP smoke check covered server
initialization, tool listing, concurrent calls, deadlines, atomic IPC responses
and cleanup. Real-agent delegation and the UI have not been exercised in the app.
