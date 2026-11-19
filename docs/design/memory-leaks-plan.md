# Memory leak — piano per i problemi rimasti

Review 2026-11-19 (5 revisori in parallelo). Causa scatenante: PC di un tester crashato con commit di sistema 84/85 GiB e job di Flowcode a ~70 GiB.

Già risolto:
- `ecc1a4b`: tree-kill dei terminali chiusi; job Windows per chat, così muoiono anche i figli di un agente uscito da solo.
- `bc55690`: timeout su `git`; subagent spenti a fine task.

Questo piano copre il resto. Ordine = rapporto beneficio/rischio. Ogni fase si committa e si testa da sola.

Legenda: **[V]** verificato da me sul codice.

## Stato (2026-11-19)

Fatto, non provato nell'app né su device:
- Fase 1: W1 + W2 in `7275bb7`. Lo script di scan è provato su Ubuntu reale: uccide solo il processo marcato.
- Fase 2: L1 opzione A (compattazione) in `e4e6801`.
- Fase 3: F1, F4, F5, F6 in `cbb7a19`.
- Fase 4: P1–P6 in `7df5629`. Kotlin non compilato.
- Fase 5: B2 in `7275bb7`/`e4e6801`, B3 in `e4e6801`.

Aperti:
- M1: `memory.log` del tester.
- M2: chiusura di un tab WSL nell'app vera.
- M3: misura di WebView2.
- F2/F3: in attesa di M3.
- B1, B4: rinviati (rischio alto o beneficio basso).

---

## Fase 0 — Misurare prima di toccare (nessun codice)

| ID | Cosa | Come |
|---|---|---|
| M1 | `memory.log` del tester | Confermare che i 70 GiB fossero processi orfani. Se invece è un solo processo enorme (es. `claude.exe` o `node`), il problema è nell'agente e le fasi sotto diventano secondarie. |
| M2 | Orfani WSL nei terminali | Tab WSL → `npm run dev` → chiudi il tab → `wsl -e ps -eo pid,pgid,sid,cmd`. Se il server è sparito (SIGHUP alla chiusura del tty), W1 scende a bassa priorità. |
| M3 | Peso WebView2 per chat | Task Manager di Edge (Shift+Esc in devtools) oppure `msedgewebview2.exe` in Gestione attività: memoria con una chat lunga (~1000 messaggi, molti tool call) contro una chat vuota. Serve per decidere quanto spingere F1–F3. |

## Fase 1 — Processi Linux in WSL

| ID | Grav. | Dove | Problema | Fix |
|---|---|---|---|---|
| W1 [V] | med | `pty/mod.rs` `reap` | Uccidere `wsl.exe` non uccide i processi dentro la distro. Restano in `vmmemWSL`, fuori dal job. | Ogni tab marca già tutti i suoi processi Linux con `FLOWCODE_PTY_ID=<id>`, passato nella distro da `WSLENV` (`pty/mod.rs:453`). In `reap`, solo per i tab WSL, prima del tree-kill Windows: `wsl.exe [-d distro] --exec sh -c '<scan>'`. Lo scan legge `/proc/*/environ` come in `agents/wsl.rs:73` e fa `kill -KILL` dei pid con quell'id. Con timeout (`run_wsl`). Va nel thread di `reap`, già fuori dal thread UI. |
| W2 [V] | low-med | `chat/session.rs:822` `kill_wsl_group` | Il gruppo Linux della chat si uccide solo se è arrivata la riga `FLOWCODE_PROCESS_GROUP=` dallo stderr. Se l'agente muore prima di stamparla, il gruppo resta vivo. | Stessa marcatura di W1 per le chat WSL: `FLOWCODE_CHAT_ID=<chat id>` via `WSLENV` in `spawn_agent` (`chat/state.rs:490`). Quando il gruppo manca, `kill_wsl_group` usa lo scan per env come fallback. |

Test: unit test sullo script di scan (parsing), poi prova manuale come M2.

## Fase 2 — Memoria del backend per le chat finite

| ID | Grav. | Dove | Problema | Fix |
|---|---|---|---|---|
| L1 | low-med | `chat.rs:74,79` | Ogni chat tiene in RAM un log fino a 20 000 eventi / 32 MiB, anche da terminata, finché il tab resta aperto. Serve per il replay alla riapertura e al telefono. | Opzione A: quando la chat è terminata e nessuna vista la segue da N minuti, compattare il log (tagliare `rawInput`/output dei tool vecchi oltre una soglia). Opzione B: scaricare su disco (`app_cache/chat-logs/<id>.jsonl`) e ricaricare al replay. **Decisione**: consiglio A, più semplice, niente I/O nuovo. |

## Fase 3 — Frontend desktop (WebView2)

Da dimensionare con M3. Va in ordine di rischio crescente.

| ID | Grav. | Dove | Problema | Fix |
|---|---|---|---|---|
| F1 | med | `src/chat/ChatBody.tsx`, `chat.css` | Nessuna virtualizzazione: ogni messaggio resta nel DOM (markdown, tabelle, mermaid, KaTeX, output dei tool). | `content-visibility: auto` + `contain-intrinsic-size` sui blocchi messaggio. Solo CSS, salta layout e paint dei messaggi fuori schermo. Da verificare scroll-to-bottom e i salti di ancora. |
| F2 | med | `src/App.tsx:2871-2945` | Tutti i tab restano montati e nascosti con `display:none`/`hidden`. Con 20 chat lunghe ci sono 20 DOM completi. | Smontare il `ChatBody` dei tab chat nascosti da più di ~10 min, tenendo modello e stato in `useChat`/store, e rimontarlo al ritorno. Rischi: scroll da ripristinare, bozze del composer (già nello store?), animazioni dello stagno. I terminali no: xterm va tenuto vivo. |
| F3 | low-med | `src/chat/chatModel.ts` (`applyEvent`) | Il modello tiene tutto: output completi dei tool e chunk di pensiero. Al resume `useChat.ts:247` rifà il replay da `afterSeq: 0`. | Troncare nel modello gli output dei tool oltre ~64 KB (con "mostra tutto" che li richiede al backend), oppure tenere solo gli ultimi N turni completi e mostrare i vecchi compressi. **Decisione** dopo M3. |
| F4 | low-med | `src/chat/chatImages.tsx:24,54,94`; `ChatBody.tsx:1239` | Le immagini `data:` base64 restano nelle stringhe del modello e fuori dalla cache da 64 MiB. | Convertirle in blob tramite `urls.load` (LRU con revoca): la stringa base64 esce dal modello dopo la conversione. |
| F5 | low | `GoalChip.tsx:7-8`, `useCacheWarning.ts:13`, `LinkPreviews.tsx:15`, `mcpIconLoader.tsx:7`, `terminal/wslPath.ts:24` | Piccole Map a livello di modulo mai potate. | Pulirle in `forgetTab` (`App.tsx:1426`) o metterci un tetto come `fileLinks.tsx:45` (500). |
| F6 | low | `GitPanel.tsx:216` | Poll di `git status` ogni 15 s anche con pannello nascosto, senza guardia contro le sovrapposizioni. | Guardia `inFlight` + pausa quando il pannello non è visibile. Ora che `git` ha il timeout è solo una questione di efficienza. |

## Fase 4 — Mobile e codice condiviso

| ID | Grav. | Dove | Problema | Fix |
|---|---|---|---|---|
| P1 [V] | low-med | `shared/agentViewBridge.ts:253` | `received` tiene ogni evento finché la vista plugin è montata: la storia della chat in doppia copia. | Dopo la prima consegna serve solo la deduplicazione: tenere l'ultimo `seq` (gli eventi sono ordinati) o un `Set<number>` con tetto, e svuotare `received`. |
| P2 [V] | med (launcher) | `WidgetRender.kt:29,31` | 24 frame fino a 1400 px decodificati nel launcher (~80 MB per widget grande). | Abbassare `MAX_SIDE_PX` a ~800: è pixel art e il launcher la scala comunque. Da provare su device per la nitidezza. In alternativa 12 frame a 6 fps. |
| P3 | low-med | `mobile/src/chats.ts:88-103` | Fino a 8 conversazioni intere in RAM (4000 eventi + 5000 item ciascuna), più quelle seguite o in invio. | Tetto anche in byte (stima `JSON.length` per sessione, es. 64 MB in tutto), oppure `MAX_SESSIONS = 4`. |
| P4 | low | `mobile/src/chatImages.ts`, `shared/chatImageFetch.ts`, `shared/imageUrlCache.ts` | Due cache da 64 MB ciascuna (~128 MB). | Budget di 32 MB ciascuna su mobile (parametro già presente). |
| P5 | low | `mobile/src/mcpIcons.ts:13` | Nessun reset al cambio di host. | Reset su `ready` con un nuovo `hostName`, come fa `linkPreviews.ts`. |
| P6 | low | `mobile/src-tauri/src/remote_dictation.rs:~54-72` | `write_all` senza timeout: un abort non sblocca una scrittura ferma. | `tokio::select!` fra scrittura e `Msg::Abort`, più un timeout. |

## Fase 5 — Minori backend (opzionali)

| ID | Dove | Fix |
|---|---|---|
| B1 | `chat/state.rs:500,564` | `process_job::assign` arriva dopo `spawn`: un figlio nato in quella finestra resta fuori dal job. Spawn con `CREATE_SUSPENDED` + resume dopo l'assegnazione (serve il thread handle). Rischio medio, beneficio basso. |
| B2 | `chat/session.rs:952`, `shared/src/lib.rs` `kill_tree` | `taskkill` senza timeout: farlo passare da `wait_with_timeout`. |
| B3 | `remote/preview.rs:~190` | L'upload alloca `vec![0; size]` subito: crescere con `take(size)`. |
| B4 | `pty/mod.rs:576-627` | Nessuna contropressione tra reader del PTY e WebView: un flood (`yes`) gonfia il renderer. Valutare un throttle quando la coda IPC cresce. |

---

## Ordine consigliato

1. **Fase 0**: M1 appena arriva il log; M2 e M3 li posso fare io sull'app di sviluppo.
2. **Fase 1**: W1 + W2, un commit.
3. **Fase 4**: P1 + P2 + P4 + P5 (piccoli e isolati), un commit.
4. **Fase 3**: F1 + F4 + F5 + F6, poi F2/F3 se M3 mostra che servono.
5. **Fase 2** e **Fase 5** solo se le misure indicano che pesano.

Decisioni aperte: L1 (A o B), F3 (troncare o compattare), P2 (dimensione o frame).
