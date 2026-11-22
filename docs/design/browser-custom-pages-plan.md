# In-app browser: custom error / empty pages — implementation plan

Design: `docs/design/browser-custom-pages-variants.html`, style **"D finale"** (variant id `F` in the
script): A-style minimal layout, one SVG doodle per page (the `ART` object, vector, NOT the 8-bit `PIX`),
a plain "Dettagli tecnici" text button (no chevron) that opens a **dialog**, and inside the dialog footer
`Copia` · `✦ Chiedi a un agente` · `Chiudi`. The agent button opens a small menu (agents + prompt preview);
picking one opens a chat tab with the prompt already sent, and a toast in the browser panel says
"<Agent> sta diagnosticando <host>" with an "Apri chat" button. No agent button on the new-tab page.

Scope: native url pages (`kind: "url"`, child webview, `src-tauri/src/browser_view.rs`). Windows and
Linux detect errors; macOS gets nothing new in phase 1 (WKWebView's delegate belongs to wry) but the
new-tab page and the blocked page work everywhere. HTTP 4xx/5xx pages are NOT replaced.

## Contract between Rust and the frontend

Event `browser-view-error`, emitted to the owning window like the other `browser-view-*` events:

```ts
interface NativeError {
  pageId: string;
  kind: "refused" | "dns" | "offline" | "timeout" | "cert" | "blocked" | "crash" | "other";
  /** Raw engine code, for the details dialog: e.g. "CONNECTION_REFUSED", "HOST_NAME_NOT_RESOLVED",
   *  "CERTIFICATE_IS_INVALID", "RENDER_PROCESS_EXITED", "BLOCKED_LOCAL_ORIGIN", GLib error text on Linux. */
  code: string;
  url: string;
}
```

Command `browser_probe_local(url: String) -> Result<bool, String>`: true when a TCP connect to the
url's host:port succeeds within 700 ms. **Only loopback hosts** (`localhost`, `127.0.0.0/8`, `::1`);
anything else returns `Err` (no port scanning of other hosts). Used every 2 s by the "server down" page
to reload by itself when the dev server comes back.

Timing: the existing `browser-view-load` `finished` can arrive *before* `browser-view-error` for the same
navigation (both hang off the same engine event, wry's handler is registered first). Frontend rule:
- `started` → keep any error shown, mark the page `retrying` (spinner on Riprova).
- `browser-view-error` → set `error`, clear `retrying`.
- `finished` → wait 300 ms; if no error arrived for that page after this `finished`, clear `error`.

## Rust (src-tauri)

1. `build_child`: after `add_child`, attach engine handlers.
   - **Windows** (`with_webview`, like `browser_view_snapshot`): `CoreWebView2.add_NavigationCompleted`:
     if `IsSuccess` is false, read `WebErrorStatus` and map:
     `CONNECTION_REFUSED`/`CONNECTION_ABORTED`/`CONNECTION_RESET`/`CANNOT_CONNECT` → refused;
     `HOST_NAME_NOT_RESOLVED` → dns; `DISCONNECTED` → offline; `TIMEOUT` → timeout;
     any `CERTIFICATE_*` → cert; `OPERATION_CANCELED` and `VALID_AUTHENTICATION_CREDENTIALS_REQUIRED`/
     `VALID_PROXY_AUTHENTICATION_REQUIRED` → **ignore**; anything else → other.
     `code` = the status name without the `COREWEBVIEW2_WEB_ERROR_STATUS_` prefix.
     `add_ProcessFailed`: `RENDER_PROCESS_EXITED` / `RENDER_PROCESS_UNRESPONSIVE` / `FRAME_RENDER_PROCESS_EXITED`
     (main frame only if distinguishable) → crash. Keep the registration tokens alive for the view's
     life (or just leak them: the view's teardown drops the controller).
   - **Linux** (`with_webview` → `pw.inner()` is a `webkit2gtk::WebView`): `connect_load_failed`
     (map `gio::IOErrorEnum` / `webkit2gtk::NetworkError` + message text: "Connection refused" → refused,
     "resolve"/"Name or service" → dns, "timed out" → timeout, `NetworkError::Cancelled` → ignore,
     else other; return `false`), `connect_load_failed_with_tls_errors` → cert (return `false`),
     `connect_web_process_terminated` → crash. Add the `webkit2gtk` dependency under
     `[target.'cfg(target_os = "linux")'.dependencies]` with **exactly the version already in Cargo.lock**
     (the one wry uses) and the same feature set; if that is uncertain, leave Linux as a clearly marked
     TODO and do Windows only.
   - macOS: nothing.
2. `on_navigation`: when `validate_url` rejects a url (not `about:blank`), emit kind `blocked`,
   code `BLOCKED_LOCAL_ORIGIN`, before returning false.
3. `browser_probe_local` command; register it in `lib.rs` next to the other `browser_view_*` commands
   (and in the capability / permission list if those commands are listed anywhere).
4. Check: `CMAKE_GENERATOR=Ninja cargo check` in `src-tauri` (the default target dir can fail on
   whisper-rs-sys; a temp `--target-dir` is fine, delete it afterwards). `cargo clippy` on the crate
   if it runs in reasonable time. Unit-test the status→kind mapping and the loopback check as pure fns.

## Frontend (src)

1. `src/browser/nativeView.ts`: `NativeError` type, `onNativeError` subscription, `nativeView.probeLocal(url)`.
2. `src/browser/browserStore.ts`: url page gets `error?: { kind; code; url; at: number }` and `retrying?: boolean`,
   following the timing rule above; actions `setPageError`, `clearPageError`. Tests in `browserStore.test.ts`.
   Blocked: if `browser_view_show`/`navigate` rejects because of `validate_url`, also show the blocked page.
3. `src/browser/BrowserPage*.tsx` (new, keep BrowserPanel.tsx from growing): the page component.
   - Pages: `newtab` (replaces today's `!page` empty state), `local` (kind refused AND host is loopback),
     `offline` (refused non-loopback, dns, offline), `timeout`, `cert`, `blocked`, `crash`, `other`
     (offline art, generic text "Non riesco ad aprire <host>").
   - Doodles: port the `ART` SVGs from the artifact into `src/browser/errorArt.tsx` as React components,
     colours from CSS variables (`--accent`, `--fg`, `--fg-muted`, `--border`, the ansi blue/yellow/red the
     tab strip uses) so the light Carta themes work; keep the small CSS animations, honour nothing for
     reduced motion except stopping the loops (`@media (prefers-reduced-motion: reduce)` → `animation: none`).
   - Texts / buttons exactly as in the artifact's `PAGES[*].A` (title, sentence, buttons), with the host/port
     filled in. Buttons wire to real actions: Riprova/Ricarica → `nativeView.reload`, Apri nel browser di
     sistema → existing open-external, Indietro → existing back, Strumenti sviluppatore → `nativeView.devtools`,
     "Apri un terminale qui" → open a terminal tab in the cwd resolved as for the agent (below).
   - `local`: "In attesa che la porta torni su…" line + `probeLocal` every 2 s while the page is shown;
     on true → reload.
   - New tab: doodle + "Dove andiamo?" + tiles of the **alive detected dev servers** from the store (click → open).
     No tiles when none.
   - While a page has `error`, the native child is hidden (same path the freeze/cover logic uses) and the
     React page is shown in its place; when the error clears, the view is shown again.
4. Details dialog (`Dettagli tecnici`): code + url bar, then key/value lines: kind, code, url, time;
   for `local` also "porte vive" from the alive detected servers. Footer: Copia (plain text to clipboard),
   ✦ Chiedi a un agente, Chiudi. Esc / click outside closes.
5. Agent menu: reuse `useDiagnosisAgents`, `defaultDiagnosisAgent`, `lastDiagnosisAgent`,
   `rememberDiagnosisAgent` from `src/crash/diagnosis.ts` (not-ready agents greyed with their reason, as the
   crash dialog does). Under the list: "Apre una chat nella cartella del progetto con questo messaggio già
   inviato:" + the prompt preview. Prompt (Italian or English per UI language via i18n):
   "Il browser interno di Flowcode non riesce ad aprire <url>. Errore: <code> (<kind>). <details lines>
   Trova la causa e, se puoi, sistemala."
6. Opening the chat: new window event (pattern of `src/crash/diagnosis.ts`), e.g. `flowcode:browser-diagnosis-open`
   with `{ agent, prompt, label, pageId }`. App handles it with `openChatTab(agent, cwd, { label, firstPrompt })`.
   - Add a generic `firstPrompt?: string` to chat tabs / `openChatTab` opts / `AgentSessionView`: sent once when
     the agent is ready (same code path as `diagnosis.prompt`), **without** the crash banner, the diagnosis tool or
     any auto-allow. It must never be sent twice: clear it from the tab once sent and make sure session restore
     doesn't persist it (check how tabs are serialised).
   - cwd: the terminal tab that printed the page's dev server (detected servers have `tabId`) if the url matches one,
     else the tab the page was opened from if the store knows it, else the active tab's cwd, else the home dir.
   - Then the toast in the browser panel ("<Agent> sta diagnosticando <host>" + "Apri chat" → select that tab),
     4 s, reusing the existing `.browser-panel-toast` look.
7. i18n: all strings in every locale file under `src/i18n/locales/` (en + it at least; others: English text if the
   file exists and is complete).
8. Checks: `npm run typecheck`, `npx vitest run`, `npx knip` if configured. No new deps.

## Not in this phase
macOS error detection (later: probe with ureq after a slow load), HTTP status pages, iframe pages (artifacts/files/PDF),
phone browser.
