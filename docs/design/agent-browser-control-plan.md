# Agent browser control — plan (phases 1 + 2)

Design: variant **A** of `docs/design/agent-browser-control-variants.html` (amber ring around the page + bottom bar with agent, last action, Interrompi; paused state Restituisci / Togli all'agente; ✦ badge on the tabs counter; owner label in the tabs popover; "Fai controllare all'agente ▸" in the ⋯ menu; consent card in chat/tab; settings section).

User decisions (2026-11-22): scope = only tabs the agent opened or the user handed over; `browser_eval` default local only (localhost + local files), extendable in settings; consent per session; passwords never read; Windows first (WebView2 CDP); macOS/Linux best effort; phone out of scope.

## Architecture

Policy lives in the **frontend** (settings, session grants, page ownership, consent UI are all there); the **backend** executes on the native child webview (`fcb-*`, see `browser_view.rs`) and talks MCP.

```
agent ──MCP──► flowcode-mcp.cjs ──req file──► chat_mcp::dispatch ──► browser_control::call
                                                                    │ 1. bridge "resolve" ─► frontend (policy, consent card) ─► {label, pageId, url}
                                                                    │ 2. CDP / JS on webview `label`
                                                                    │ 3. emit browser-control-activity
                                                                    ◄─ text (+ image) result
```

### Owner
`owner` = `{ "kind": "chat", "id": <chatId> }` or `{ "kind": "terminal", "id": <ptyId> }` plus `agent` (cli name, e.g. "claude") when known. Built in Rust from the MCP caller (`Owner::Chat` / `Owner::Terminal`).

### Bridge (Rust → frontend → Rust)
- Rust emits event **`browser-control-request`** to every main window (`main`, `win-*`) with payload `{ reqId, kind, owner, ... }`.
- The window that knows the owner (has that chat / that pty tab) answers with command **`browser_control_reply(reqId: String, ok: bool, value: Value)`**; others ignore. Rust waits on a oneshot with a timeout (consent: 120 s; other: 5 s) and answers the tool with an error on timeout.
- Kinds:
  - `resolve` `{ owner, tool, page?: string, url?: string, action: "read" | "interact" | "eval" | "open", newTab?: bool }` → frontend checks settings + grants + ownership, shows the consent card when needed (awaits the user), creates/navigates a page for `open`, then answers `{ pageId, label, url }` or `ok:false, value: "<reason the model can act on>"`.
  - Page selection when `page` is omitted: the owner's most recently used controlled page; none → error "no browser tab: call browser_navigate with a url first".
- Frontend → Rust command **`browser_control_label(window, pageId) -> String`** if the frontend needs it (or reuse browser_view's label fn).

### Activity / state (Rust → frontend)
- Event **`browser-control-activity`** `{ pageId, window, owner, agent, tool, summary, ref?, at }` after each tool → bottom bar "last action".
- Event **`browser-control-user`** `{ pageId, window }` when the page saw real user input while controlled (see Pause).

### Frontend → Rust
- **`browser_control_release(pageId)`** when the user clicks Interrompi / Togli all'agente (Rust forgets the page's console buffer and stops its user-input watch).
- **`browser_control_watch(window, pageId, on: bool)`** start/stop the pause watch for a controlled page.

## Tools (MCP, flowcode-mcp.cjs + Rust)
All take optional `page` (id from `browser_tabs`). Element refs `e1…eN` come from the latest `browser_snapshot` of that page.

| tool | action | notes |
|---|---|---|
| `browser_tabs` | read | the owner's controlled pages: id, title, url, active |
| `browser_navigate` | open | `{ url? , action?: back\|forward\|reload, newTab? }`; url opens in a new owned tab when the owner has none or `newTab` |
| `browser_snapshot` | read | compact text tree: role, name, text, value (never password values → `[password]`), state, ref; page content wrapped as untrusted |
| `browser_screenshot` | read | PNG image content (optionally of `ref`); Windows CDP `Page.captureScreenshot` |
| `browser_click` | interact | `{ ref, double?, button? }` |
| `browser_type` | interact | `{ ref, text, submit?, clear? }`; refused on password fields → "ask the user (call_user)" |
| `browser_press` | interact | `{ key }` (Enter, Tab, Escape, ArrowDown, Ctrl+A …) |
| `browser_select` | interact | `{ ref, values[] }` |
| `browser_scroll` | interact | `{ ref? , dx?, dy? }` |
| `browser_hover` | interact | `{ ref }` |
| `browser_wait_for` | read | `{ text? , ref?, gone?, timeout_ms ≤ 15000 }` |
| `browser_console` | read | recent console messages / errors (bounded buffer, ≤ 200 per page), `{ clear? }` |
| `browser_eval` | eval | `{ js }` → JSON result (truncated 20 kB) |

Response protocol extension: response file may carry `"image": { "data": <base64>, "mimeType": "image/png" }`; cjs returns MCP content `[{type:"image",...},{type:"text",...}]`. Everything else stays text.

Enablement: a new tool group `browser` next to `open_in_browser` in `chat_mcp::enabled_tools` / terminal tool lists, included when the frontend setting `control != "off"` is passed down the same way open_in_browser's flags are (find how tools config reaches chats/tabs). Claude auto-allow: browser tools added to the auto-allow list (Flowcode's consent card is the gate).

## Backend execution (Rust `browser_control.rs`)
- **Windows:** `ICoreWebView2::CallDevToolsProtocolMethod` (webview2-com already a dependency) via `with_webview` on the child label: `Runtime.evaluate` (returnByValue, awaitPromise) for the snapshot/actions script, `Page.captureScreenshot`, `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText` for trusted input at element centres (rect from the script). Console via `Runtime.enable` + `add_DevToolsProtocolEventReceived("Runtime.consoleAPICalled")` and `Runtime.exceptionThrown`, buffered per label.
- **macOS / Linux:** `evaluateJavaScript` / `webkit_web_view_evaluate_javascript` through `with_webview` if reachable with existing deps; synthetic JS events; console via the injected script's own buffer; screenshot unsupported → clear error. Must compile (`cfg`), may be untested.
- Injected script (`src-tauri/src/browser-control.js`, `include_str!`): builds the snapshot (stable refs via `data-fc-ref`, visible elements only, roles from tag/aria), resolves refs to rects, does JS fallback actions, highlight overlay (pointer-events:none, auto-removed 1.5 s, only when setting on — pass a flag), user-input watch (capture listeners on pointerdown/keydown with `isTrusted`, ignored while `window.__fcAgentActing` is set around agent actions; exposes `__fcUserAt`).
- Pause: while a page is watched, Rust polls `__fcUserAt` every ~700 ms; when it moves, emit `browser-control-user`; frontend marks the page paused; while paused `resolve` answers `ok:false "the user is using this tab; wait and try again later"` for interact/eval.
- Every element-based action verifies the ref still exists; stale → "element e7 is gone: take a new browser_snapshot".

## Frontend
- `browserStore`: page gains `control?: { owner, agent, paused, lastAction? }`. Agent-opened pages (`_flowcode/open` from a chat/tab) record the owner as *opener*; only pages with `control` set are visible to the agent. A page opened by the agent through `open_in_browser` becomes controllable by that owner (it opened it).
- Policy in the `resolve` handler: setting `control` (off / ask / local) → `off` refuse; `local` auto-allow localhost+files, ask otherwise; `ask` card once per owner session. `action:"interact"` on non-local: setting `externalInteract` (no / ask / yes). `action:"eval"`: setting `eval` (never / local / ask / always; default local). Grants per owner, in memory, cleared when the chat/tab ends.
- Consent card (new component, style of the delegate card): in the chat timeline for chat owners, in the terminal tab card area for terminal owners (see how the delegate card in tabs is shown). Buttons: Consenti per questa sessione / Solo lettura / Nega; eval card: Esegui una volta / Sempre su questo sito / Nega.
- Indicator (variant A): amber ring around the native view (shrink the native rect by 2 px, draw the ring in DOM) + bottom bar (counts in `insetBottom` like the downloads bar) with agent avatar, "<Agent> sta usando questa scheda", last action, Interrompi; paused: green bar "In pausa: stai usando tu la pagina" + Togli all'agente / Restituisci.
- ✦ badge on the tabs counter when any page is controlled; owner label in the tabs popover rows.
- ⋯ menu: "Fai controllare all'agente ▸" submenu listing live chats and agent terminal tabs of this window; picking one sets `control` (no consent card needed: the user chose it).
- Settings → Browser: "Controllo da parte degli agenti": Permesso (Disattivato / Chiedi / Consenti su localhost; default Chiedi), browser_eval (Mai / Solo locale / Chiedi sugli altri siti / Ovunque; default Solo locale), Interazione sui siti non locali (No / Chiedi / Sì; default Chiedi), Pausa quando tocco la pagina (on), Evidenzia le azioni (on).
- i18n it + en.

## Out of scope now (phase 3)
Network log, alert/confirm handling, file upload, mobile viewport, artifact/preview iframe pages, phone.

## Backend notes (implemented in `src-tauri/src/browser_control.rs`)

Contract kept as written; these are the details the frontend must match.

- **Enable flag**: `ToolsConfig` (the `tools` object of `chat_start` and of terminal tabs, same place as `open` / `openAutoAllow`) has a new field **`browserControl: boolean`**. Set it `true` when the browser setting `control != "off"` (and `tools.enabled`). It gives the 13 `browser_*` tools to depth-0 chats and terminal tabs (not to delegated children). Claude auto-allow includes them (chats and terminal tabs).
- **`browser-control-request`** payload: `{ reqId, kind: "resolve", owner: { kind: "chat"|"terminal", id }, agent: string|null, tool, page: string|null, url: string|null, action: "read"|"interact"|"eval"|"open", newTab: boolean, nav: "back"|"forward"|"reload"|null }`. Sent to every window labelled `main` or `win-*`; only the owning window answers.
  - `action` per tool: read = tabs, snapshot, screenshot, wait_for, console; interact = click, type, press, select, scroll, hover, **and navigate with `action: back|forward|reload`** (`nav` set, `url` null); eval = eval; open = navigate with a `url` (`url` and `newTab` set).
  - `browser_tabs` is also a `resolve` with `tool: "browser_tabs"`, `action: "read"`: answer `ok:true`, `value: { pages: [{ id, title, url, active }] }` (a plain string is passed through verbatim). It must not require an existing page. Refuse with `ok:false, value:"<reason>"`.
  - Every other tool: answer `ok:true`, `value: { pageId, url, label?, highlight?: boolean }`. Rust re-derives the webview label from (replying window, `pageId`) with `browser_view::find_label`; `label` is only a fallback and must start with `fcb-`. `highlight` defaults to true (set `false` when the "Evidenzia le azioni" setting is off). For `open`, answer only after the page exists and the navigation was started; Rust then waits up to ~12 s for load.
  - Frontend errors for `read`/`interact`/`eval` while paused: `ok:false, value:"the user is using this tab; wait and try again later"`.
  - Rust waits 120 s for `resolve` (a consent card may be open). The "5 s for other kinds" of the plan is unused: there are no other kinds.
- **`browser_control_reply(reqId, ok, value)`**: the replying window is taken from the invoking window (no `window` argument needed). Returns a boolean (whether a call was still waiting).
- **`browser_control_release(pageId)`**: also takes the invoking window implicitly (injected `tauri::Window`); frontend passes only `pageId`.
- **`browser_control_watch(window: string, pageId, on)`**: as planned (explicit `window` label). Polls every ~700 ms (Windows only; other platforms: no-op, never emits). Rust emits `browser-control-user { pageId, window }` whenever `__fcUserAt` advances; the frontend decides about pausing and calls `watch(on:false)` when done. The page script installs the capture listeners when first injected, i.e. at the first tool call on the page's current document (a later navigation drops them until the next call or the next poll, which re-injects).
- **`browser-control-activity`** payload as planned: `{ pageId, window, owner, agent, tool, summary, ref, at }`; `summary` is English text (`Clicked button "Save"`, `Opened https://...`, `Pressed Enter`): the frontend may prefer to localize from `tool` + `ref`. Not emitted for `browser_tabs` or failed calls.
- **Image protocol**: response file `{ ok, text, image?: { data, mimeType } }`; `flowcode-mcp.cjs` returns `[image, text]` content. Screenshots are PNG, JPEG (q70) when the PNG exceeds ~5 MB of base64.
- **Dispatch**: `chat_mcp::dispatch` routes `browser_*` to `chat::delegate::browser_call` / `terminal_mcp::browser_call` (liveness + tool-given checks), which call `browser_control::call(app, owner, agent, tool, args, deadline)`. The dispatch result type is now `ToolOutput { text, image }`.
- **Platforms**: Windows = everything (CDP via WebView2). macOS/Linux = only `browser_tabs` and `browser_navigate` (no way to read a script result from a child webview with the current dependencies: Linux would need `javascriptcore` as a direct dependency); the other tools return "not supported on this platform yet" *before* asking the frontend (no consent card). 
- Password safety: snapshot shows `[password]`; `browser_type` on a password field and `browser_press` of a character key while a password field is focused are refused with a message pointing at `call_user`. `browser_eval` is not masked (frontend policy gates it).
- Console buffering starts at the first tool call on a page (`Runtime.enable`), up to 200 lines per page; `browser_control_release` clears it.
