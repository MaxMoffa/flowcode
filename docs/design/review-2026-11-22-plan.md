# Review generale 2026-11-22 — piano

6 revisori (Rust chat/agenti, Rust remoto/sistema, frontend chat/app, frontend resto, mobile, codice morto).
Nessun critico/alto. Voci del piano 2026-11-18 ricontrollate: tutte reggono.
`cargo check` desktop + mobile puliti, `tsc` mobile pulito. Kotlin non compilato.
✔ = verificato da me nel codice.

## S — Sicurezza

| ID | Dove | Problema | Fix |
|----|------|----------|-----|
| S1 ✔ | `src-tauri/src/preview.rs:170` `fetch_pdf` | Redirect pubblico → 127.0.0.1/localhost non bloccato (ogni hop classificato da solo). PDF attaccante → GET su servizi locali + leak PDF locali. | Flag "già pubblico": dopo un hop non locale, tutti i successivi con `PublicOnly`. Test. |
| S2 ✔ | `terminal_mcp.rs:313` + `chat/delegate.rs:842` | Delega da tab terminale: parent `mode: None` → figlio in auto review anche se tab in plan/read-only. `cwd`/`agent` dichiarati dallo script. | Figli da tab in modo sicuro (read-only/plan) salvo modo reale noto, oppure scelta esplicita. |
| S3 | `mobile/.../AndroidManifest.xml:39` + `WidgetPlugin.kt` | Qualsiasi app manda intent `WIDGET` (new/voice/resume) a MainActivity esportata → apre sessioni sul PC / accende mic. | Token casuale per install nelle extras dei PendingIntent, rifiuto senza token. |
| S4 ✔ | `browser_view.rs:398` `on_download` + `src/browser/nativeView.ts:93` | Download accettati sempre (anche .exe/.bat) e nessun listener frontend: utente non vede nulla. | Collegare `onNativeDownload` a toast + bloccare/confermare estensioni pericolose (riuso lista di `system.rs`). |
| S5 | `chat/attachments.rs:62` | Allegati in `temp/flowcode-attachments` con permessi default; su /tmp condiviso altro utente legge/sostituisce. | Dir privata 0700 (come `chat_images::init`), check owner in `root_is_safe`, riuso `attachments_root()`. |
| S6 | `mem_watch.rs:145` `redact` | Non maschera `-H "Authorization: Bearer …"`, `-u user:pass`; memory.log va nei crash report. | Mascherare valore dopo `-H`/`-u`/`--header`, `Bearer \S+`. |
| S7 | `WidgetFrameProvider.kt` | Provider esportato: PNG widget leggibili da altre app. | Accettare o grant per-URI. Basso. |
| S8 | `BrowserPanel.tsx:349` | `postMessage(..., "*")`. | Origin del frame host. |

## B — Bug

| ID | Dove | Problema | Fix |
|----|------|----------|-----|
| B1 ✔ | `chat/state.rs:266` `renew` | Manca `unforget_session(&session_id)` dopo `new_session`: agente che riusa id → updates scartati, chat morta dopo /clear. | Chiamarlo dopo `new_session`. |
| B2 | `BackgroundPlugin.kt:78` + `ConnectionService.kt` | pause→resume veloce: `stopService` prima di `startForeground` → `ForegroundServiceDidNotStartInTimeException` crash. | Stop via intent `ACTION_STOP` (startForeground poi stopSelf) o stop differito. |
| B3 | `src/lib/fileLinks.tsx:43` | Risultato "file non esiste" in cache 60 s: path creato poco dopo resta testo. | TTL breve (3–5 s) per null. |
| B4 | `system.rs:357` `kill_wsl_tagged` | Chiusura tab WSL a VM spenta la riavvia; quit può bloccare fino a 10 s. | Skip se `!wsl_running()`, join con cap breve in shutdown. |
| B5 | `system.rs:357` | Sweep uccide anche demoni nati dal tab (tmux, ssh-agent) condivisi. | Decidere: documentare o limitare a sessione/pgid della shell. |
| B6 | `src/browser/browserStore.ts:217` | `window.open` in loop → pagine/webview native illimitate. | Rate-limit per pageId (es. max 3 in 2 s) + tetto pagine. |
| B7 | `src/newtab/PluginNewTab.tsx:~116` | Timer "unresponsive" non riarmato dopo reinstall → iframe vuoto. | `src`/`rev` nei deps. |
| B8 | `src/net/online.ts:12` | Avvio offline → poll 10 s mai avviato; se evento `online` perso resta offline. | Avviare poll se valore iniziale false. |
| B9 | `src/terminal/Terminal.tsx` | Tracker aperture con cwd di mount; `seedDelegates`/`onExt` setState dopo unmount. | Tracker da `cwdRef.current` per evento; guard `disposed`. |
| B10 | `chat/session.rs:302` `send` | Scrittura stdin sotto mutex: pipe piena blocca tutti, cancel incluso. | Cancel via thread writer o timeout. |
| B11 | `remote/dictation.rs` `start` | Panic in `run_session` lascia entry → "busy" fino a reconnect. | Drop guard. |
| B12 | `chat_images.rs` | Hit cache non tocca mtime → purge a 3 gg rompe immagini di preview salvate; nessun tetto totale. | Touch mtime su hit + cap dimensione. |
| B13 | `mobile/src/remote.ts:239` | Cambio PC: `pending` e `shownChatTabs` non azzerati. | Clear su unpaired/computer. |
| B14 | `mobile/src/App.tsx:241` | Flash lista tra `endPending` e `openChat`; `pendingNew` stantio. | Ordine set invertito. |
| B15 | `src/chat/useChat.ts:540` | `childIdsRef` aggiornato in effect: primi eventi figlio persi. | Aggiornare insieme ad `applyEvents`. |
| B16 | `windows.rs:325` | Minimize: figli `fcb-*` non nascosti → possibile frame vuoto al restore. | `SetIsVisible` anche sui figli. |
| B17 | `AudioCapturePlugin.kt` | `join(1500)` su main thread. | Spostare su thread. |

## P — Performance / risorse

| ID | Dove | Problema | Fix |
|----|------|----------|-----|
| P1 | `browser_view.rs:441` | Poll `wv.url()` sincrono ogni 800 ms per ogni figlio, anche nascosti. | Solo visibile o `spawn_blocking`. |
| P2 | `net.rs:44` | DNS senza timeout, offline thread si accumulano. | Pool limitato / guard in-flight. |
| P3 | `preview.rs:~330` `serve` | `fs::read` intero file senza cap (video grandi). | Cap o Range. |
| P4 | `mobile/src-tauri/src/commands.rs:212` | Upload 32 MiB base64 + `bytes.clone()` → OOM su phone low-RAM. | No clone, cap più basso su Android. |
| P5 | `shared/remoteChatSession.ts:84` | Copia array 4000 eventi per batch. | Push in place + trim ammortizzato. |
| P6 | `useGitChangeCount.ts` | Nessun guard in-flight: `git status` lenti si accumulano. | Flag `polling` come GitPanel. |
| P7 | `remote/dispatch.rs:184` `ChatOlder` | Task illimitati per peer. | Uno in-flight per chat. |
| P8 | `chat_mcp.rs` `MAX_IN_FLIGHT=32` | Cap globale, un agente affama gli altri. | Cap per token. |
| P9 | `chat/goal.rs` `PATHS`/`RESULTS`, `updater.rs:215` cache cover | Mappe senza eviction. | `util::insert_bounded`. |
| P10 | `src/chat/chatModel.ts` | `model.items` senza tetto in sessioni lunghissime. | Troncare output tool vecchi / paging. Da misurare prima. |
| P11 | `system.rs:88` `refresh_execed` (mac/Linux) | readlink per ogni processo. | Solo pid degli alberi tab. Basso. |

## D — Codice morto / pulizia

| ID | Cosa | Note |
|----|------|------|
| D1 | `mobile/src/Agents.tsx`: `AgentsScreen`, `UsageCard`, `UsageCarousel`, `Meta`, `ChatAgentRow`, `AgentRow` + CSS solo loro | Restano `CLI_OF`, `groupByProfile`. Alta confidenza. |
| D2 | ~45 chiavi i18n desktop senza riferimenti (vecchio pannello agenti `agents.*`, `app.cli.login*`, `app.toggleAgents`, `agentPanel.windowEstimated`, `chat.delegate.permission`) | Verificare `agentPanel.tools.*` (forse dinamiche) prima. |
| D3 | Export solo-interni: `MAX_NOTICE_CHARS`, `SKIPPED_MESSAGE_REASON`, `SEARCH_FILTERS`, `applyWslTitle`, `ModelGroup`, `QueuedPrompt`, `encodeTypedSegment`, `normalizeBrowserTabs`, `refreshWidgets` | Togliere `export`. |
| D4 | `public/tauri.svg` | Avanzo template. |
| D5 | `DECISION.md`, `TASKS.md` (fermi a 2026-09-17), forse `ROADMAP.md` | Eliminare o archiviare. |
| D6 | `mockups/*.html`, ~70 `docs/design/*-variants.html`, `docs/design/site-8bit-multipage/` | Opzionale: spostare in `docs/design/archive/`. 8-bit tenuto apposta. |
| D7 | `ed25519-dalek` 2 (desktop) vs 3 (mobile) | Allineare. |
| D8 | `term-*.json` orfani in mcp/ dopo crash | Sweep all'avvio in `chat_mcp::setup`. |
| D9 | `#[allow(dead_code)]` blanket su moduli `remote_client` | Togliere temporaneamente e guardare warning. |

## R — Refactor (opzionali, più grossi)

- R1 Updater duplicato desktop/mobile (verifica firma + checksum): estrarre in modulo condiviso via `#[path]`. Sicurezza: una sola copia.
- R2 `useDictation` desktop/mobile: stato comune.
- R3 `ChatImage`/`ChatPondEnd` desktop/mobile → `shared/`.

## Falsi positivi noti (non toccare)

`site/assets/*.js`, `scripts/release-art/*`, `src/welcome/empty.css` (alias vite), `scripts/*`, `docs/agent-views/*`, `docs/new-tab/*`, `crash_simulate` (già `cfg(debug_assertions)`), campi tenuti per `Drop` (`pty job`, `watcher Native`).

## Da decidere

1. S2: figli da tab → read-only/plan sempre, oppure rifiutare delega se modo ignoto?
2. B5: lasciare kill dei demoni WSL (documentato) o limitarlo?
3. S4: download → conferma per tutti, o blocco solo estensioni pericolose + toast?
4. D6: archiviare o cancellare varianti design?

## Esito (2026-11-22)

Decisioni utente: S2 = figli allineati alla modalità dell'agente che li lancia; B5 = a mia scelta (kill limitato alla sessione del tab); S4 = conferma + menu download (variante A, dot di B sul pulsante); D6 = cancellare.

Fatto (commit 356d9f0..HEAD su master):
- 356d9f0 D4 D5 D6 pulizia file.
- b67fbc3 B3 B7 B8 B9 B15 (layout effect, non sincrono) P6.
- 510a783 S3 B2 B13 B14 B17 P4 P5 (copia singola, niente push in place) D1.
- d47912d S1 P3 S6 P2 P9b B4 B5 B11 P7 B16.
- 947ec75 B1 S5 D8 P8 B10 B12 (P9a era già fatto).
- bd228fb S2 (`tab_agent_mode.rs`): Claude transcript / Codex turn_context / flag CLI; ignoto (Vibe, OpenCode, Cline, WSL, sessione nuova) → read-only.
- ba0294e S4 download + B6 P1 S8.
- commit finale: D2 D3.

Verifiche: cargo test desktop 517 verdi, tsc root+mobile, vitest 1092 verdi, cargo check mobile. Kotlin non compilato. Niente provato in app o su telefono.

Non fatti: S7 (accettato), P10 (da misurare), P11 (basso), D7 + R1 (updater condiviso, rinviato: tocca la verifica firma di due release path non testabili qui), R2 R3, D9.
