# Flowcode remote protocol (v1)

How the Flowcode phone app talks to Flowcode desktop. The types live in the
`flowcode-remote-proto` crate (`src-tauri/remote-proto`); the desktop side is
`src-tauri/src/remote.rs`. This file is the contract: if they disagree, fix
the code or this file, not just one.

## Transport

- **iroh** (Rust, QUIC). The desktop runs an iroh `Endpoint` with the default
  n0 relays and address lookup, so a phone reaches it from any network with no
  VPN and no open port: it hole-punches a direct path and falls back to a
  relay. Everything is end-to-end encrypted and mutually authenticated by the
  peers' keys; relays only forward ciphertext.
- ALPN: `flowcode/remote/1` (`proto::ALPN`). A breaking protocol change gets a
  new ALPN, so an old phone fails the handshake instead of misreading frames.
- The desktop's identity is a persisted secret key (`remote-node.key` in the
  app config dir), so its **node id** (the public key) is stable across
  restarts (on Windows the file is sealed with DPAPI, tied to the user's
  login). Only one Flowcode instance may run the endpoint for a config dir
  (a lock file next to the key); a second one reports an error in its remote
  status instead of fighting over the node id. The phone also has a persistent iroh secret key; its node id is
  what the desktop binds a paired device to. **Keep the phone's key stable**:
  a new key is a new device and must pair again.
- One connection = one **bidirectional QUIC stream**, opened by the phone
  (`open_bi`) right after connecting. The desktop never opens streams.
- Liveness: the phone drives it. At the QUIC level the phone sends iroh's
  default keep-alives (5 s) and has a 90 s idle timeout; the desktop's keep-alive
  is 25 s (so a backgrounded phone's radio can idle) and its idle timeout 120 s.
  The effective idle timeout is the smaller of the two peers', i.e. 90 s. On top
  of that the phone `ping`s every 20 s and treats 60 s without any frame from the
  desktop as a dead link (always before QUIC's own timeout). When the app comes
  back to the foreground it pings at once and drops and redials the link if no
  frame arrives within 8 s.

## Framing

Each message is a **frame**: `u32` big-endian length, then that many bytes of
UTF-8 JSON. The maximum frame is **1 MiB** (`proto::MAX_FRAME`); a larger
length is a protocol error and the reader gives up on the stream.
A length with its **top bit set** marks a deflated frame: the body is raw
deflate of the JSON (the 1 MiB limit applies to the inflated size, which the
reader enforces). It is only ever sent to a peer that asked for it with
`hello {caps: ["compress"]}`, after seeing `compress` in the other side's
`caps` (so old peers never meet one); frames under `proto::COMPRESS_MIN`
(1 KiB) or that deflate by less than 10% go out plain. `read_frame` accepts
both forms, `write_frame_with(.., true)` produces them.
`proto::read_frame` / `write_frame` do this over any tokio
`AsyncRead` / `AsyncWrite` (iroh's `RecvStream` / `SendStream` qualify).

The server answers a malformed (not-JSON / unknown `t`) frame with a
non-fatal `error` and keeps reading.

## Messages

JSON objects tagged by `"t"` (lowercase), fields camelCase. Unknown fields
must be ignored by both sides; optional fields (`?`) may be absent.

### Handshake

The first client frame must be `pair` or `auth` within 10 s of the stream
opening (and the QUIC handshake itself must finish in 10 s), otherwise the
connection is dropped silently (no fatal `error`, so the phone just retries
and keeps its pairing). At most 4 connections from nodes that are not paired
devices may be in their handshake at once (this includes a new phone waiting
for the desktop user's confirmation); further ones are closed. Paired devices
are not limited by that.

| Direction | Message | Meaning |
|---|---|---|
| C to S | `pair {code, deviceName}` | New device: redeems the one-time code from the QR. |
| C to S | `auth {token}` | Known device. The token must match **and** the connection's node id must be the one that paired. |
| S to C | `paired {token, deviceName}` | Reply to `pair`. Store the token; it is never shown again. Followed by `ready`. |
| S to C | `ready {deviceName, hostName, appVersion?, proto?, caps?}` | Handshake done. `appVersion` is the desktop's app version, `proto` its protocol revision (`proto::PROTOCOL_VERSION`, 2 today; absent = 1) and `caps` the optional features it supports (`proto::CAPABILITIES`: `rename`, `closeTab`, `profiles`, `profileLogin`, `profileAgents`, `newTabProfile`, `background`, `gemini`, `chat`, `agentViews`, `linkPreview`, `compress`, `terminalChat`, `chatRename`, `chatCloseTab`, `chatModel`; `profileLogin` is signing a non-default profile in, `profileAgents` signing out and the default profile's agents, `chat` the desktop's chat tabs (the `chat*` messages, `chats`, `chatevents`), `agentViews` the view plugins (`views`, `viewfile`), `compress` deflated frames after `hello`). A desktop that sends none of them is an old one (0.9 / 0.10): the phone assumes proto 1 and what those releases had (`LEGACY_CAPS`: `profiles`, `profileLogin`, `background`), hides the matching UI and shows a dismissable banner; below its minimum proto (`MIN_DESKTOP_PROTO`) it shows a blocking "update Flowcode" screen. A new feature adds a capability here, in `RemoteCap` and in the phone's `CAP_LABELS`. Followed by `usage` and `actions` with the current values, by `settings` once the desktop has published them, and by an unsolicited `tabs` with the current list (so the phone need not wait for the reply to its `list`; a phone should still send `list` after `ready`, which an older desktop answers and a newer one answers again with the same list). |
| S to C | `error {message, ptyId?, fatal}` | `fatal: true` means the server is closing the connection (bad code, bad token, too many attempts, device revoked). `message` is localized text for the user. |

After a valid `pair` the desktop asks its user to confirm the new phone and
only then creates the device and sends `paired` (up to 60 s; the phone should
wait up to 75 s for `pair`, 15 s for `auth`). Two more fatal errors can come
back: "Pairing declined on the computer" and "Not confirmed on the computer:
try again". The code is spent either way, so the phone must scan a new one;
presenting a spent code again is refused as invalid but does not count
towards the rate limit below.

The desktop shows the request with the device name (control characters
removed, at most 64 characters) and a **fingerprint**: 6 characters derived
from the phone's node id by `proto::node_fingerprint` (first 6 base32
characters of the SHA-256 of the node id). The phone shows the same
fingerprint while it waits, so the user can tell which request is theirs.
If the request is not answered (timeout, phone gone) the desktop withdraws it.

Pairing codes are one-time, valid 5 minutes, one active at a time (closing
the QR dialog on the desktop cancels it); 5 wrong codes in a minute block
all pairing for a minute. Likewise, 5 failed `auth`s from one node id in a
minute make the desktop refuse that node's `auth` for a minute ("too many
attempts", fatal). Only a SHA-256 hash of the
token is stored on the desktop. Re-pairing from the same node id replaces the
earlier device entry.

### After `ready`

Client messages:

| Message | Meaning |
|---|---|
| `list` | Send `tabs` now. |
| `open {ptyId, cols?, rows?}` | Start streaming a terminal: `snapshot`, then `output`. With `cols`/`rows` the pty is resized to the phone's grid while open (see below). Opening again restarts the stream. |
| `resize {ptyId, cols, rows}` | New phone grid for a tab that is open. Ignored if the tab is not open. |
| `close {ptyId}` | Stop streaming; the pty gets its desktop size back. |
| `input {ptyId, data}` | Keystrokes, UTF-8, at most **64 KiB** (`proto::MAX_INPUT_BYTES`), written to the pty in order. |
| `action {id, ptyId?}` | Run a published action (see `actions`) in the tab owning `ptyId`, or in the main window. Unknown ids get an `error`. |
| `rename {ptyId, label}` | Rename the desktop tab owning `ptyId`, like a desktop rename: the label is trimmed (max 128 characters) and a blank one is ignored. An unknown pty gets an `error`. No reply: the next `tabs` shows the new label. |
| `closetab {ptyId}` | Close the desktop tab owning `ptyId`, like closing it on the desktop. The window's last tab stays open (closing it would close the window). An unknown pty gets an `error`. No reply: the next `tabs` no longer lists it. |
| `terminalchat {ptyId}` | Reopen the agent running in the tab owning `ptyId` as a chat tab on the same session (the reverse of `chatterminal`). The desktop starts the chat with a strict `session/load` and closes the terminal only once the session has loaded; if the agent is busy, can't resume or fails to start, the terminal stays. An unknown pty gets an `error`. No reply: the new chat shows in the next `chats`, the terminal leaves the next `tabs`. Needs the `terminalChat` capability. |
| `chatopen {chatId, afterSeq}` | Follow a chat tab: answered with a `chatevents` replay of every event after `afterSeq` (`0` for all), then live `chatevents` batches until `chatclose` or the end of the connection. A reconnecting client asks again from its last `seq`. Needs the `chat` capability, like every `chat*` message. |
| `chatclose {chatId}` | Stop following a chat. |
| `chatprompt {chatId, text}` | Send a message to the chat's agent, as typed in the desktop chat. A prompt sent while the agent is not idle is refused with a non-fatal `error` whose message starts with `agent_busy:` (`agent_exited:` once the agent has exited); nothing is logged for it. That `error` names no chat: a client puts the message back at the front of its queue (when it can tell which chat it was, i.e. one prompt is in flight) and sends it again after the turn ends. |
| `chatcancel {chatId}` | Cancel the running turn. |
| `chatpermission {chatId, requestId, optionId}` | Answer the agent's permission request; `optionId: null` cancels it. |
| `chatmode {chatId, modeId}` | Switch the agent's ACP mode (one of the chat's `modes`). |
| `chatterminal {chatId}` | Hand the chat's session over to a desktop terminal tab (as Ctrl+` does on the desktop). |
| `newchat {cli, cwd?, profile?}` | Open a new desktop chat tab for `cli`, in `cwd` (else the start folder), under `profile` like `newtab`. |
| `chatrename {chatId, label}` | Rename a desktop chat tab, like `rename` (trimmed, max 128 characters, blank ignored). No reply: the next `chats` shows the new label. Needs the `chatRename` capability. |
| `chatclosetab {chatId}` | Close a desktop chat tab, like `closetab` (never the last tab of its window). No reply: the next `chats` no longer lists it. Needs the `chatCloseTab` capability. |
| `chatmodel {chatId, modelId}` | Switch the chat's agent to another of the models it offers (`models` of the chat in `chats`: `{currentModelId, availableModels: [{modelId, name, description?, group?}]}`, normalized by the desktop from ACP's `models` or its `model` config option). Allowed mid-turn: it applies from the next prompt. A model the agent doesn't offer, or an agent that refuses, gets a non-fatal `error`. No reply: followers get an `ext` chat event `_flowcode/model` with the new models, and the next `chats` shows them. Needs the `chatModel` capability. |
| `ls {ptyId, path?}` | List a folder. |
| `read {ptyId, path}` | Read a text file. |
| `linkpreview {url}` | The preview of a web link in a chat, answered with `linkpreview`. Needs the `linkPreview` capability (not in `RemoteCap`: an older desktop just has no previews). |
| `set {key, value}` | Change one mirrored desktop setting (see `settings`). `key` must be non-empty and at most 64 bytes and `value` at most 4 KiB as JSON, else `error`; an unknown key or a value of the wrong type is ignored by the desktop (it is not applied; an unknown palette id falls back to the default palette). |
| `profile {op, ...}` | Manage the account profiles (see `profiles`). `op` is `create` (`name`, `color` as `#rrggbb`, optional `copySettings`, default true), `update` (`id`, `name`, `color`), `delete` (`id`, optional `deleteFiles`, default false) `login` (`id`, `cli`: `claude`, `codex`, `vibe` or `gemini`) or `logout` (`id`, `cli`). For `login` and `logout` an `id` of `""` is the default profile; `update`/`delete` need a real id. Strings are at most 64 bytes (`color`/`cli` 16); a malformed request gets an `error`. Only the desktop's remote leader window acts on it (the same window as `action`); `create`/`update`/`delete` apply the desktop's own rules (non-empty unique name, valid color) and a rejected one is simply not applied, the next `profiles` shows the truth. `login` opens the CLI's sign-in in a **new terminal tab on the desktop** (after checking the CLI is installed; otherwise the desktop offers to install it): the phone can then open that tab from its `tabs` list. `logout` signs the CLI out of the profile right away (no confirm on the desktop; the phone asks first). There is no reply; watch `profiles`. |
| `newtab {cwd?, cli?, profile?}` | Open a new terminal tab on the desktop, in `cwd` (else the shell's start folder), starting the agent `cli` (`claude`, `codex`, `vibe` or `gemini`) in it if given, under the account profile `profile` (`""` = the default one, an unknown id falls back to it; absent = automatic, the folder's project default). A `cwd` that is not an existing folder on the computer, or an unknown `cli`, gets an `error`. There is no reply; the new tab shows in the next `tabs`. |
| `hello {caps}` | Optional, sent once right after `ready` to a desktop that listed the matching capability. `compress`: this phone reads deflated frames, so the desktop may send them. Never sent to an older desktop, which would answer `error` for an unknown message. |
| `ping` | Answered with `pong`. Send one now and then to detect a dead link. |

Server messages:

| Message | Meaning |
|---|---|
| `tabs {tabs}` | The desktop's terminal tabs. Sent right after `ready`, on `list`, and pushed (at most every 2 s, or sooner when a window reports its tabs) whenever they change. |
| `snapshot {ptyId, data, cols, rows}` | The desktop terminal's current screen as escape sequences (scrollback, alternate screen, modes), at the given grid. Write it into a terminal of that size. Its JSON-encoded size is kept under 512 KiB by dropping the oldest lines (a non-fatal `error` says so). A snapshot can also arrive **later in a stream**: if the phone fell behind and output was dropped, the desktop sends a fresh `snapshot` instead of the lost bytes; clear the terminal and write it as for the first one. |
| `output {ptyId, data}` | Live output after the snapshot, as UTF-8 text. |
| `exit {ptyId}` | The program in that pty ended (or the pty vanished). The stream is over. |
| `usage {items}` | Usage readings the desktop shows (Claude Code / Codex limits...). Pushed on `ready` and on change. |
| `actions {actions}` | Quick actions the phone may run. Pushed on `ready` and on change. |
| `settings {settings}` | The desktop settings the phone mirrors, as one JSON object (keys below). Pushed after `ready` once published, and on every change, including ones made on the desktop. |
| `profiles {profiles, defaultLoggedIn?}` | The account profiles besides the default one, as an array of `{id, name, color, loggedIn: {claude, codex, vibe, gemini}}` (booleans, read off the CLIs' files). `defaultLoggedIn` is the default profile's `{claude, codex, vibe, gemini}` in the same form; absent from older desktops (and until the desktop knows it). Pushed after `ready` once published, and on every change, including ones made on the desktop and sign-ins finishing. |
| `ls {ptyId, path, entries}` | Reply to `ls`. |
| `file {ptyId, path, text, truncated}` | Reply to `read`. |
| `chats {chats}` | Every desktop chat tab, as `ChatInfo` (see Types); sent on connect and whenever one changes (status, label, mode, models...). |
| `chatevents {chatId, events, replay}` | Events of a followed chat (see Chat events). `replay: true` is the answer to `chatopen`, even when empty; then live batches. |
| `linkpreview {url, preview}` | Reply to `linkpreview`. `preview` is `{url, finalUrl, title?, description?, siteName?, image?, favicon?}` (the pictures are `data:` URIs, dropped if the frame would pass ~900 KiB), or `null` when the page has nothing to show or the desktop's `linkPreviews` setting is `never`. |
| `pong` | Reply to `ping`. |
| `error {message, ptyId?, fatal}` | A failed request (non-fatal) or the end of the connection (fatal). A message the desktop could not send because it exceeds one frame is dropped and reported with a non-fatal `error` (with its `ptyId` when it had one). |

### Settings

`settings` is one flat-ish object; `set` changes one entry, addressed by the
same key (nested ones with a dot, e.g. `notify.done`). Values are validated by
the desktop and then applied as if changed in its own settings.

| Key | Type | Notes |
|---|---|---|
| `theme` | `"auto"` \| `"light"` \| `"dark"` | Settable. |
| `resolvedTheme` | `"light"` \| `"dark"` | Read-only: what `theme` resolves to. |
| `palette` | string | Palette id, one of `palettes[].id`. Settable. |
| `terminalPalette` | string \| null | Terminal-only palette; `null` follows `palette`. Settable. |
| `contrast`, `glassOpacity` | number, 0-1 | Settable. |
| `language` | `"system"` \| a `languages[].id` | Stored preference. Settable. |
| `resolvedLanguage` | string | Read-only: the language in use. |
| `languages` | `[{id, name}]` | Read-only; `"system"` is implicit. |
| `colors`, `terminalColors` | `{bg, ...}` | Read-only: the resolved app / terminal palette as CSS-variable values. |
| `palettes` | `[{id, name, bg, accent, accent2}]` | Read-only, in the current theme. |
| `terminalFontSize` | number | Settable; clamped by the desktop. |
| `bannerEnabled`, `confirmLinkOpen`, `restoreSession`, `newTabPage` | boolean | Settable. |
| `linkPreviews` | `"always"` \| `"onClick"` \| `"never"` | Read-only: when the desktop fetches link previews for chats. |
| `notify.done`, `notify.input`, `notify.exited`, `notify.limitReset` | boolean | Settable; `notify` is published as an object of the four. |
| `autoResume.enabled` | boolean | Settable; published as `autoResume {enabled, message}`. |
| `autoResume.message` | string, at most 500 chars | Settable. |

### Types

```
Tab        {ptyId, tabId, window, label, cwd, cols, rows,
            cli?: "claude"|"codex"|"vibe"|"gemini", status?: "busy"|"idle"|"waiting",
            context?: {used, window, model?}}
UsageItem  {pluginId, label, profile?, profileName?, profileColor?, metrics: [UsageMetric]}
UsageMetric{kind, label?, percent?, resets?, command?, period?, cost?, tokens?, sessions?}
Action     {id, label, icon?, cli?: "claude"|"codex"|"vibe"|"gemini"}
LsEntry    {name, dir, size?}
ChatInfo   {chatId, tabId, window, label, agent, cwd, profile?, sessionId?,
            status?: "starting"|"idle"|"busy"|"waiting"|"exited",
            modes?: {currentModeId, availableModes}, models?: {currentModelId, availableModels: [{modelId, name, description?, group?}]}}
```

- `ChatInfo.models` is what the agent offers, normalized by the desktop (from
  ACP's `models` or its `model` config option); absent when it offers no
  choice, or from an older desktop. `chatmodel` picks one of them.

- `context` is how full the agent's context window is, in tokens (`used` of
  `window`); only for claude/codex tabs whose transcript can be read, and
  refreshed by the desktop at most every 10 s.
- `UsageItem` is one per (plugin, account profile). `profile` is the profile id
  and is absent for the default profile; `profileName` / `profileColor` (a CSS
  colour) name it for grouping and are likewise absent for the default profile.
- `UsageMetric.kind` is one of `session`, `week`, `other`, `unavailable`,
  `loggedOut`, `reauth`, `spend`, `model`, `noApiKey`, `billing`, `unpriced`;
  ignore kinds you do not know. `percent` is 0-1, `resets` is the CLI's own
  wording. `label` is already worded in the desktop's language. Which of the
  other fields are set depends on `kind` (e.g. `spend` has `period`, `cost`,
  `tokens`, `sessions`).
- `action.id` ids come from the desktop's pinned quick actions (plugin ids).
  The desktop may still ask its user to confirm a command it has not run
  before; the phone cannot bypass that.

### Chat events

`chatevents` carries the desktop's own chat events (`ChatEvent` in
src/chat/chatTypes.ts), each with a `seq` that only grows: `update` (an ACP
`session/update`), `user`, `permission`, `permissionResolved`, `turnEnd`,
`error`, `exit` and `ext` (an extension notification `{method, params}`).
The desktop's log merges runs of text chunks into one event carrying the last
chunk's `seq`, so a replay is authoritative up to its last `seq`. Kinds and
`ext` methods a client does not know must be skipped. The desktop's own ext
events:

- `_flowcode/model`: the chat's models changed (a `chatmodel`, or the agent
  pushed new config options). `params` is the normalized
  `{currentModelId, availableModels}` (as `ChatInfo.models`), or
  `{currentModelId: null, availableModels: []}` when the agent no longer
  offers a choice.
- `_session/retrying`: the agent retries a failed request (`params`:
  `{category, detail}`); stale once the turn ended.

### Phone-sized terminals

`open` / `resize` with `cols` / `rows` resize the pty to the phone's grid
while the phone has the tab open, so full-screen programs lay out for the
phone. The desktop's own terminal is pinned to that grid and shows a banner.
If several phones size the same tab, the most recent one wins; when a phone
sends `close` or disconnects, the previous phone's size is restored, or the
desktop terminal refits and resizes the pty back. The `snapshot` carries the
grid actually in effect, which the phone should adopt.

### Files

`ls` and `read` are confined to the tab's working directory (`Tab.cwd`):

- `path` is relative to that folder (`""` / absent = the folder itself) or an
  absolute path inside it; `..` is refused outright and symlinks are resolved,
  so a link pointing out of the folder is refused too.
- Replies echo `path` relative to the folder, `/`-separated.
- `ls`: dirs first, then names case-insensitive; hidden files are included;
  at most 5000 entries.
- `read`: text only. A file with a NUL byte in its first 8 KiB is refused
  (`error`). Content is cut at 1 MiB and then further if its JSON-escaped form
  would not fit one frame; `truncated` says so. Invalid UTF-8 is replaced.

## Desktop as a client

A desktop can also be the client of another desktop ("Connect another PC"):
it pairs exactly like a phone (same ticket, same `pair` / `auth` handshake,
the other PC's user confirms it) and then speaks the same protocol, following
terminals and chats with the same messages. The client side lives in
src-tauri/src/remote_client and reuses the phone's link code through
`#[path]` modules: mobile/src-tauri/src/{link,store,backoff,connlog}.rs. The
desktop answers it like any phone: a paired desktop shows in its devices
list and can be revoked the same way.

## Pairing ticket (the QR code)

The QR encodes a URL string:

```
flowcode://pair?t=<base64url-no-padding( JSON {"node": "...", "code": "...", "host": "..."} )>
```

- `node`: the desktop's `iroh_tickets::endpoint::EndpointTicket` string
  (`EndpointTicket::new(endpoint.addr()).to_string()`): its node id plus relay
  URL and direct addresses. Parse with `EndpointTicket::from_str` and dial
  `ticket.endpoint_addr()`.
- `code`: the one-time pairing code to send in `pair`.
- `host`: the desktop's name, to show before connecting.

`proto::PairingTicket::{encode, parse}` implement this; `parse` trims
whitespace and rejects anything not starting with `flowcode://pair?t=`.

## Connecting (phone side, sketch)

```rust
let endpoint = Endpoint::builder(presets::N0).secret_key(phone_key).bind().await?;
let conn = endpoint.connect(ticket.endpoint_addr().clone(), proto::ALPN).await?;
let (mut send, mut recv) = conn.open_bi().await?;
write_frame(&mut send, &ClientMsg::Pair { code, device_name }).await?;   // first time
write_frame(&mut send, &ClientMsg::Auth { token }).await?;               // afterwards
let msg: ServerMsg = read_frame(&mut recv).await?;
```

Later connections can dial the stored node id alone (iroh looks the address
up), but keeping the ticket's `node` string is more robust offline.

## Security notes

- Off by default on the desktop; a paired device can type into the user's
  terminals, so the settings page says so.
- A stolen token is useless without the phone's node secret key, and a
  connection from another node id presenting a valid token is refused with the
  same message as a wrong token.
- Revoking a device on the desktop drops its connections at once, after a
  fatal `error` ("Device revoked"); a revoked device that connects gets the
  same fatal `error`.
- Latency: the desktop sends one `output` frame per terminal at most every
  8 ms (a quiet terminal's first chunk goes out at once, a burst is folded into
  few larger frames), and writes `viewfile` / `linkpreview` replies only when
  no other frame is waiting, so keystroke echoes never sit behind a download.
  A `snapshot` is capped at 256 KiB of JSON (oldest lines dropped first).
- Queues are bounded. Terminal output for a phone that is not keeping up is
  dropped and replaced by a fresh `snapshot` once it catches up; a phone that
  stops reading altogether, or floods the desktop with frames or input faster
  than they can be handled, is disconnected. Per connection: 64 open terminals,
  1024 queued outgoing frames, 256 queued incoming frames, 64 queued `input`
  messages per terminal.
