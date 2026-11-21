# Crash analysis with an agent — implementation plan

Chosen UI: **variant A** of `docs/design/crash-agent-diagnosis-variants.html` (footer split button + floating pill while the agent works + dialog reopens with the verdict on top). Builds on the existing crash dialog (`src/crash/*`, `src-tauri/src/crash.rs`, see `docs/design/crash-report-a-v2.html`).

Scope now: crash reports only (desktop main window). Keep names generic enough ("diagnosis" keyed by report id) to hook other detected problems later. Memory-watch warnings are an OS toast, out of scope for now.

## Flow

1. Crash dialog shows as today. Footer gets, on the left, a split button: main part "Analizza con <agent>" (last used / first ready agent), chevron opens a menu listing the 6 agents: ready ones selectable (with model/"ultimo usato" hint where cheap to get), not installed / not signed in ones disabled with the reason. Menu footer note: read-only, uses your account's tokens. Hidden entirely when no agent is ready.
2. Clicking it: the report is NOT dismissed. Dialog closes, a floating pill appears bottom-right of the main window: spinner, "<Agent> sta analizzando il crash", one sub-line (latest tool-call title of the diagnosis chat if easy, else static text), buttons "Apri" (focus the chat tab) and ✕ (cancel: closes the diagnosis chat tab and reopens the dialog without diagnosis).
3. A chat tab opens:
   - agent = chosen; cwd = the crash folder (`<app_data>/crash`); shell forced to host (Windows tools needed, never WSL);
   - label "Diagnosi crash"; a thin banner on top of that chat: "Diagnosi del crash di <when> · sola lettura" + "Torna al report" link;
   - mode: same choice as delegated children (`chat/delegate.rs` mode selection: auto review when the agent has it, else its normal mode that asks) — reuse that function, don't duplicate;
   - Flowcode MCP server forced on for this chat with at least the new tool `attach_crash_diagnosis` (even if the user disabled agent tools), plus whatever the user's tools config already allows;
   - first message sent automatically: the prompt below.
4. The agent calls `attach_crash_diagnosis`. Backend validates, scrubs (same `ScrubCtx` scrubbing as the report body), stores it next to the report, emits an event. Chat shows the tool call normally + a confirmation card "Diagnosi allegata al report del crash" with button "Apri il report".
5. On the event: pill disappears, dialog reopens with a verdict card at the top (above the cause card) — see artifact templates `v-machine`, `v-bug`, `v-dup`:
   - `machine`: badge "PROBLEMA DEL PC", title, confidence bar, summary, local fix steps. Footer: "Non chiedere più" checkbox, ghost "Segnala comunque", primary "Ho capito" (= dismiss).
   - `flowcode`: badge "PROBABILE BUG". Footer: "Apri la chat" link, ghost "Non ora", primary "Segnala con diagnosi ↗" (issue body gets the diagnosis section).
   - `duplicate` (existing issue number given): badge "GIÀ SEGNALATO · #N". Primary "Commenta #N ↗": copies the composed comment (diagnosis + system/error sections) to clipboard and opens the issue URL; a short hint says it's in the clipboard.
   - `unknown`: neutral card, same footer as `flowcode`.
   - The diagnosis also appears in "Mostra cosa verrà inviato" (editable body) as `### Agent diagnosis` section.
6. If the diagnosis chat ends/closes without calling the tool: pill turns into "Analisi senza esito" with "Apri il report" (reopens the dialog as before). Report stays pending across app restarts until dismissed or reported (it already does).

## MCP tool `attach_crash_diagnosis`

Defined in `src-tauri/src/flowcode-mcp.cjs` like the others, offered only to a diagnosis chat (chat started with `diagnosis: <report id>`), never to delegated children or terminal tabs. Input:
- `verdict`: "machine" | "flowcode" | "unknown" (required)
- `confidence`: number 0..1 (required)
- `title`: short (≤ 80 chars)
- `summary`: ≤ 1200 chars, plain text/markdown
- `evidence`: string[] (≤ 10, each ≤ 300)
- `local_fix`: string[] (≤ 8, each ≤ 300) — steps the user can do on this machine
- `repro_steps`: string[] (≤ 10)
- `existing_issue`: integer (optional) — open issue in MaxMoffa/flowcode with the same crash
Backend clamps/truncates, rejects bad verdicts, attaches once per report (a second call replaces). Auto-allowed like `call_user` (see `chat_mcp::auto_allow`) — it only writes into Flowcode's own report.

## Prompt (English, sent as first user message; keep it in one Rust or TS constant)

Contents: what happened (report title + the scrubbed body), the files in the cwd (report json, panic file, memory.log if present), the goal (decide whether the crash comes from this computer — drivers, antivirus/injected DLLs, low memory, CPU features, broken install, PATH/agent installs — or from a Flowcode bug), hard rules (read-only: do not modify, delete or install anything, no registry writes, no network except the GitHub issue search; ask before anything else), useful checks for the OS (Windows: Event Log `wevtutil qe Application /q:"*[System[(EventID=1000 or EventID=1001)]]" /c:20 /rd:true /f:text`, `Get-CimInstance Win32_VideoController`, OS build, free RAM/disk, module versions; macOS/Linux equivalents: DiagnosticReports, journalctl, dmesg), searching existing issues (`gh issue list --repo MaxMoffa/flowcode --search "<signature>" --state all` or the public GitHub search API without token), privacy (never include user names, paths, machine names, emails, tokens in the diagnosis), and finally: call `attach_crash_diagnosis` exactly once, then give the user a 2-3 sentence summary in the user's app language.

## Backend

- `crash.rs`: store diagnosis (`<report id>.diagnosis.json` in the crash folder or a field in the report file — pick what fits the existing storage), include it in `PendingCrash`/`CrashReport` sent to the frontend (`diagnosis: Option<Diagnosis>`), include it in the issue body composition (`### Agent diagnosis`: verdict, confidence %, summary, evidence, repro steps; local_fix too), drop it on dismiss. New command to get the crash folder path for the chat cwd (or return it in `PendingCrash`). Unit tests: validation/clamping, scrubbing of diagnosis text, body section.
- `chat.rs` / `chat_start`: optional `diagnosis: Option<String>` (report id) param, stored on the `Chat`; tool enabling (`chat_mcp::enabled_tools` or a wrapper) adds `attach_crash_diagnosis` for such chats and forces the server on. `chat/delegate.rs::mcp_call` dispatches the new tool → `crash::attach_diagnosis(app, report_id, args)`, then emits a Tauri event `crash-diagnosis` `{ reportId }` and a chat ext event so the chat can render the confirmation card.
- Register any new command in `lib.rs`.

## Frontend

- `src/crash/`: dialog state machine `idle | analyzing{agent, tabId} | noResult | result`; split button + agent menu; pill component (portal, bottom-right, above everything but below modals); verdict card; footers per verdict; i18n keys in Italian and English (follow `src/i18n` conventions — check all locales present).
- Opening the chat: the dialog lives outside `App`'s tab state, so expose a small way to ask App to open a diagnosis chat (follow an existing pattern, e.g. a window event / context already used for opening tabs from outside) → `openChatTab(cli, crashDir, { shell: "host", diagnosis: { reportId, prompt } })` → tab carries `diagnosis` → `useChat` passes `diagnosis` to `chat_start` and sends the prompt as the first message once the chat is ready (reuse the existing "send queued/first message" path if there is one).
- Chat view: banner for diagnosis chats; confirmation card on the ext event.
- Agent readiness for the menu: reuse what the new-tab dialog / agent detection already uses.
- Not persisted across restarts: a diagnosis tab restored after restart is just a normal chat (no banner needed).

## Verify

`cargo check` + `cargo test crash` in src-tauri, `npx tsc --noEmit`, `npx vitest run src/crash`, eslint on touched files. In-app test (owner): `invoke('crash_simulate',{kind:'panic'})` in dev, relaunch, click "Analizza con …".
