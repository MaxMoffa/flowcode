# Phone browser shares the desktop's tabs — contract

Artifact: `docs/design/mobile-browser-tabs-variants.html` (variant A chosen for the handle; already done in
`mobile/src/browser.css` + `mobile/src/browserDrag.ts`).

Decisions:
- The desktop **leader window**'s `src/browser/browserStore.ts` owns the tab list. The phone mirrors it and asks for changes.
- The page on screen is **per device**: the phone choosing a tab never changes the desktop's `activeId`, and a page the
  phone opens never opens/raises the desktop's browser panel nor changes its `activeId`.
- A link the phone opens (chat link, typed address, agent opener) becomes a **shared** tab.
- Tablet (docked browser) uses the same tabs. Old desktop without `browserTabs`: phone behaves exactly as today.

## Capability

`"browserTabs"` — add to `CAPABILITIES` in `src-tauri/remote-proto/src/lib.rs` and to `RemoteCap` in `shared/remote-types.ts`.

## Desktop → phone: `ServerMsg::BrowserTabs`

Wire: `{"t":"browsertabs","tabs":<BrowserTabsSnapshot>}` (free-form JSON on the Rust side, `serde_json::Value`, like
`ServerMsg::Settings`). The frontend publishes it with `invoke("remote_publish_browser_tabs", { tabs })` (leader window only,
coalesced ~150 ms). Rust keeps it in a `watch::Sender<serde_json::Value>` (initial `Null`); each connection sends it after the
handshake when not null, and again on every change (same as `settings` in `src-tauri/src/remote/conn.rs`).

```ts
// shared/remote-types.ts
export interface BrowserTabsSnapshot {
  pages: BrowserTabPage[];
  /** The page the desktop shows (the phone marks it "PC"). */
  activeId: string | null;
  /** Dev servers detected in desktop terminals. */
  servers: { url: string; port: number; alive: boolean }[];
  /** The last open the phone asked for, so it can select the tab it gets. */
  opened: { nonce: string; pageId: string } | null;
}
export type BrowserTabPage =
  | { id: string; kind: "url"; url: string; canBack: boolean; canForward: boolean }
  | { id: string; kind: "file"; path: string } // absolute desktop path
  | { id: string; kind: "pdf"; src: string }; // http(s) URL or absolute desktop path
```

## Phone → desktop: `ClientMsg::BrowserOp`

Wire: `{"t":"browserop","op":{...}}`, `BrowserOp` tagged by `"op"`, camelCase:

| op | fields | Rust checks | emitted payload (`remote://browser-op`, `app.emit` to all windows; only the leader acts) |
|---|---|---|---|
| `openUrl` | `url`, `nonce` | http/https only, ≤ 4096 chars, nonce ≤ 64 | `{op:"openUrl", url, nonce}` |
| `openFile` | `root` = `{"chatId":..}` or `{"ptyId":..}`, `path` (relative), `nonce` | root must exist (chat → its cwd, pty → its tab cwd); path relative, no `..`, not absolute, `\` → `/`; joined to the cwd | `{op:"openFile", path:<absolute>, nonce}` |
| `close` | `id` | id ≤ 64 | `{op:"close", id}` |
| `back` / `forward` | `id` | | `{op:"back"\|"forward", id}` |
| `navigate` | `id`, `url` | as openUrl | `{op:"navigate", id, url}` |

Errors are reported with the existing `self.error(...)` pattern in dispatch.rs.

## Preview stream for desktop file pages

New `PreviewTarget::BrowserPage(String)` (page id), header line `browserpage <pageId>\n`, requires `browserTabs`.
Desktop (`src-tauri/src/remote/preview.rs`): look the page up in the published snapshot; root = parent directory of the
page's `path` (`kind:"file"`) or of `src` (`kind:"pdf"` with a non-http src); unknown id / http pdf → 404. Served by the same
confined file server as `ChatFiles`.
Phone (`mobile/src-tauri/src/preview.rs`): URL prefix `/b/<pageId>/<rest>` → `PreviewTarget::BrowserPage(pageId)`, like `/c/`.

## Phone page kinds (`mobile/src/browserUrl.ts`)

Add `{ kind: "deskFile"; pageId: string; name: string }` → `pageSrc` = `pluginFileUrl(base("b"), pageId + "/" + name)`,
where `name` is the file name of the desktop path. Desktop page → phone page:
- `url` with a loopback host and port → existing `port` page (`localLinkPage`).
- `file` → `deskFile`.
- `url` external, or `pdf` → no iframe: a placeholder in the body (external: "Apri nel browser del telefono" via
  `@tauri-apps/plugin-opener` `openUrl`; pdf: "Il PDF si apre solo sul PC").
