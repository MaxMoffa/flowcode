# Review generale 2026-11-25 — piano d'azione

6 reviewer paralleli (backend Rust, sicurezza, frontend desktop, animazioni, mobile, pulizia), sola lettura.
Punti chiave verificati a campione nel codice. Nessun problema critico; nessun panic da dati non fidati; listener/cleanup in gran parte già corretti.

Legenda severità: **A** alta · **M** media · **B** bassa. Ogni voce: problema → fix.

---

## Fase 1 — Sicurezza

| ID | Sev | Dove | Problema | Fix |
|---|---|---|---|---|
| S1 | A | `mobile/src/browserUrl.ts:115`, `mobile/src-tauri/src/preview.rs:47-102`, `src-tauri/src/remote/preview.rs:196` | Sul telefono tutte le porte tunnel condividono un'unica origin (`/p/<port>/` + `allow-same-origin`): una pagina dev-server malevola legge via fetch qualsiasi altra porta loopback del PC (Ollama 11434, CDP 9222, inspector 9229…). Denylist corta. | Origin per porta (`p<port>.flowcode-remote.localhost`); sul telefono rifiutare richieste `/p/X` con Origin/Referer di altra porta; aggiungere 9222, 9229, 11434, 5037 alla denylist. |
| S3 | M | `src-tauri/src/chat_mcp.rs:744` | Per adapter non-Claude l'auto-allow dei `browser_*` si basa solo sul titolo `flowcode/browser_*`: un server MCP di repo chiamato `flowcode` passa senza prompt. | Chiavi di `rawInput` ⊆ argomenti noti per ogni tool; dove l'adapter espone metadati server, verificarli come per Claude. |
| S5 | B | `src-tauri/src/terminal_mcp.rs:105-135`, `pty/mod.rs:556` | `FLOWCODE_MCP_TOKEN` esportato nell'env di tutta la tab: qualunque script (npm postinstall…) può usare i tool MCP. | Passare il token solo nella config MCP dell'agente (`term-<pty>.json` già esiste), non nell'env della shell. |
| S7 | B | `src-tauri/src/remote/dispatch.rs:525` | `Resume` dal telefono accetta `cwd` UNC (`\\server\…`) → possibile leak NTLM. | Rifiutare UNC tranne `\\wsl.localhost\`/`\\wsl$\`. |
| S2 | M | `src-tauri/src/remote_client/tunnel.rs:84-130` | Tunnel PC→PC: listener loopback senza autenticazione, raggiungibile da altri processi locali per 10 min. | Stessa policy porte di S1 lato host + segreto per-tunnel nel primo request (o webview con proxy che lo aggiunge). |

**Da decidere (vedi fondo):** S4 modalità figli delegati, S6 scope "solo visualizzazione" per dispositivo.

---

## Fase 2 — Animazioni e fluidità (desktop)

Cause principali degli scatti: (1) pannelli animano `width` → chat/terminale si rilayoutano ogni frame e xterm fa "snap" 320 ms dopo; (2) animazioni infinite che ridisegnano su main thread mentre gli agenti lavorano; (3) card che entrano animate ma spariscono di colpo, con salto del contenuto.

### 2.0 Sistema motion condiviso (base per tutto il resto)
- Token in `themes.css`: `--dur-1 120ms`, `--dur-2 180ms` (menu/card), `--dur-3 240ms` (pannelli/drawer/modali); `--ease-out`, `--ease-in` (uscita ≈0.75× entrata); tutto a 0 con `prefers-reduced-motion` (oggi mancante in modal, context-menu, plugin-menu, plugin-toast, git dock, agent-pill).
- Regola: si animano solo `transform`, `opacity`, `clip-path`. Altezze → wrapper `grid-template-rows 0fr→1fr`.
- `usePresence(open)` (generalizza `usePanelPresence`): `data-state=entering|open|closing`, smonta su `animationend` con fallback = token. Sostituisce i timer ad-hoc (SubagentTray 450 ms, ChatBody 700 ms).
- Flag globale `layoutBusy` (estende `src/lib/layoutDrag.ts`): attivo durante drag, transizione pannelli, resize finestra → xterm rifà fit una volta alla fine, browser nativo congelato, chat salta il pin dello scroll.

### 2.1 Pannelli laterali (A1, A2, A3, A11) — il più visibile
- A1 `src/App.css:253`: il wrapper salta subito alla larghezza finale (un solo reflow), si anima solo `.panel-card` con `translateX`+opacity. Minimo garantito: `layoutBusy` per tutta la transizione.
- A2 resize finestra: transizione width solo su toggle esplicito (classe `is-anim`), `is-resizing` senza transizione; geometria pannelli fuori dallo state di App (CSS var).
- A3 browser nativo: durante apertura/chiusura/squeeze usare il freeze-frame come nel drag (`coverNow = … || transitioning`), la webview nativa torna su `transitionend`.
- A11 drag: larghezza scritta in CSS var via ref, `setState` solo su pointerup (oggi ogni frame rirenderizza tutta App).

### 2.2 Card della chat (A6, A7)
- Uscita animata per: subagent tray, card terminali (anche lista espansa), card cache, card permessi, ask card, call bubble, modali, drawer tab browser + scrim, popover agente.
- Card nel footer avvolte in wrapper `0fr→1fr` → niente salto di altezza della chat.
- Composer↔ask e composer↔cache: cross-fade nello stesso slot invece di `display:none`.
- A6 `ChatBody.tsx:549`: `--chat-footer-h` scritto direttamente con `style.setProperty` (niente state → niente rerender di ChatBody), pin dello scroll in rAF. Righe tray: niente `max-height`.

### 2.3 Costo di fondo (A4, A5/F1, F2)
- A4 sweep tab busy (`tabstrip.css:327`, 16 `<rect>` SVG animati): ridurre a 1–3 segmenti con coda in gradiente, pausa con finestra nascosta/sfocata. Pulse box-shadow (call, mic, bctl-breathe) → pseudo-elemento `scale`+opacity. Loadbar `left` → `translateX`.
- A5/F1 `useViewportCovered.ts:92`: MutationObserver su tutto il body forza layout quasi ogni frame con browser aperto → registro overlay (menu/dialog chiamano `registerOverlay()`) o osservare solo i portal + throttle 100 ms.
- F2 `nativeView.ts:273`: scroll capture globale → ignorare scroll di elementi che non contengono la viewport.

### 2.4 Altri (A8–A10, A12–A14)
- A8 Git dock: drag in rAF + salvataggio su pointerup; corpo visibile fino a `transitionend`.
- A9 /clear: clonare solo righe visibili, togliere `blur`.
- A10 intro chat ripresa: niente `blur`, max 4 righe.
- A12 modali/menu: entrata opacity+translateY senza scale sopra `backdrop-filter`; blur menu 40→20 px.
- A13 `transition: all` e animazioni su height/width (wave bar, progress bar) → `scaleX/scaleY`.
- A14 `contain: layout paint` su `.panel-card`, `.terminal-stack`, composer, card; `contain: strict` su xterm.

---

## Fase 3 — Bug e performance desktop (frontend + backend)

| ID | Sev | Dove | Problema → Fix |
|---|---|---|---|
| B2 | M | `src-tauri/src/chat/session.rs:808` | `reap` esce prima di `drop(job)` se l'agente è già uscito → dev server/daemon lanciati dall'agente restano vivi. → drop del job su entrambi i rami. |
| B1 | M | `src-tauri/src/profiles.rs:530` | `copy_dir` segue symlink senza guardia cicli → ciclo = stack overflow = crash app (abort). → antenati canonici + cap profondità/byte. |
| B3 | M | `lib.rs:417`, `chat/state.rs:27`, `pty/mod.rs:300` | Chiusura app: kill seriale di chat (~6 s l'una) e pty → processo invisibile per molti secondi. → kill in parallelo con deadline ~2 s; su Windows affidarsi al job object. |
| F3 | M | `App.tsx:3105`, `AgentSessionView`, `ChatBody` | Ogni chat montata (anche nascosta) rirenderizza a ogni cambio di App e a ogni chunk. → `memo` + callback stabili; chat nascoste flush a 500 ms. |
| F4 | M | `terminal/Terminal.tsx:432` | `stripAnsi` regex su ogni chunk pty prima del check `://`. → pre-check economico sul chunk grezzo. |
| F5 | M | `git/DiffView.tsx:78`, `remoteHosts.ts:162` | Poll DiffView senza guardia in-flight; mappe host non pulite al disaccoppiamento. → flag `busy`; pulizia in `setHosts`. |
| B4 | B | `browser_view.rs:857` | Cache favicon illimitata; `None` transitorio cachato per sempre. → `insert_bounded` + TTL per fallimenti. |
| B5 | B | `profiles.rs:162` | OpenCode ignora `XDG_CONFIG_HOME`/`XDG_DATA_HOME` su Linux. → rispettarli con fallback. |
| B6 | B | `vibe.rs:535,556` | `keyring_delete_key` senza timeout → logout Vibe può bloccarsi. → `keyring_output` con timeout. |
| B7 | B | `session.rs:128` | Salvataggio sessione copia tutto lo scrollback in un `Value` prima del check hash. → serializzare da riferimenti. |
| B8 | B | `chat/session.rs:189` | Ogni evento chat clonato ~4 volte sotto lock. → serializzare una volta, condividere. |
| B9 | B | `dictation/models.rs:230` | Download modello non si ferma oltre `model.size`. → abort se `done > size`. |
| B10 | B | `chat/state.rs:~120` | Allegati salvati su disco prima del gate `agent_busy` → retry riempiono la quota 256 MiB. → gate prima, o cancellare su errore. |
| B11 | B | `dictation/mod.rs` | `dictation_start` tiene il gate durante il caricamento modello → stop non risponde. → rilasciare il gate prima di attendere. |
| F7 | B | `chat/useChat.ts:531` | Dopo /clear gli owner browser-control dei delegati morti restano validi. → diff ed unregister. |
| F6, F8, F9, F10 | B | `browserStore.ts:366`, `storage.ts:100`, `App.tsx:1780`, `ChatBody.tsx:1026` | popupTimes/faviconCache non potati; write in updater React impuro; lookup O(sessioni×tab); `key={i}` nella coda messaggi. → fix puntuali. |

---

## Fase 4 — Mobile

| ID | Sev | Dove | Problema → Fix |
|---|---|---|---|
| M1 | M | `ChatScreen.tsx:217`, `shared/remoteChatSession.ts:70` | Ogni batch riduce fino a 4000 eventi + copia l'array. → activity incrementale in `applyEvents`. |
| M2 | M | `mobile/src/ChatMarkdown.tsx`, `shared/Markdown.tsx:139` | Markdown riparsato tutto a ogni chunk (quadratico). → blocchi completati memoizzati, si riparsa solo la coda. Vale anche per desktop. |
| M3 | M | `browser.css:19`, `browserDrag.ts`, `App.tsx:43` | Drawer browser anima `top`/`height` (anche nel drag); `--app-h` senza rAF → lag con tastiera. → `translateY` + rAF. |
| M4 | M | `Browser.tsx:20` | `CLOSE_MS 220` vs CSS 260 ms → scatto finale in chiusura. → `transitionend` con fallback. |
| M5 | M | `link-screen.css:4` | Aurora a tutto schermo anima `filter` all'infinito durante la riconnessione. → solo opacity, pausa dopo 10 s. |
| M6 | M | `ui.css:638`, `session-top.css:33`, `chat.css:179,3505` | `backdrop-filter` permanente su bottoni flottanti sopra lo scroll → ri-blur a ogni frame su WebView Android. → fondo quasi solido sul telefono (decisione visiva, vedi fondo). |
| M7 | M | `WidgetRender.kt`, `FinestraWidget.kt` | `goAsync().finish()` solo dopo 24 PNG per widget → rischio ANR al boot/resize. → `finish()` subito, debounce resize 300 ms. |
| M8 | B | `ChatScreen.tsx:327` | ResizeObserver non si attacca se `info` arriva dopo il mount. → `!!info` nelle deps. |
| M9 | B | `ConnectionService.kt:57`, `BackgroundPlugin.kt` | Flag `serviceStarted` stale → notifica che lampeggia a ogni resume. → flag statico pulito in `onDestroy`. |
| M10, M11 | B | `ChatBody.tsx`, `Files.tsx:113`… | Nessun `content-visibility` sulle turn; liste cartelle senza cap (node_modules). → `content-visibility:auto`; cap 300 righe + "mostra altri". |
| M12, M13 | B | vari CSS | Animazioni infinite su box-shadow/background-position/`left`; riga tray su `max-height`. → come Fase 2. |
| M14, M15 | B | `AgentInsight.tsx:141`, `ChatModelPicker.tsx:121` | `/compact` scritto ma non inviato se si esce subito; timer long-press non pulito. → fix puntuali. |

---

## Fase 5 — Pulizia

| ID | Valore | Cosa | Azione |
|---|---|---|---|
| C1 | M | ~150–250 righe CSS morte (agents-sidebar.css 28 selettori, wide-sidebar.css 17, chat.css desktop+mobile, altri) | Rimuovere dopo controllo classi costruite a template. |
| C2 | M | Export inutilizzati (knip): gitStatus.ts, control.ts, BrowserDownloads, delegateView, delegateStore, tipi | Togliere `export` o funzione. |
| C7, C9 | M | Path-link di ChatMarkdown duplicato desktop/mobile; `formatSize/formatBytes/formatTokens` ripetuti | Tokenizer puro in `shared/`, `shared/format.ts`. |
| C8/M16 | M | Pond CSS/tsx, ChatImage quasi copiati (R2/R3 della review precedente) | Parte pura in `shared/`. |
| M17 | B | `updater.rs` verifica firma copiata desktop/mobile (R1) | Modulo condiviso via `#[path]`. |
| C15, C16 | B | `now_ms()` copiato 3 volte; `#[allow(dead_code)]` da verificare | Usare `util::now_ms`; togliere attributi e vedere warning. |
| C3 | B | `window_focus_tab` mai invocato; `crash_simulate` | Rimuovere il primo, `cfg(debug_assertions)` sul secondo. |
| C4, C5 | B | ~10–30 chiavi i18n morte; falsi positivi knip | Script di controllo; `knip.json` aggiornato. |
| C12 | B | `qrcode` caricato eager | Lazy import in RemoteAccessSettings. |
| C10 | A (rischio alto) | `App.tsx` 3326 righe, `Shell()` ~2700 | Split a tappe: `useTabs`, `useAgentLaunch`, `useNewTabTransitions`, JSX in `TitleBar`/`SidebarHost`/`PanelsHost`/`TabContent`. Si sposa con F3/A2/A11. |

---

## Ordine di esecuzione proposto
1. Fase 1 (sicurezza) — piccole e isolate.
2. Fase 2.0 → 2.1 → 2.2 → 2.3 → 2.4 (motion system prima, poi pannelli che sono lo scatto più visibile).
3. Fase 3 backend (B1–B3 prima).
4. Fase 4 mobile.
5. Fase 5 pulizia; C10 per ultimo, a tappe con `tsc` a ogni passo.

Esecuzione: modifiche via sub-agenti con direttive precise, io rivedo. Nessun agente lancia cargo: una sola build/test alla fine di ogni fase (`cargo test`, `tsc` root+mobile, `vitest`). Commit per voce/gruppo su master. Kotlin non compilabile qui.

## Decisioni (2026-11-25)
- **S4** sì: il figlio delegato eredita la stessa modalità permessi del padre (mai più permissiva).
- **S6** no: si associano solo telefoni fidati.
- **M6** no: blur dei bottoni flottanti resta com'è.
- **A4** in attesa: artefatto `docs/design/busy-sweep-variants.html`, si implementa dopo la scelta.
- **C10** sì, in questo giro (ultima ondata).

## Ondate di esecuzione
1. Sicurezza (S1,S2,S3,S4,S5,S7) · Backend Rust (B1–B11) · Motion desktop (Fase 2 tranne A4) · Mobile (Fase 4 tranne M6) — in parallelo, file disgiunti.
2. Frontend desktop (F3–F10) · Pulizia (Fase 5 tranne C10).
3. C10 split App.tsx.

## Esito
Tutto su master, non pushato, non provato nell'app né sul telefono. Verifiche: cargo test desktop 555 + mobile 47, tsc root+mobile, vitest 1162. Kotlin non compilato.

| Commit | Contenuto |
|---|---|
| 90db46d | piano + artefatti |
| 6f6439f | Fase 1: S3, S4, S7, S1 parziale (Referer check + porte bloccate). S2 già coperto lato host. S5 non fatto (shim leggono il token dall'env). |
| 1a02f55 | Fase 3 backend B1–B11 (B8 parziale) |
| 597d77d | Fase 4 mobile M1–M5, M7–M15 (M13 parziale) |
| 6158467 | Fase 2 motion tranne sweep A4 (A13/A14 parziali) |
| e5465bc | Fase 3 frontend F3–F10 |
| c2cf0db | Fase 5 pulizia (C9 parziale; C16, M17, ChatImage saltati) |
| fda50c8 | C10 split App.tsx 3363 → 515 righe |

Aperti: A4 scia (artefatto `busy-sweep-variants.html`), S1 origin per porta, S5, nuova funzione "solo pannello" (`panel-focus-variants.html`).
