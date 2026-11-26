# PC→PC review — 2026-11-26

Desktop client (src/remoteHosts, src-tauri/src/remote_client) ↔ desktop host (src-tauri/src/remote).
Four parallel reviewers; items marked ✔ were re-checked by hand in the code. Nothing was run on two PCs.

## A — High / visible to the user

| ID | Issue | Where | Fix |
|----|-------|-------|-----|
| A1 ✔ | Host shutdown/restart during the handshake answers "Device revoked" with `fatal` → the client stops retrying for good | `remote/accept.rs:186`, `remote_client/host.rs:146-151,184-188` | Separate shutdown from revoked (non-fatal close); client retries |
| A2 ✔ | Client size claims are phone-designed: a big PC client forces its grid onto the host's own xterm (overflow), and a second client resizes the pty under the first, which never gets told | `remote/sizes.rs:9-33,95-103`, `Terminal.tsx:357-366`, `RemoteTerminalView.tsx` ignores `Snapshot.cols/rows` | Cap claims to the host window grid or let desktop clients not claim; push a size/snapshot to the other subscribers |
| A3 ✔ | `remote_hosts` returns `[]` on any hosts.json read error → TS drops every host, jumps to local, deletes `bus` sets so mounted views go deaf | `remote_client/mod.rs:549`, `remoteHosts.ts:110-121` | Return `Result`; ignore failed refresh; delete bus only on forget |
| A4 | Tunnel URLs die after link loss or 10 min idle; mirrored browser pages keep the dead `localhost:<port>` (mirrorKey ignores the port) | `remote_client/tunnel.rs:37,48-73`, `browserStore.ts:411`, `remoteBrowserMirror.ts:47-66` | Stable port per (host,target) or re-resolve on reconnect; key includes the local URL |
| A5 | Failed `chatopen` (Too many open chats / Chat not found / busy) → view stuck on "starting" forever, error has no chat id | `useRemoteChat.ts:134`, `conn.rs:355-358`, `dispatch.rs:194-201` | Error carries `chatId` (or empty replay + marker); client retry/backoff + retry button |
| A6 ✔ | Font size change refits the remote terminal without sending `resize` → remote pty keeps the old grid | `RemoteTerminalView.tsx:270-275` | Use `refit()` / send resize when cols/rows change |
| A7 | Opening a pty while its owner window is in transit → empty snapshot, no resync → blank until output | `remote/stream.rs:84,118-122` | `owner == None` with live pty = unanswered (retry) |

## B — Medium

| ID | Issue | Where | Fix |
|----|-------|-------|-----|
| B1 ✔ | UNC paths in `//` form (WSL roots from the host explorer) become `/wsl.localhost/...` | `remoteFiles.ts:22` | Detect leading `//x` as UNC |
| B2 ✔ | History resume drops `wslDistro` → WSL session restarts natively on Windows | `RemoteHistoryPanel.tsx:114` | Send `row.wslDistro` |
| B3 | `/clear`: `seenSession` stores `undefined` → reset skipped if sessionId passes through undefined; chat may also vanish from `chats` for a moment → active tab jumps | `useRemoteChat.ts:110`, `remote/tabs.rs:62-69`, `remoteHosts.ts:143` | Store only defined keys; host keeps old session id until the tab updates / grace on disappear |
| B4 | Multi-window: one window's `chatopen` replaces the host stream and its replay (`paged`, `hasMore`) reaches all windows → pagination state lost | `remote_client/mod.rs:317-322`, `conn.rs:359-373` | Refcount chatopen per chat in Rust; replay to requester |
| B5 | `chatolder` dropped silently (not subscribed / slot busy / error); slot global per chat id (phone blocks PC) → `older.loading` sticks | `dispatch.rs:6,206-210`, `chat.rs:233` | Always reply (empty fallback); key slot by (conn, chat) |
| B6 | Lag resync sent as `replay:true` → call_user / agent-open in the lagged window lost | `chat.rs:259,283-286`, `useRemoteChat.ts:174` | Send delta as `replay:false` |
| B7 | Online published before `out`/`quic` installed; re-pair swaps links without status leaving online → views stop updating | `remote_client/host.rs:173-207`, `mod.rs:637` | Install first, then Online; add `link` epoch to HostInfo, use in TS deps |
| B8 | Forget host: `stop_host` before `modify_hosts` → concurrent connect revives link; token stays valid on host (no unpair msg) | `remote_client/mod.rs:677-683` | Remove pairing first; optional `unpair` ClientMsg |
| B9 | Address bar of mirrored page sends tunnel URL back to host on edit | `BrowserPanel.tsx:595,612`, `remoteBrowserMirror.ts:34` | Reverse-map tunnel port → host port |
| B10 | https loopback forced to http through the tunnel | `remoteTunnel.ts:25` | Keep scheme |
| B11 | Prompt receipt id uses client clock vs host clock (±5/15 min) → skewed PC can never send | `prompts.rs:24-27` | Host-side first-seen time / wider tolerance |
| B12 | Host notices (permission asked / done) never shown on a PC client; host toast/pair dialog say "Phone" | `remoteHosts.ts` (no notify handler), `conn.rs:15` | Notify handler on client; device-neutral wording |
| B13 | Queue pump retries in a tight loop when send keeps failing | `useRemoteChat.ts:102-103,201` | Backoff timer |
| B14 | Offline mid-turn: chat stays busy, Stop/permission answers silently dropped | `RemoteChatView.tsx`, `useRemoteChat.ts` | Offline state + feedback like local |

## C — Low

- C1 Terminal steals focus on every reconnect (`RemoteTerminalView.tsx:254-268`).
- C2 Paste > 64 KiB refused by host, not chunked (`dispatch.rs:116`, `RemoteTerminalView.tsx:199`).
- C3 `hostRequest` waits full 30 s when link drops (`hostRequest.ts:32`).
- C4 Closed tabs stay in `visited`, eat the 6-chat cap (`RemoteWorkspace.tsx:20-24`).
- C5 Reconnect re-opens chats closed meanwhile → "Chat not found" toasts (`useRemoteChat.ts:128-136`).
- C6 Late `state` event re-adds a forgotten host (`remoteHosts.ts:154-159`).
- C7 Pair dialog cancel race / just-paired host dropped by stale list (`PairHostDialog.tsx:101-103`, `remoteHosts.ts:115`).
- C8 Remote explorer never refreshes (`RemoteExplorer.tsx:37-47`).
- C9 Link resolver caches misses/errors 20 s (`remoteFiles.ts:52-67`).
- C10 Diff viewer shows wrong diff on failed/truncated read (`remoteGit.ts:25`).
- C11 Upload reads whole file before size check (`tunnel.rs:130-133`).
- C12 No `proto` minimum check; client doesn't advertise caps beyond `compress` (no ProviderAuthRequired) (`host.rs:232-235`).
- C13 Undecodable frames logged once per link only (`host.rs:40-46`).
- C14 DPAPI unseal error always = Lost → may wipe tokens (PLAUSIBLE, `mod.rs:62-67`, `store.rs`).
- C15 Endpoint rebuild ignores Connecting hosts (PLAUSIBLE, `host.rs:104`, `mod.rs:448-455`).
- C16 Possible lock order conns ↔ window map (PLAUSIBLE, `mod.rs:695-701`).
- C17 Security consistency: `run_git`/history skip `is_local_path` (UNC); tunnel listeners unauthenticated on 127.0.0.1.
- C18 WSL tab cwd as `/home/...` on Windows host fails `is_absolute` in explorer/git (PLAUSIBLE, `explorer.rs:22`).

## Parity gaps (not bugs)

Explorer: no git decorations, search, context menu, refresh. File viewer: plain text, no highlight/markdown/image/PDF. Links in terminal tabs always open text viewer. New tab dialog: bare folder list (no recent/search/profile). Git: no fetch/pull/push/hunks.
