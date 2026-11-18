# Review generale 2026-11-18 — piano

Review in sola lettura su tutto il repo (6 revisori in parallelo per area + controlli statici).
Controlli statici: `tsc --noUnusedLocals --noUnusedParameters` desktop e mobile = 0 errori; `cargo check --all-targets` desktop = 0 warning; nessun file TS orfano (i candidati erano import a effetto collaterale).
Nessun bug ad alta gravità. Verificati a mano: B1, B2, B3, B7, B9, S1.

Legenda: **[V]** verificato da me sul codice; gli altri sono verificati dal revisore leggendo codice e chiamanti.

---

## Fase 1 — Sicurezza

| ID | Grav. | Dove | Problema | Fix |
|---|---|---|---|---|
| S1 [V] | med | `mobile/.../MainActivity.kt:77-78,103` | `addJavascriptInterface` espone `FlowcodeScreenshots.setAllowed` a ogni frame, incluse le iframe del browser (dev server, artifact). Una pagina può togliere FLAG_SECURE e salvare la preferenza. | Ignorare chiamate non dal main frame (o spostare su comando Tauri con ACL). Verificare anche che le iframe su `flowcode-remote.localhost` non possano chiamare comandi app (`send`, `unpair`). |
| S2 | med | `src-tauri/src/provider_auth_keys.rs:183,210,382` | API key in chiaro in `.flowcode-auth.json`; su Windows nessuna ACL/DPAPI. Follow-up noto. | Sigillare `api_key` con `keystore::seal` (prefisso `dpapi1:`), unseal in `read_record`, migrazione trasparente. |
| S3 | low-med | `src-tauri/src/crash.rs:593` | Il crash report include 20 righe di `remote.log` con IP:porta, relay, indirizzi LAN; finisce in issue pubbliche. | Redazione IPv4/IPv6 in `scrub`, o togliere la sezione. |
| S4 | low | `remote/handshake.rs:143`, `auth.rs:86` | Ri-pairing dello stesso nodo invalida il token ma non chiude la vecchia connessione. | `kick(Revoked)` sulle connessioni dei device rimossi. |
| S5 | low-med | `src/agentViews/PluginViewHost.tsx:21,112` | `BYPASS_MODE` è una denylist sul solo id modalità; un id tipo "auto-approve" passa. | Allowlist degli id offerti dal menu host, o conferma utente. |
| S6 | low | `src-tauri/src/plugins.rs:321` | `run_plugin_command` esegue qualsiasi stringa dalla webview. | Passare plugin id, risolvere il comando dal manifest nel backend. |
| S7 | low | `src-tauri/src/preview.rs:161-176,224` | `preview_pdf_bytes`/`preview_file_mtime` senza guard `is_local_path` (UNC → NTLM); `fetch_pdf` segue redirect da localhost verso LAN. | Aggiungere guard + resolver SSRF anche ai redirect. |
| S8 | low | `src-tauri/src/chat_images.rs:28-46` | Immagini chat in `/tmp` con permessi default (Linux, pre-creazione/symlink). | App data dir con 0700. |
| S9 | low | `AndroidManifest.xml:93-123` | Receiver widget `exported="true"`: qualsiasi app può forzare render pesante. | `exported="false"` (da provare su device). |
| S10 | low | `lib.rs:161` | `crash_simulate` registrato e raggiungibile dalla webview. | Rimuovere o `#[cfg(debug_assertions)]`. |
| S11 | low | `src/settings/FunzionalitaPage.tsx:19`; `src/app/appPrefs.ts:36` | `action in LABELS` accetta chiavi del prototipo; approvazione comandi via hash djb2 32 bit (collisioni). | `Object.hasOwn`; chiave = comando intero o SHA-256. |
| S12 | low | `remote/preview.rs:~72` | Il tunnel porta raggiunge qualsiasi porta loopback (MCP, DB, debug). Per design. | **Decisione**: allowlist porte (tab browser + listener rilevati)? |
| S13 | low | `src-tauri/src/acp_adapters.rs:148` | Solo versione top-level pinnata; dipendenze transitive npm fluttuano. | package-lock + `npm ci`. |

## Fase 2 — Bug medi

| ID | Dove | Problema / scenario | Fix |
|---|---|---|---|
| B1 [V] | `src/App.tsx:1560,1619,1657` | "Ultimo tab → chiudi finestra" usa `tabs.length`, che conta la bozza del dialog Nuovo tab. 1 tab + Ctrl+T + Ctrl+W → chiude il tab vero, finestra resta col solo dialog. | `listedTabs(...).length === 1` nei 3 punti. |
| B2 [V] | `src-tauri/src/dictation/cleanup.rs:74,89` | Cleanup dettatura con opencode su Windows passa il prompt multi-riga come argomento a `opencode.cmd`: Rust rifiuta argomenti batch con `\n` → cleanup opencode non funziona mai; `%VAR%` espansi da cmd. | Prompt via stdin/file temporaneo. Stesso problema in `provider_launcher.rs:156` (B19). |
| B3 [V] | `src/chat/ChatTable.tsx:9-15` | Escape sul foglio tabella fa solo `preventDefault`; arriva anche al composer → `chat.cancel()` interrompe il turno. | `stopPropagation()`. |
| B4 | `src-tauri/src/chat/cline.rs:124-163` | `Spawns.active` di Cline non si azzera su TurnEnd/Error/cancel: dopo un annullo con sub-agent attivo tutta la chat finisce annidata sotto la card sub-agent e la risposta delegata può risultare vuota. `known`/`cline_tools` illimitati. | Reset su TurnEnd/Error; cap delle mappe. |
| B5 | `src-tauri/src/chat_mcp.rs:229-247`, `flowcode-mcp.cjs:123` | `deadline_ms` calcolato con l'orologio WSL e confrontato con quello Windows: dopo sleep l'orologio WSL è indietro → tool MCP (`open_in_browser`, `call_user`, `list_agents`) scadono subito. | Inviare `timeout_ms` relativo, deadline calcolata in Rust. |
| B6 | `src-tauri/src/remote/handshake.rs:130-143` | `confirm_pairing` non osserva la chiusura della connessione: il telefono se ne va, l'utente accetta, resta un device fantasma e uno slot occupato. | `connection.closed()` nel `select!`. |
| B7 [V] | `src/plugins/registry.ts:40-55`, `App.tsx ~459-466` | Plugin OpenCode/Cline senza `builtin: true`: in Funzionalità c'è "Elimina" che fallisce, e al primo click chiede conferma come plugin di terzi. I blocchi di seed sono codice morto. | `builtin: true` + rimuovere seed. |
| B8 | `src/newtab/GlassNewTab.tsx:~420` | Ricerca cartelle (7d9501b): Invio prima che arrivino i risultati esegue il testo come comando shell. | Ignorare Invio mentre `folderPending`. |
| B9 [V] | `mobile/src/widgets.ts:25` | `usableAgents()` non filtra Cline: widget può offrire Cline su desktop senza capability → attesa 45 s a vuoto. Filtro copiato in 6 punti (Home, NewTerminalSheet, ProfilesSettings). | Helper unico vicino ad `AGENTS`. |
| B10 | `mobile/src/ChatPermission.tsx:34`, `ChatAsk.tsx:28`, `src/chat/AskComposer.tsx:39-44` | Flag "risposto" mai resettato: se l'invio si perde (link giù) o `chat_ask` fallisce, la card resta morta, nessun retry. | Reset su offline/`ready` (telefono) e su errore (desktop). |
| B11 | `WidgetRender.kt:247-262` | `goAsync()` + 24 PNG fino a 1400 px, `updateOne` synchronized: resize widget ripetuti superano 10 s → ANR/kill. | Coalescing per id, `finish()` presto o WorkManager. |
| B12 | `src/chat/chatLimit.ts:12-14`, `agents/limitText.ts:94` | Ogni testo dell'agente nel turno passa da `detectLimit`: una risposta che *cita* "you've hit your limit… resets 3pm" mostra lo stagno e arma l'auto-continue. | Solo messaggi brevi/ultimo item, o flag strutturato. |
| B13 | `mobile/src/chats.ts:156` | Cambio `sessionId` di una chat live scarta la sessione: messaggi in coda/inviati non confermati persi in silenzio. | Trasportare `queued`/`sentText`/`sentFiles`. |
| B14 | `mobile/src-tauri/.../store.rs:61-67`, `SecureStorePlugin.kt:80` | Null transitorio del Keystore (alcuni OEM dopo boot) → `KEY_MISSING` → nuova chiave device e pairing perso. | Retry breve prima di dichiarare la chiave persa. |

## Fase 3 — Bug minori

Desktop Rust
- B15 `crash.rs:252` check "owner vivo" con tolleranza 5 s: avvio lento → seconda istanza cancella il marker della prima. Finestra `[started-120s, started+2s]`.
- B16 `crash.rs:294` legge `remote.log` da `app_data_dir`, scritto in `app_config_dir` → vuoto su Linux.
- B17 `chat/delegate.rs:433-440` `close_child` emette Exit prima di `closed`: il task fallisce con "the agent exited" invece del motivo reale.
- B18 `chat/attachments.rs:93-114` quota 256 MiB conta file già inviati (purge solo dopo 3 giorni): messaggio d'errore fuorviante. **Decisione**: purge 24 h o quota per chat.
- B19 `provider_launcher.rs:156-170` shim `.cmd` + argomento con newline → exit 127 muto; script shim riscritti non atomicamente.
- B20 `view_plugins.rs:256` `remove_dir_all` poi `rename`: se fallisce, plugin perso; staging `.tmp-*` mai puliti.
- B21 `remote/fsbrowse.rs:57` `take(5000)` prima di ordinare, senza flag `truncated`.

Mobile Rust/Kotlin
- B22 `commands.rs ~165` upload rifiutato dal desktop: il telefono mostra errore generico di stream invece del motivo.
- B23 `view_cache.rs:100-130` cartelle `.staging` di trasferimenti interrotti mai rimosse.
- B24 `AudioCapturePlugin.kt` `permissionEpoch++` non atomico; join 1,5 s sul main thread; due thread pump se il join scade.
- B25 `BackgroundPlugin.kt:51` campi letti da thread UI senza `@Volatile`.
- B26 `commands.rs ~295` ogni `app_hidden` crea un task che dorme fino a 24 h; si accumulano.

Frontend
- B27 `useChat.ts:214-222` eventi bufferizzati durante il replay non passano da `followOpen` (bubble `call_user` persa).
- B28 `chat/chatImages.tsx:30` cache immagini per path senza revisione: file riscritto → immagine vecchia.
- B29 `App.tsx:251` `panelsByTabRef` mai pulito in `forgetTab`.
- B30 `chat/useDictation.ts:170` `Promise.all` di `listen`: se uno fallisce gli altri restano registrati.
- B31 `CrashReportDialog.tsx:79` Escape ovunque (anche in textarea) scarta il report per sempre.
- B32 `PdfViewer.tsx:~58` doc vecchio resta dopo reload fallito; destroy prematuro → pagine bianche durante zoom.
- B33 `PluginNewTab.tsx:~133` `connected` non resettato su reinstall.
- B34 `browserStore.ts:120` `pageLabel` non gestisce `\` su Windows.
- B35 `plugins/usage.ts:~455` limite budget 0 → NaN/Infinity; variabile `console` oscura il globale.
- B36 `mobile/src/widgetsModel.ts:52` widget "riprendi" prende l'ultima della lista, non la più recente per `activeAt`.
- B37 `mobile/src/useBrowserTabsSync.ts:88` riaprire il drawer re-invia `openUrl` e fa ricomparire un tab chiuso sul desktop.
- B38 `mobile/src/ChatImage.tsx:327` blob URL del download mai revocato.

## Fase 4 — Performance / memoria

- P1 `agent_insight.rs:460-474,603-622` ri-parsa l'intero transcript (fino a 200 MiB) a ogni crescita; riusare lo scanner incrementale di `spend.rs`.
- P2 `chat/goal.rs:112-139` poll /goal ogni 4 s: lista tutte le cartelle progetti + buffer 4 MiB copiato 2 volte. Cache path + skip se lunghezza invariata.
- P3 `useChat.ts:398-412` listener globale per chat che riscansiona tutti gli item a ogni evento di ogni chat (O(N×items)). Set di child id in ref.
- P4 Cache mobile illimitate: sessioni chat seguite (5000 item + 4000 eventi raw ciascuna) `chats.ts:152`, `linkPreviews.ts` (data:image), `insightStore.ts`, `defaultModeTried` `ChatScreen.tsx:67`. LRU + pulizia su cambio host.
- P5 `mobile/src/chatImages.ts:15` ogni `ready` svuota la cache → tutte le immagini ricaricano e sfarfallano. Pulire solo su cambio host.
- P6 `commands.rs app_resumed` / `connect`: ogni ritorno in primo piano abbatte un link QUIC sano (anche dopo 2 s). **Decisione**: Ping/Pong prima di restart?
- P7 `remote/preview.rs:253` e `mobile preview.rs:~151` file/risposte fino a 64 MiB in RAM per richiesta, senza Range.
- P8 `remote/connlog.rs:55` IO sincrono sotto mutex dai task async → thread writer.
- P9 `useAvailableClis.ts:26` riesegue tutte le probe CLI a ogni cambio profilo (inutile).
- P10 Widget a 12 fps + re-render 24 PNG ogni 30 min: batteria. Skip se snapshot invariato.
- P11 `useResizablePanelWidth.ts:~88` scrive la larghezza default al mount (cambi futuri del default ignorati).

## Fase 5 — Codice inutilizzato

- D1 `chat/session.rs:976` evento `_flowcode/warning` (messaggio >16 MiB saltato) senza consumer: sembra un blocco. **Meglio consumarlo** in `chatModel.ts` come avviso di sistema.
- D2 `lib.rs:329` `remote_host_log` registrato, mai invocato. (`crash_simulate` → S10.)
- D3 `src/calls/callStore.ts:82` `getCalls` usato solo nei test.
- D4 `mobile/src/chats.ts:211` `getChatSession` solo test; `MAX_WIDGET_AGENTS` export inutile.
- D5 14 chiavi i18n mobile mai usate: navTerminals, waitingOne, waitingMany, openTerminal, profileLoginSent, windowMain, windowN, tabCount, tabCountOne, contextPct, openCount, openCountOne, chatEmpty, needYou.
- D6 3 chiavi i18n desktop dopo redesign Nuovo tab: `newTab.glass.kind.agent|favorite|recent`.
- D7 `WidgetArt.kt:504-540` `dayLetters`/`drawLetter`/font pixel mai usati (ramo `letters` irraggiungibile).
- D8 `res/drawable/widget_white_pill.xml` non referenziato.
- D9 Blocchi seed opencode/cline in `seedExamplePlugins` (con B7).

## Fase 6 — Miglioramenti / refactor

- R1 Estrarre da `Shell` in `App.tsx` (3532 righe), in ordine: `usePluginHost` (~130 righe), `terminal/titleResolver.ts` (resolveTitle/applyWslTitle puri), `tabs/chatPanes.ts` (reducer puri testabili), `usePerTabPanels`, `useSessionRestore`, `useRemoteHandlers` (~15 ref), `useTabBookkeeping` (ref map + `forgetTab`). Uno alla volta, test in app dopo ognuno.
- R2 `agents/mod.rs:387-420` tre loop opencode/cline/vibe copia-incolla; `agent_insight.rs:577-602` blocco cline = opencode; `apply_vibe_session` nome fuorviante → helper comune.
- R3 `chat/session.rs:527` ramo `if auto_allowed {}` vuoto.
- R4 Validazione input: `shortcuts.ts:99` override non validati; `AgentViewsSection.tsx:~28` `JSON.parse` senza try/catch → errore grezzo.
- R5 `remote-proto msg.rs BrowserRoot` enum `untagged`: payload con entrambi gli id diventa Pty in silenzio → campo `kind`.
- R6 `mobile updater.rs` APK verificato riusato senza ri-hash; download senza cap.
- R7 `remote/mod.rs:78` 4 slot handshake occupabili da sconosciuti → rate limit per IP/nodo.
- R8 **Decisione**: `chat/delegate.rs:690-717` `inherited_mode`: con parent senza restrizioni, figli Gemini/Vibe/Cline/OpenCode partono in plan/read-only e non possono modificare file. Voluto?

---

## Decisioni richieste

1. S12 allowlist porte del tunnel telefono? (rec: sì, porte dei tab + listener rilevati)
2. B18 politica quota allegati (rec: purge 24 h + messaggio corretto)
3. P6 restart link a ogni resume (rec: Ping/Pong 2 s, restart solo senza risposta)
4. R8 modalità figli delegati per agenti senza "auto" (rec: mappare la modalità act/default di ciascuno)
5. D1 avviso messaggio >16 MiB: mostrare (rec) o togliere

## Ordine di esecuzione proposto

1. Fase 1 + B1-B14 (prima del prossimo rilascio)
2. Fase 3 + Fase 5 (batch meccanici, Haiku)
3. Fase 4 (P1, P3, P4 prima)
4. Fase 6 R1 a pezzi, test in app dopo ogni estrazione

Verifica per ogni fase: `npm run typecheck`, `npm test`, `cargo check` + `cargo test --lib` (desktop e mobile), Kotlin compilato via build Android; prove manuali elencate nei singoli item (B1, B3, B8, B10, B12 desktop; S1, B9, B11, B13, B14 telefono).

---

## Esito (2026-11-18)

Decisioni applicate: 1 = denylist porte di sistema/admin/DB invece di allowlist (l'allowlist sarebbe in race con `openUrl`, e i server avviati fuori dall'app non sono rilevati); 2 = purge 24 h; 3 = Ping/Pong solo per pause < 30 s; 4 = figli delegati in modalità di modifica (Gemini/Vibe `default`, Cline `act`, OpenCode `build`); 5 = avviso mostrato.

Commit: 1b9274f (3b), 5a8f6be (telefono TS), 0a11ceb (telefono nativo), 756a887 (desktop tab/chat/plugin), 8bb28cc (remote), f528886 (core), 4bc6e36 (chat/deleghe).

Saltati: S13 (serve rete per generare i lockfile), D3 e D4 `getChatSession` (usati dai test), D8 (falso positivo: `widget_white_pill.xml` è usato in `widget_canneto.xml`).
Non verificati: Kotlin non compilato (nessun JDK su questo PC); `opencode run` con prompt su stdin non provato (opencode non installato).
Verifiche: tsc desktop + mobile ok, vitest 1039 ok, cargo check senza warning, cargo test desktop 447 + proto 38 + mobile 46 ok. Niente provato nell'app o sul telefono.
