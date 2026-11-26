# ACP v2 (experimental, opt-in): implementation plan

Status: plan only (2026-11-26). Nothing implemented.
Decision (user): Flowcode keeps speaking ACP v1 by default. Users who turn on **Settings → Experimental → "ACP v2"** get v2 for the agents whose adapters serve it: Claude (`@agentclientprotocol/claude-agent-acp` 0.101.0) and Codex (`@agentclientprotocol/codex-acp` 2.7.0). Every other agent stays on v1.

Sources read (the spec is the SDK the adapters ship, `@agentclientprotocol/sdk` 2.4.0, `dist/v2/schema/types.gen.d.ts` + `dist/protocol-router.js`):

- Claude adapter: `%LOCALAPPDATA%\com.maxmoffa.flowcode\acp-adapters\claude\0.101.0\node_modules\@agentclientprotocol\claude-agent-acp\dist\` — `serve.js`, `v2/*.js`, `acp-agent.js`.
- Codex adapter: `...\acp-adapters\codex\2.7.0\node_modules\@agentclientprotocol\codex-acp\dist\index.js`.
- Flowcode: `src-tauri/src/chat.rs`, `src-tauri/src/chat/{state,session,delegate,errors,models,goal,commands}.rs`, `src-tauri/src/chat_mcp.rs`, `src/chat/{chatModel,useChat,backgroundTerminals}.ts`, `src/settings/*`, `src/agents/agentToolsSettings.ts`.

---

## 0. The main finding first

ACP v2 is not "v1 + `state_update`". It is a **separate wire protocol** (SDK `experimental/v2`, still marked draft) with its own method set, request/response shapes and update kinds. Both adapters run a **protocol router** that picks v1 or v2 from the `protocolVersion` of the first `initialize`, then serve two different surfaces:

- Claude `dist/serve.js:44` `acpProtocolRouter`: `withV1(v1AgentApp)` + `withV2(v2AgentApp)`; env `CLAUDE_AGENT_ACP_PROTOCOL` = `auto` (default) | `v1` | `v2` (`serve.js:11`). The v2 surface (`dist/v2/agent.js:21`) wraps the same `ClaudeAcpAgent` with `v2: true` and translates both ways.
- Codex `index.js:56006`: `agentProtocolRouter().withV1(v1Agent).withV2(v2Agent)`; `initializeV2` (`index.js:51407`), `promptV2` (`index.js:54627`), `newSessionV2` (`52582`), `resumeSessionV2` (`52385`).
- SDK router `dist/protocol-router.js:182-233`: `requested >= 2` and v2 served → v2; else v1. A v2-shaped initialize sent to a v1-only router is rewritten to v1 (`v2InitializeToV1`, `:416`) with `fs:false, terminal:false, session.configOptions.boolean, plan:{}` — i.e. a silently **different v1 contract** from the one Flowcode declares today.

Consequence for the design: Flowcode needs a **v2 codec** in the Rust backend that speaks v2 to the adapter and re-emits the **same `ChatBody` / v1-shaped `session/update` events Flowcode produces today**. Then the frontend, the phone app, the chat log, previews and `remote-proto` keep working unchanged, and only the turn state machine gains an exact source. This is the approach of every phase below.

---

## 1. What v2 changes (from code)

### 1.1 Negotiation

| | v1 (today, `state.rs:915-924`) | v2 |
|---|---|---|
| Request | `{protocolVersion:1, clientInfo, clientCapabilities:{fs,terminal,session.compaction,elicitation.form,_meta}}` | `{protocolVersion:2, info:{name,version}, capabilities:{auth?, elicitation?, _meta?}}` (`types.gen.d.ts:4012-4070`). No fs/terminal (v2 has no client fs or terminals at all). |
| Response | `{protocolVersion, agentInfo, agentCapabilities:{loadSession, promptCapabilities.image, sessionCapabilities.close...}, authMethods}` | `{protocolVersion:2, info, capabilities:{session:{prompt:{image:{},embeddedContext:{}}, mcp:{stdio:{},http:{}}, delete, fork, additionalDirectories, systemPrompt}, providers:{}, _meta}, authMethods:[{methodId,type}]}` (Claude `v2/initialize.js:64`, Codex `index.js:51420-51455`). `close`, `resume`, `list`, `cancel` are baseline in v2 (no capability flag). Capabilities are presence objects (`{}`), not booleans. |
| Implied client caps | what Flowcode declares | Claude maps every v2 client to v1 caps `fs:false, terminal:false, session:{configOptions.boolean, notices, compaction}, plan:{}, subagents:{}` (`v2/initialize.js:15-50`). Codex: `ClientCapabilities.fromV2`, `subagentProtocol(caps, 2) === "standard"` (`index.js:48226-48233`). **So v2 always turns on native subagent sessions, notices, compaction entities and v2 plans.** |
| Unserved on v2 | — | Claude v2 does not register `_session/goal`, `_session/steering`, `_session/async_task/stop` and strips the AIR goal/asyncTasks capabilities (`v2/initialize.js:57-100`). Codex v2 still registers `_session/goal`, `_session/steering`, `_session/async_task/stop` (`index.js:56005`). |

v1 agents receiving `protocolVersion: 2`: per v1 they answer with the latest version they support (1), but they parse `clientCapabilities`/`clientInfo`, which a v2 request does not carry → they would run with no declared capabilities. **Never send v2 to an agent not on the allowlist.**

### 1.2 Methods

| v1 method Flowcode uses | v2 |
|---|---|
| `session/new` `{cwd, mcpServers}` | same name; MCP servers **require `type`** (`"stdio"`/`"http"`, `types.gen.d.ts:4271`); response `{sessionId, configOptions?, availableCommands?, _meta?}` — **no `modes`, no `models`** (Claude `v2/session.js:68`). |
| `session/load` (replays, `state.rs:945`) | gone → `session/resume {sessionId, cwd, mcpServers, replayFrom:{type:"start"}}` replays; without `replayFrom` it resumes silently (Claude `v2/session.js:28`, Codex `52385`). After the replay and **before the response** the agent sends a current `state_update` snapshot (+ subagent/terminal states). |
| `session/prompt` → response at turn end `{stopReason}` | response **at insertion**: `{messageId}` (`types.gen.d.ts:2704`; Claude `v2/prompt.js:22-60`: `user_message` echo, then resolve). Rejected before insertion → JSON-RPC error, `-32800` if a cancel ended it in the queue. The rest of the turn is `state_update`s. |
| `session/cancel` (notification) | same; ends the work with `idle stopReason:"cancelled"`, ends a not-yet-inserted prompt with `-32800`. |
| `session/set_mode` (`state.rs:359`, `delegate.rs:722`) | gone: the mode is the config option of category `mode`; `current_mode_update` is dropped by the adapter (Claude `v2/session-update.js:63`). |
| `session/set_model` (`session.rs:441`) | gone: model = config option of category `model`. |
| `session/set_config_option {configId, value}` | value is tagged: `{configId, type:"id", value}` or `{type:"boolean", value}` (`types.gen.d.ts:4648`). Response/updates name options `configId` (not `id`) and select groups `groupId` (not `group`) (Claude `v2/session.js:93-110`). |
| `session/close` (`state.rs:313`) | same (baseline). |
| `_session/goal` (`session.rs:591`) | Codex: served. Claude v2: **method not found**. |
| agent→client `session/request_permission {sessionId, toolCall, options}` | `{sessionId, title, description?, subject:{type:"tool_call", toolCall:<patch>}, options}` (Claude `v2/permission.js:10`). Answer shape unchanged; but on v2 `cancelled` is read as "the user refused" unless a `session/cancel` is in progress (`v2/permission.js:24-40`). |
| `elicitation/create` | same in v1 and v2 (Claude `v2/agent.js`, `createElicitation`). |
| `$/cancel_request` | same (protocol method). |
| new agent methods | `terminal/cancel {sessionId, terminalId}`, `tool_call/cancel {sessionId, toolCallId}` (stop background work), `auth/login`, `auth/logout`, `providers/*`, `session/delete`, `session/fork`, `session/list`. |

### 1.3 Session updates

| v1 kind (what Flowcode's views read) | v2 |
|---|---|
| `agent_message_chunk` / `agent_thought_chunk` / `user_message_chunk` | same names, **`messageId` required**; chunks of different messages may interleave. New full-message kinds `user_message`, `agent_message`, `agent_thought` (`{messageId, content[]}`); an empty one **clears** that message (used before replayed chunks, Claude `v2/agent.js` `replayClear`). Live prompt is echoed as `user_message` (Claude `v2/prompt.js:28`). |
| `tool_call` + `tool_call_update` | only `tool_call_update` (upsert by `toolCallId`); `null` **clears** a field (v1: unchanged); a re-announced call sets omitted fields to `null` (`v2/tool-call.js:41`). New `capabilities:{cancel:{}}` on cancellable background calls. Status adds `paused` (`types.gen.d.ts:238`). |
| tool content `{type:"diff", path, oldText, newText}` | `{type:"diff", changes:[{operation:add/delete/modify/move/copy, path...}], patch?:{format, text}}` — **no old/new text** (`types.gen.d.ts` `Diff`, `DiffChange`). A v1 diff is an error on v2 (`v2/tool-call.js:68`). |
| command output as tool content/`rawOutput` text | `{type:"terminal", terminalId}` content + `terminal_update {terminalId, command?, output?{data base64}, exitStatus?{exitCode,signal}, capabilities?{cancel}}` and `terminal_output_chunk {terminalId, data base64}` (Claude `v2/terminal.js`, Codex `index.js:32860`). |
| `plan {entries}` | `plan_update {plan:{type:"items", planId, entries}}` or `{type:"markdown", planId, content}` (Codex `index.js:32629`), `plan_removed`. |
| `current_mode_update` | not sent. |
| `config_option_update {configOptions}` | same kind, `configId`/`groupId` names; now also sent for client-requested changes. |
| `available_commands_update` | commands tagged `type:"command"`, input `type:"text"`; initial list comes **in the setup response** (`availableCommands`), not as an update (Claude `v2/agent.js` `setupCommands`). |
| `usage_update`, `session_info_update`, `compaction_*`, `notice` | same. |
| `subagent_update`, `session_message(_chunk)` | same shape; v2 always on (see 1.1); a subagent's state also arrives as a `state_update` **on the child's own sessionId** (`v2ChildStateUpdate`). |
| — | **`state_update`** (below). |
| Codex `async_task_state_update` | renamed `_async_task_state_update` (`index.js:32777`). |

### 1.4 `state_update` (the reason for this work)

`types.gen.d.ts:3198-3360`; Claude `v2/prompt.js:76-110` (`v2Foreground`) and `acp-agent.js:7667-7727` (`foregroundState`, `startForeground`, `startAutonomousCycle`); Codex `index.js:52181-52240` (`trackCodexForegroundWork`, `trackCodexTurnCompletion`, `reportCodexTurnState`).

- `{state:"running"}` when foreground work starts — a prompt's turn (right after its `user_message`) **or work the agent started by itself** (Claude: a follow-up cycle after a background subagent/task; Codex: a runtime turn no prompt owns).
- `{state:"requires_action"}` while the whole foreground is blocked on a permission/question; back to `running` when none is open (not after a cancel).
- `{state:"idle", stopReason, usage?, _meta?, error?}` when it ends. `stopReason` ∈ `end_turn | max_tokens | max_turn_requests | refusal | cancelled | error` (+ `_custom`). `error` carries the JSON-RPC error `{code, message, data}` v1 would have answered the prompt with (Claude `v2Foreground.failed`, Codex `toV2IdleState` `index.js:36270`).
- `idle` **without** `stopReason` = a snapshot/repeat (resume snapshot, background list change): MUST NOT count as a completion.
- `background: [{type:"terminal", terminalId} | {type:"tool_call", toolCallId} | {type:"subagent", sessionId}]` — complete snapshot on every state of a session that reports it; when it changes the agent re-sends the current state with the new list (Claude `V2Background.changed`, `v2/background.js`).
- Claude ends a turn's work **at its result**, also when v1 would hold the prompt response for background subagents (`Turn.deferredSettle`, `acp-agent.js:1219` `endsTurnsWithLiveSubagents`); subagent output and requests then arrive while idle, and their follow-up is a new `running…idle` cycle.
- A prompt sent while autonomous work runs is taken over by it ("a turn takes over a cycle … only the owner's end ends the work", `startForeground`) → one `idle` at the end.

---

## 2. Flowcode code paths that depend on v1

The codec (`src-tauri/src/chat/acp_v2.rs`, new) owns every "v2 → today's event" mapping. "Change" says what must change outside it.

| Area (file:line) | v1 behaviour | v2 behaviour | Change |
|---|---|---|---|
| Handshake `state.rs:902-971` `handshake` | `initialize` v1, `session/load` or `session/new`; reads `agentCapabilities.*` | v2 initialize; `session/resume` + `replayFrom:start`; caps from `capabilities.session.*` | Branch on `Chat.protocol`. `prompt_images` ← `capabilities.session.prompt.image` present; `can_close` ← true; `can_load` ← true. If the answer has `protocolVersion != 2` (or `initialize` errors with unsupported version): **kill and restart the agent on v1** (`acp_v2_fallback` error caught in `start_blocking` `state.rs:1008-1036`, same loop as `transient_start_failure`). |
| `new_session` `state.rs:769-778` | `{cwd, mcpServers}`; result has `modes`, `models` | MCP entries need `"type":"stdio"`; result has `configOptions`, `availableCommands` | `chat_mcp::server_entry` (`chat_mcp.rs:218`) gains the `type` field when v2 (add it always? v1 stdio is recognised by **missing** `type` in the Claude adapter — keep v1 untouched, add only on v2). Codec synthesizes `modes {availableModes, currentModeId}` from the `mode` config option and emits `available_commands_update` from `availableCommands`. Rename `configId→id`, `groupId→group` before `normalize_models`/`thought_from_config_options` (`models.rs:89-120, 202`). |
| Start result / restart `state.rs:1150-1177` | `modes` from result | synthesized `modes` | none beyond codec; add `acp_version: u8` to `ChatStarted` (`chat.rs:316`) for the UI/debug. |
| Status machine `chat.rs:217-233` `next_status` | Busy on `User`; Idle on `TurnEnd`/`Error`; heuristic opening on agent output while idle (`starts_autonomous_turn` `chat.rs:238`) | open/close only on `state_update` (plus our `User`) | `next_status` gets a `protocol` arg: on v2 the `(Idle, Update) if starts_autonomous_turn` arm is off. The codec opens an agent-started turn with an explicit call (`Chat::open_agent_turn`, under the log lock like `emit_when`) and closes it with `TurnEnd`. |
| `emit_when` `session.rs:193-257` | sets `autonomous`; end marker `is_autonomous_end_marker` (`chat.rs:245`); startup grace `STARTUP_GRACE_MS`; child-link guard | autonomous start/end exact | On v2: skip `is_autonomous_end_marker`, skip the startup-grace and link special cases (only `state_update` opens turns). Keep emitting `_flowcode/autonomous` so views don't change. |
| 120 s fallback `session.rs:148, 177-182, 1001-1018` | ends a hanging autonomous turn | not needed | `watch_autonomous` is a no-op on v2. Keep one safety net only for a lost `idle` after `session/cancel` (10 s, see cancel). |
| Prompt `state.rs:147-205` + response `session.rs:612-630` | `Pending::Prompt` response = turn end → `TurnEnd{stopReason}` / `prompt_failed` | response = insertion `{messageId}`; turn end = `idle` | New `Pending::PromptV2`. `Ok({messageId})` → mark inserted, remember id (to drop its `user_message` echo), **no** `TurnEnd`. `Err(-32800)` after our cancel → `TurnEnd cancelled` if foreground idle. Other `Err` → `prompt_failed` as today; if foreground is still `running` (prompt queued behind agent work) emit the `Error` and re-open the turn (`_flowcode/autonomous`) so views stay in step with the backend. |
| Turn end from `idle` | — | `idle` + `stopReason` | `end_turn/max_tokens/max_turn_requests/refusal/cancelled` → `TurnEnd{stopReason}` + `refresh_goal_soon` (as `session.rs:620-621`). `error` → build `RpcError` from `error{code,message,data}` → `prompt_failed(error_text, is_limit_error)` and `end_dead_session` if `is_session_gone` (`errors.rs:83-127`). `idle` without `stopReason` → no event. |
| Hold for background subagents | Claude holds the v1 prompt response until spawned background subagents end (Flowcode declares no AIR `backgroundSubagents`) → chat busy until then | `idle` at the result; subagents keep running; follow-up cycle later | Codec keeps v1 parity: while the last `background` list has `type:"subagent"` items, an `idle` with `stopReason` is **held** (chat stays Busy, stop reason remembered); `TurnEnd` goes out at the first `idle` with no subagent items (the repeat `idle` without stopReason counts once a reason is held). Background **terminals/tool calls never hold** (a dev server would keep the chat busy forever, v1 doesn't hold for them either). |
| `Waiting` (`chat.rs:219`, permissions map) | Waiting while a permission/ask is open in a turn | `requires_action` | Keep the permissions-map derivation (parity, also covers requests while idle). Log a mismatch with `requires_action` in debug builds only. |
| Cancel `state.rs:269-281` | `session/cancel`; `end_autonomous("cancelled")` immediately; cancel open permissions | `idle cancelled` comes from the agent | v2: send `session/cancel`, then `cancel_permissions` (they are answered `cancelled` **after** the cancel, so the adapter reads them as abort, not refusal); do not end the turn locally; start a 10 s timer that forces `TurnEnd cancelled` if no `idle` arrived. |
| Permission requests `session.rs:633-685`, `chat_mcp::auto_allow` `chat_mcp.rs:693` | read `params.toolCall` | `params.subject.toolCall` + `title` | Codec rewrites params to `{toolCall: subject.toolCall + {title}, options}` before the existing code runs. Note: the user's "Cancel/dismiss" on a card is a **refusal** on v2 (the agent continues), v1 aborted the tool. Accept, document. |
| Updates `session.rs:686-723` | verbatim `session/update` into `ChatBody::Update` | v2 kinds | Codec `translate(&mut V2State, params, update) -> Vec<Out>`: first `tool_call_update` per `(session, toolCallId)` → `tool_call` (drop `null`s; a re-announce becomes a fresh `tool_call`); diffs → v1 `{path, oldText, newText}` per change built from the patch hunks (approximation, see risks); `terminal` content + `terminal_update`/`terminal_output_chunk` → folded into the owning tool call's text content (base64-decoded, capped 64 KiB, coalesced ≤1/s and on exit; exit status into `status`/`rawOutput.exitCode`); `plan_update items` → `plan {entries}`, `markdown` → `plan` with one entry per checklist line (else dropped), `plan_removed` → `plan {entries:[]}`; `user_message` live → dropped (Flowcode logs `User` itself); `user_message`/`agent_message`/`agent_thought` with content during replay → the matching `*_chunk` per block; empty ones → dropped; `config_option_update` → renamed fields + synthesized `current_mode_update` when the mode value moved; `state_update` → state machine only (never logged); child-session `state_update` → dropped (the parent's `subagent_update` mirror carries it); unknown kinds → dropped (not logged). |
| `route_child_update` `state.rs:784-823` | only with `FLOWCODE_NATIVE_SUBAGENTS=1`, Claude only (`state.rs:907`) | **always on** for Claude and Codex | This experimental path becomes the v2 default: it must be hardened (see phase 4). Codex note at `state.rs:906`: with `subagents` "Codex sends no launch message and puts the child's model options on the main stream" — verify on 2.7.0 v2 and filter by sessionId. |
| Accumulated answer `session.rs:16-32, 223-230` | message chunks of the turn; `tool_call` resets `final_answer` | same once translated | none (codec emits `tool_call`). `messageId` interleaving: chunks of two messages could alternate (see risks). |
| Delegate tasks `delegate.rs:155-190, 467-512, 741-757` | `TurnEnd` ends the task with the answer; prompt error fails it | exact turn end via held `idle` | No change while children stay on v1 (decision for phases 1-5: `start_child` passes `acp_v2: false`). Phase 6: inherit the parent's flag; the hold rule above is what makes the task's answer complete. |
| Auto-resume `session.rs:967-996`, `state.rs:121-142` | `prompt_resume` retries while `agent_busy` | same gate | none. Limit errors arrive as `idle error` with `data.errorKind` → `is_limit_error` works on the rebuilt `RpcError`. |
| Goal `session.rs:541-599`, `goal.rs:57-67` | `_session/goal` for actions; refresh at `TurnEnd` | Codex OK; Claude v2: method not found | `goal::actions(agent, protocol)`: Claude on v2 → `[]` (chip shows, no clear button) until the adapter serves it; refresh at `TurnEnd` unchanged. |
| Model / thought / mode setters `session.rs:430-484`, `state.rs:355-365`, `delegate.rs:715-725` | `session/set_model`, `session/set_mode`, untagged `set_config_option` | config options only, tagged | `set_model`: v2 always `ModelVia::ConfigOption`; add `"type":"id"`. `set_mode`: v2 → `set_config_option` on the mode option id, then emit `current_mode_update` as today. |
| `/clear` renew `state.rs:296-349` | needs `sessionCapabilities.close` | baseline | `can_close = true` on v2; the old session's late `idle cancelled` is dropped by `is_stale` (`session.rs:326`). |
| Phone alerts `session.rs:338-349` (`AlertKind::Done` on `TurnEnd`) | | | none: `TurnEnd` keeps its meaning (exact for autonomous turns now). |
| Frontend `src/chat/chatModel.ts:737-858`, `useChat.ts` queue | consumes `ChatBody` events | same events | none in phases 1-4. `useChat.ts:311` passes `acpV2`. |
| Background terminals card `src/chat/backgroundTerminals.ts` | regex over tool text (`launchOf`, `statusIn`) | exact: `background` list + `terminal_update.exitStatus`, `terminal/cancel` | Phase 5 (optional): codec emits `_flowcode/background {terminals:[{toolCallId, terminalId, running, exitCode}]}`; card prefers it; "Stop" calls new `chat_cancel_background` → `terminal/cancel`/`tool_call/cancel`. Replaces the parked "native async tasks via initialize" idea (v2 needs no AIR `asyncTasks`; Claude v2 even strips it). |
| Phone protocol `src-tauri/remote-proto/src/msg.rs:495-520` | events are opaque `Value` | same events | **No remote-proto change.** Optional: `ChatSummary` could carry `acp_version` for a debug badge — not needed. |
| `provider_auth.rs:374` | its own v1 ACP link for sign-in | | unchanged (stays v1). |

---

## 3. Other agents

| Agent | Launch (`chat/launch.rs:5-13`) | v2? | Rule |
|---|---|---|---|
| Claude | pinned `claude-agent-acp@0.101.0` | yes (router, `serve.js:44`) | allowlisted |
| Codex | pinned `codex-acp@2.7.0` | yes (router, `index.js:56006`) | allowlisted |
| Gemini | `gemini --experimental-acp` (user's install) | unknown; its own ACP code, may adopt the SDK router any time | **never offered** |
| OpenCode | `opencode acp` (user's binary) | unknown (TS SDK, version varies) | never offered |
| Cline | `cline --acp` (3.0.75 here; bundled exe) | not determinable from the binary | never offered |
| Vibe | `vibe-acp` (Python SDK) | unknown | never offered |

Allowlist: `fn offers_acp_v2(agent) -> bool { matches!(agent, "claude" | "codex") }` in `chat/launch.rs`, next to the pins. Any agent whose `initialize` answers `protocolVersion != 2` (Claude with `CLAUDE_AGENT_ACP_PROTOCOL=v1`, a future pin that drops v2, a WSL npx fallback that resolved something else) is restarted on v1 — never continued on the router-rewritten v1 contract (`plan:{}`, `configOptions.boolean` would change event shapes Flowcode doesn't handle). A pin bump of either adapter must re-run the phase-1 fixture tests.

---

## 4. Settings

How settings reach the backend today: localStorage stores (`src/lib/storage.ts`) wrapped by `createStore` (`src/agents/agentToolsSettings.ts`, `src/agents/autoResumeSettings.ts`), read by `useChat.ts:311-321` and passed as `chat_start` arguments (`commands.rs:13-46`). Phone-started chats are opened as desktop tabs, so they go through the same `useChat` path. Delegated children inherit `Extras` from the parent (`delegate.rs:756`).

New pieces:

- `src/settings/experimentalSettings.ts` — `createStore<{ acpV2: boolean }>`; key **`flowcode.experimental.acpV2`** (default `false`); `useExperimentalSettings`, `getExperimentalSettings`, `setAcpV2(enabled)`.
- `SettingsSection` gains `"experimental"` (`src/settings/SettingsSectionContext.tsx:3-16`), placed before `info`; entries in `SECTION_TITLE_KEYS` / `SECTION_DESCRIPTION_KEYS` / `SECTION_SHORT_KEYS` (`src/settings/settingsIndex.ts:5-51`); an icon in `src/settings/SectionIcons.tsx:5` (flask glyph); a block `{section === "experimental" && ...}` in `SettingsPage.tsx` (next to `info` at `:795`) with a warning note and one `SettingRow id="acpV2"` + `Switch` (pattern of `autoResume`, `SettingsPage.tsx:644-651`); a `SETTINGS_INDEX` entry `{ id: "acpV2", section: "experimental", label: "settings.experimental.acpV2.label", desc: "settings.experimental.acpV2.desc", keywords: "sperimentale experimental acp protocollo protocol v2 claude codex stato state turno turn beta" }`.
- i18n (`src/i18n/locales/en.ts`, `it.ts`, near `settings.section.info` `:683`):

| key | en | it |
|---|---|---|
| `settings.section.experimental` | Experimental | Funzioni sperimentali |
| `settings.section.experimental.desc` | Features still being tested. They may change or break; turn them off if something looks wrong. | Funzioni ancora in prova. Possono cambiare o non funzionare: disattivale se qualcosa non va. |
| `settings.section.experimental.short` | Features in testing | Funzioni in prova |
| `settings.experimental.acpV2.label` | ACP v2 protocol | Protocollo ACP v2 |
| `settings.experimental.acpV2.desc` | Claude and Codex chats use the new version of the Agent Client Protocol: the agent itself says exactly when it starts and stops working, also for work it starts on its own. Other agents keep version 1. Applies to chats started after the change. | Le chat di Claude e Codex usano la nuova versione dell'Agent Client Protocol: è l'agente a dire esattamente quando inizia e finisce di lavorare, anche per il lavoro che avvia da solo. Gli altri agenti restano alla versione 1. Vale per le chat avviate dopo la modifica. |
| `settings.experimental.acpV2.restart` | Open chats keep the protocol they started with. Restart a chat to switch it. | Le chat aperte mantengono il protocollo con cui sono partite. Riavvia una chat per cambiarlo. |

- Flag to Rust: `useChat.ts:311` adds `acpV2: getExperimentalSettings().acpV2`; `chat_start` gains `acp_v2: Option<bool>`; `Extras` (`state.rs:1000-1005`) gains `acp_v2: bool`; `start_once` sets `Chat.protocol = if extras.acp_v2 && offers_acp_v2(&agent) { V2 } else { V1 }` (the effective version after the handshake, `V1` after a fallback). `start_child` passes `false` until phase 6.
- **Restart policy**: the flag is read once per agent start. Running chats keep their protocol; restarting a chat (pond "restart", app restart with restored tabs, phone "new chat") picks up the current value, and the session resumes either way (the transcript belongs to the agent, not to the protocol). `/clear` (renew) keeps the running process and so its protocol. Turning the flag off never touches running chats.
- Optional (phase 3): the chat header popover shows "ACP v2" when `ChatStarted.acpVersion === 2`, so testers know which chats run it.

---

## 5. Phases

Each phase ends green (`cargo test -p flowcode` for the touched modules, `npx vitest run`, `npx tsc --noEmit`) and is committed on its own. The flag stays invisible until phase 3, so phases 1-2 can't affect users.

### Phase 1 — codec, pure (no wiring)
- `src-tauri/src/chat/acp_v2.rs`: `AcpProtocol {V1, V2}`; request builders (`initialize_params`, `resume_params`, `set_config_option_params`, MCP `type` tagging); response readers (`caps_from_initialize`, `setup_from_response` → v1-shaped `{modes, configOptions, availableCommands}`); `V2State` + `translate(...) -> Vec<Out>` (`Out::Update(Value) | Out::Running | Out::RequiresAction | Out::Idle{stop_reason: Option<String>, error: Option<RpcError>, background: Option<Vec<Value>>}`); permission params rewrite; diff and terminal folding.
- Fixtures: record real v2 streams once per adapter (a throw-away Node script under `scripts/` that runs the installed adapter with a scripted client: new session, a prompt with an Edit, a Bash, a background Bash, a Task subagent, a permission, a cancel, a resume with replay) into `src-tauri/src/chat/fixtures/acp_v2_{claude,codex}.jsonl`.
- Tests: each mapping row of section 2 (tool_call upsert/rename/null-drop/re-announce, diff patch → old/new, terminal fold + base64 + cap + exit, plan items/markdown/removed, user/agent message replay vs live echo, config `configId`/`groupId` rename + synthesized mode update, permission subject rewrite, unknown kind dropped, idle with/without stopReason, error → `RpcError` with `is_limit_error` true for a `rate_limit` fixture); a fixture replay test asserting the output contains only kinds `chatModel.ts` handles (`chatModel.ts:685-712`).

### Phase 2 — backend wiring behind the flag
- `Chat.protocol` field (`session.rs:39`), `Extras.acp_v2`, `chat_start(acp_v2)`; `handshake` v2 branch + fallback restart; `new_session`/resume v2; `Pending::PromptV2`; `next_status(.., protocol)`; `Chat::open_agent_turn`; hold rule; cancel timer; `set_model`/`set_thought`/`set_mode` v2; `goal::actions(agent, protocol)`; `watch_autonomous` off on v2.
- Tests (Rust, pure where possible): `next_status` v2 table (no heuristic opening; open via running; close via idle+reason; repeat idle ignored); hold rule (subagent items hold, terminal items don't, release on later idle w/o reason); prompt response matrix (`{messageId}` → no TurnEnd; `-32800` after cancel; error while running re-opens); handshake fallback decision (`protocolVersion` 1 → `acp_v2_fallback`); `offers_acp_v2` allowlist; `start_child` never v2; v1 tests untouched and passing (regression guard: every existing test in `chat.rs:331-505`, `session.rs:1225-1322`, `state.rs:1190-1298`, `delegate.rs` keeps running against V1).

### Phase 3 — settings + UI
- `experimentalSettings.ts`, section, row, icon, index entry, i18n, `useChat.ts` arg, header "ACP v2" hint.
- Tests: vitest for the store (default off, persists, `setAcpV2` idempotent); `settingsIndex` has an entry for every section (if a test exists, extend it); `tsc` enforces `it.ts` parity with `en.ts`.

### Phase 4 — subagents on v2 (forced native sessions)
- Harden `route_child_update` (`state.rs:784-823`) as the default for v2 chats: drop child `state_update`/config chatter for Codex too, nest by `session_message` launch id, close child trays on the parent's `subagent_update {state: idle}`; check `src/chat/codexSubagents.ts` (built on Codex tool calls) still finds its calls or switch it to `subagent_update` on v2.
- Tests: fixture replays (Claude Task subagent, Codex spawn) → items nest under the launch, no child config/model leak into the parent (`models_changed` not called for child sessions).

### Phase 5 — exact background work (optional, after testers' feedback)
- `_flowcode/background` ext from the `background` list + `terminal_update`; `backgroundTerminals.ts` prefers it on v2 chats; `chat_cancel_background(chatId, terminalId|toolCallId)` → `terminal/cancel` / `tool_call/cancel` (only when the item advertised `capabilities.cancel`).
- Tests: Rust ext payload from fixtures; vitest card state from ext events (running → exited, cancel button only when cancellable).

### Phase 6 — delegated children on v2 (optional)
- `start_child` inherits the parent chat's effective protocol (terminal-tab parents: the setting). Hold rule guarantees the task answer includes the subagents' follow-up.
- Tests: `TaskState::apply` fed with a held v2 sequence ends once, with the final answer.

---

## 6. Risks

1. **v2 is a draft** (`sdk/experimental/v2`, "unstable" imports in both adapters). Any adapter bump can change shapes. Mitigation: pins + fixtures re-recorded on each bump; codec tolerant (unknown → drop); fallback to v1 on any handshake mismatch; flag off by default.
2. **Native subagent sessions are forced on v2** (Claude `subagents:{}` baseline, Codex `"standard"`). Today Flowcode only runs that path behind `FLOWCODE_NATIVE_SUBAGENTS=1` for Claude, and the code comment says Codex misbehaves with it (`state.rs:906`). Highest UX risk: subagent tray, delegate strip, Codex subagent cards. Phase 4 exists for this; until it is done, testers should expect subagent glitches.
3. **Diffs**: v2 diffs carry changes + a patch, not full old/new text. The rebuilt v1 diff shows hunks only (no whole-file context); `shared/lineDiff.ts` renders it, but "open file at line" and big-file diffs may look different. A proper fix is a patch renderer in `ChatItems.tsx` + `mobile/src/ChatBody.tsx` (phone parity), out of scope here.
4. **Command output** moves to `terminal_update`; if the fold misses a case, Bash output vanishes from tool cards (and from `backgroundTerminals.ts` regexes, which read text). Fixture tests for foreground and background Bash, Codex exec.
5. **Earlier turn end** (Claude ends work at the result): without the hold rule the queue would dispatch and delegate tasks would finish while subagents still run. Hold on `subagent` items only; a misreported list (missing, or an item that never leaves) keeps the chat busy → cancel still works (forces `idle cancelled`); add a debug log of every held/released idle.
6. **Permission "cancel" = refusal on v2**: the dismiss button no longer aborts the tool; the agent continues. Turn cancel still aborts because `session/cancel` is sent first (keep that order in `ChatState::cancel`).
7. **Duplicate or missing user messages**: live `user_message` echo dropped (we log `User`), replay converted to chunks. A prompt rejected before insertion still shows the user's bubble with the error (as v1).
8. **Message interleaving**: v2 allows chunks of two `messageId`s to alternate; the frontend appends chunks to the last item. Claude sends one message at a time in practice; if fixtures show interleaving, buffer per `messageId` in the codec.
9. **Goal on Claude v2**: `_session/goal` not served → no "clear" control (chip still updates from the transcript).
10. **Modes**: synthesized from the `mode` config option; an agent whose mode option lacks `category:"mode"` loses the mode selector on v2 (Codex/Claude both set it — verify in fixtures).
11. **Fallback cost**: a v2 start that gets v1 kills and restarts the agent (few seconds; Codex start gate held again). Only when the adapter refuses v2, which shouldn't happen with the pins.
12. **Log/preview compatibility**: logs and saved previews (`persist_preview`) contain translated v1-shaped events, so turning the flag off later still renders old chats. Nothing v2-only may reach the log (enforced by the phase-1 "only known kinds" test).
13. **Phone**: no protocol change, but the phone renders the same translated events; every mapping is shared. Phone-side tests (`mobile/src/chatSession.test.ts`) keep running on v1 fixtures; add one v2-translated fixture.
14. **Two writers of turn state**: on v2 nothing but `state_update` + our `User` may move the status; any leftover v1 path (heuristic, end marker, 120 s timer, `end_autonomous` in cancel) firing on a v2 chat would double-end turns. Phase-2 tests assert each is inert on V2.

---

## 7. Manual test checklist (flag on, Windows; repeat key items in WSL)

Claude chat and Codex chat, each:
- [ ] New chat starts; header hint says ACP v2; model, thinking and mode selectors show and switch (and survive `/clear`).
- [ ] Simple prompt: busy sweep from send to answer end; idle exactly at the end; queued message goes right after.
- [ ] Edit/Write: diff card shows the change; permission card shows command/paths; allow once / always / reject behave; dismissing a card = the agent is told "no" and continues.
- [ ] Bash: output appears in the tool card; failing command shows exit status.
- [ ] Background Bash (`run_in_background`): card under the composer lists it; chat goes idle while it runs; it shows as ended when it exits.
- [ ] Cancel mid-turn (Stop): turn ends as cancelled within a second; open permission card closes; next prompt works.
- [ ] Cancel while a permission card is open.
- [ ] Claude Task subagent in background: chat stays busy until the follow-up answer (hold rule), subagent tray nests its work, no model/config flicker in the header.
- [ ] Agent-started turn (Claude: background subagent finishes after idle / cross-session message; Codex: unowned runtime turn): view shows working, ends exactly with the agent, no 2-minute ghost.
- [ ] Prompt typed during such an agent-started turn is accepted and the turn ends once.
- [ ] Resume a previous session (restore tab / history): history replays without duplicated user messages, chat ends idle, then prompts work.
- [ ] `/clear` renews on the same process; old session's late events don't appear.
- [ ] Usage limit / signed out: limit pond card / sign-in prompt as on v1; auto-resume fires at reset.
- [ ] Goal: `/goal ...` chip shows; Codex pause/resume/clear work; Claude shows no clear button.
- [ ] Phone: chat list status (busy/waiting/idle), live stream, Done notification on turn end, permission from phone, cancel from phone.
- [ ] Delegated task from a v2 parent: child runs v1 (phases 1-5) and finishes with its answer.
- [ ] Gemini/OpenCode/Cline/Vibe chats with the flag on: unchanged (v1), check one prompt each.
- [ ] Flag off: new chats are v1 again; chats already open keep working.
- [ ] Fallback: start Claude with `CLAUDE_AGENT_ACP_PROTOCOL=v1` in the profile env → chat comes up on v1 after one restart, no error shown.
