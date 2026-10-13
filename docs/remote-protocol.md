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
- Liveness: iroh sends QUIC keep-alives every 5 s, and the desktop's idle
  timeout is 90 s (the effective one is the smaller of the two peers'). The
  phone should still `ping` every ~20 s and treat 60 s of silence as a dead
  link.

## Framing

Each message is a **frame**: `u32` big-endian length, then that many bytes of
UTF-8 JSON. The maximum frame is **1 MiB** (`proto::MAX_FRAME`); a larger
length is a protocol error and the reader gives up on the stream.
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
| S to C | `ready {deviceName, hostName}` | Handshake done. Followed by `usage` and `actions` with the current values, and by `settings` once the desktop has published them. |
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
| `ls {ptyId, path?}` | List a folder. |
| `read {ptyId, path}` | Read a text file. |
| `set {key, value}` | Change one mirrored desktop setting (see `settings`). `key` must be non-empty and at most 64 bytes and `value` at most 4 KiB as JSON, else `error`; an unknown key or a value of the wrong type is ignored by the desktop (it is not applied; an unknown palette id falls back to the default palette). |
| `profile {op, ...}` | Manage the account profiles (see `profiles`). `op` is `create` (`name`, `color` as `#rrggbb`, optional `copySettings`, default true), `update` (`id`, `name`, `color`), `delete` (`id`, optional `deleteFiles`, default false) or `login` (`id`, `cli`: `claude`, `codex` or `vibe`). Strings are at most 64 bytes (`color`/`cli` 16); a malformed request gets an `error`. Only the desktop's remote leader window acts on it (the same window as `action`); `create`/`update`/`delete` apply the desktop's own rules (non-empty unique name, valid color) and a rejected one is simply not applied, the next `profiles` shows the truth. `login` opens the CLI's sign-in in a **new terminal tab on the desktop** (after checking the CLI is installed; otherwise the desktop offers to install it): the phone can then open that tab from its `tabs` list. There is no reply; watch `profiles`. |
| `ping` | Answered with `pong`. Send one now and then to detect a dead link. |

Server messages:

| Message | Meaning |
|---|---|
| `tabs {tabs}` | The desktop's terminal tabs. Sent on `list` and pushed (at most every 2 s) whenever they change. |
| `snapshot {ptyId, data, cols, rows}` | The desktop terminal's current screen as escape sequences (scrollback, alternate screen, modes), at the given grid. Write it into a terminal of that size. Its JSON-encoded size is kept under 512 KiB by dropping the oldest lines (a non-fatal `error` says so). A snapshot can also arrive **later in a stream**: if the phone fell behind and output was dropped, the desktop sends a fresh `snapshot` instead of the lost bytes; clear the terminal and write it as for the first one. |
| `output {ptyId, data}` | Live output after the snapshot, as UTF-8 text. |
| `exit {ptyId}` | The program in that pty ended (or the pty vanished). The stream is over. |
| `usage {items}` | Usage readings the desktop shows (Claude Code / Codex limits...). Pushed on `ready` and on change. |
| `actions {actions}` | Quick actions the phone may run. Pushed on `ready` and on change. |
| `settings {settings}` | The desktop settings the phone mirrors, as one JSON object (keys below). Pushed after `ready` once published, and on every change, including ones made on the desktop. |
| `profiles {profiles}` | The account profiles besides the default one, as an array of `{id, name, color, loggedIn: {claude, codex, vibe}}` (booleans, read off the CLIs' files). Pushed after `ready` once published, and on every change, including ones made on the desktop and sign-ins finishing. |
| `ls {ptyId, path, entries}` | Reply to `ls`. |
| `file {ptyId, path, text, truncated}` | Reply to `read`. |
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
| `notify.done`, `notify.input`, `notify.exited`, `notify.limitReset` | boolean | Settable; `notify` is published as an object of the four. |
| `autoResume.enabled` | boolean | Settable; published as `autoResume {enabled, message}`. |
| `autoResume.message` | string, at most 500 chars | Settable. |

### Types

```
Tab        {ptyId, tabId, window, label, cwd, cols, rows,
            cli?: "claude"|"codex"|"vibe", status?: "busy"|"idle"|"waiting",
            context?: {used, window, model?}}
UsageItem  {pluginId, label, profile?, profileName?, profileColor?, metrics: [UsageMetric]}
UsageMetric{kind, label?, percent?, resets?, command?, period?, cost?, tokens?, sessions?}
Action     {id, label, icon?}
LsEntry    {name, dir, size?}
```

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
- Queues are bounded. Terminal output for a phone that is not keeping up is
  dropped and replaced by a fresh `snapshot` once it catches up; a phone that
  stops reading altogether, or floods the desktop with frames or input faster
  than they can be handled, is disconnected. Per connection: 64 open terminals,
  1024 queued outgoing frames, 256 queued incoming frames, 64 queued `input`
  messages per terminal.
