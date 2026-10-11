# Revisione accesso remoto — 11/10/2026

Quattro revisioni indipendenti in sola lettura del branch `feature/remote-access`
(sicurezza, bug app mobile, bug/prestazioni desktop, qualità del codice).
Nulla è ancora stato implementato: è l'elenco da valutare.

Legenda: **[V]** verificato a mano nel codice · **[P]** plausibile, da confermare a runtime ·
gravità A (alta) / M (media) / B (bassa) · sforzo S / M / L.

## 1. Da fare prima del rilascio

| # | Area | Problema | Dove | Fix proposto | Sforzo |
|---|---|---|---|---|---|
| 1 | Bug A [V] | Il blocco biometrico smette di funzionare dopo aver aperto Impostazioni: il listener `visibilitychange` è condiviso e lo smontaggio di Settings lo rimuove per tutti | `mobile/src/applock.ts:83-84` | Registrare il listener una volta a livello di modulo, mai rimuoverlo | S |
| 2 | Bug M [V] | Panic della task di connessione: il `JoinHandle` del writer viene interrogato due volte se il writer finisce per primo (`select!` + timeout finale) | `src-tauri/src/remote.rs:1171,1184` | Flag `writer_done`, saltare il secondo poll | S |
| 3 | Sicurezza M | Code illimitate: un telefono lento o malevolo che smette di leggere fa crescere la RAM del PC senza limite (output pty, `out_tx`, `input_tx`) | `src-tauri/src/pty.rs` (subscriber remoto), `remote.rs:1075,1093,1115` | Canali limitati; se pieni, scartare l'output e reinviare uno snapshot, o disconnettere | M |
| 4 | Sicurezza M | Deep link `flowcode://pair` collega subito il telefono a qualsiasi PC (anche di un attaccante) senza conferma; il link resta in `pending_link` e scatta dopo uno scollegamento | `mobile/src/Pairing.tsx:56-63`, `mobile/src-tauri/src/lib.rs` (`pending_link`) | Schermata "Collegare a «host»?" con impronta del nodo; ignorare/scadere i link quando già collegato | S |
| 5 | Sicurezza M | Anteprima nel task switcher di Android mostra il terminale; manca `FLAG_SECURE` | `MainActivity.kt`, `applock.ts` | `FLAG_SECURE` + schermata vuota appena l'app va in background | S |
| 6 | Sicurezza M | Quoting POSIX dei percorsi (`'\''`) su shell Windows: "cd qui" con Invio automatico può eseguire comandi da nomi di cartella malevoli | `mobile/src/TermFiles.tsx:10-12,115-121` | Il desktop comunica il dialetto della shell (c'è già `shellDialect.ts`); niente Invio automatico o rifiuto di caratteri speciali | M |
| 7 | Bug M [P] | Byte persi sul telefono se si apre un terminale mentre sta scrivendo: lo snapshot usa il seq ricevuto, non quello già disegnato | `src/terminal/Terminal.tsx` (`snapshotForRemote`, `lastSeqRef`), `remote.rs:1367` | Seq aggiornato nel callback di `term.write` | M |
| 8 | Bug M [P] | Risposte doppie alle query del terminale (DSR, DA, colori): rispondono sia lo xterm del PC sia quello del telefono → testo spurio tipo `^[[24;1R` nel prompt | `mobile/src/TerminalScreen.tsx` (`term.onData`) | Ignorare `onData` mentre si scrive output remoto | S |
| 9 | Bug M | Tasto Indietro di Android chiude l'app invece di chiudere terminale/pannelli | tutto `mobile/src` | Voce di history o hook back-button di Tauri | M |
| 10 | Bug M | Il pannello "Connessione persa" si rimonta entrando/uscendo dal terminale e ricompare dopo essere stato chiuso | `mobile/src/App.tsx` (due posizioni di `<Reconnect/>`) | Montarlo una sola volta in posizione stabile | S |

## 2. Importanti

| # | Area | Problema | Dove | Fix proposto | Sforzo |
|---|---|---|---|---|---|
| 11 | Sicurezza M | 16 slot di handshake occupabili da chiunque conosca il node id (DoS del proprio telefono); contatore incrementato dopo lo spawn | `remote.rs:898-925,1031-1035` | Incremento prima dello spawn, timeout pre-auth 3-5 s, slot riservati ai node id noti | M |
| 12 | Bug M | Utilizzo non aggiornato con la finestra desktop minimizzata (caso tipico col telefono connesso) | `src/plugins/useUsageState.ts` (timer con check visibilità) | I retain del telefono ignorano la visibilità | S |
| 13 | Prestazioni M | Con telefono connesso si sondano tutti i plugin (anche CLI non installate) e in ogni finestra | `src/plugins/remotePublish.ts:79-83`, `App.tsx` | Solo plugin attivi/fissati, da una sola finestra "leader" | S |
| 14 | Bug M | Più finestre si sovrascrivono utilizzo/impostazioni/azioni; le impostazioni terminale non si sincronizzano tra finestre (niente evento `storage`) | `remotePublish.ts`, `RemoteSettingsBridge.tsx`, `TerminalSettingsContext.tsx` | Pubblicare da una finestra leader; sync `storage` per le impostazioni terminale | M |
| 15 | Bug M [P] | Un errore temporaneo del Keystore rigenera la chiave del telefono → pairing perso | `mobile/src-tauri/src/store.rs` (`load_or_create_key`) | Rigenerare solo su errore definitivo, altrimenti riprovare | S |
| 16 | Bug M | `pair()` fallito o doppio lascia lo stato "non collegato" e ferma la riconnessione anche con pairing valido | `mobile/src-tauri/src/lib.rs` (`pair`), `Pairing.tsx` | Guardia "in corso", riavvio del loop se il pairing esiste | S |
| 17 | Bug B/M | Snapshot limitato in byte grezzi, non in JSON: scrollback colorato supera 1 MiB e viene scartato in silenzio | `remote.rs:1321-1331` | Limitare sulla lunghezza codificata, tagliare a fine riga | S |
| 18 | Bug B/M [P] | Pty con dimensione sbagliata se la scheda si sposta tra finestre mentre è aperta sul telefono | `remote.rs:705-714`, `Terminal.tsx` | Reinviare l'override di dimensione alla nuova finestra | M |
| 19 | Sicurezza B | Dialog di conferma: nome dispositivo non troncato prima di dialog/notifica, nessuna impronta per riconoscere il telefono giusto, dialog che resta aperto dopo il timeout | `remote.rs:987-1025`, `RemotePairConfirm.tsx` | Troncare a 64, mostrare un codice/impronta su entrambi gli schermi, evento di annullamento | S |
| 20 | Sicurezza B | Il codice di pairing resta valido 5 min anche chiudendo il dialog del QR | `RemoteAccessSettings.tsx:52-70` | Comando `remote_pair_cancel` alla chiusura | S |
| 21 | Bug B/M | Impostazioni: l'eco del desktop sovrascrive tocchi rapidi (stepper +++ torna indietro); slider invia due volte | `mobile/src/remote.ts` (`setSetting`), `Settings.tsx` (`Slider`) | Ignorare eco per chiavi in attesa; `onPointerCancel`, togliere `onTouchEnd` | S |
| 22 | Robustezza B | Impostazioni in cache non validate: un desktop malevolo o una versione vecchia possono far crashare l'app a ogni avvio | `mobile/src/remote.ts`, `theme.ts`, `Settings.tsx` | Validare/unire con default + error boundary | S |

## 3. Minori

- Azione rapida dal telefono eseguita sulla scheda sbagliata (ritardo fisso 80 ms) — `src/App.tsx` remoteActionRef.
- Polling processi ogni 2 s per connessione anche col telefono inattivo (cache 1,5 s < tick) — `remote.rs:1146`.
- Un `pty.write` bloccato ferma l'input verso tutti i terminali dello stesso telefono — `remote.rs:1115-1122`.
- Voci `sizing`/`subs` che restano dopo la fine di uno stream; nessun limite di `open` per connessione — `remote.rs:662-672,1224-1241`.
- Bridge impostazioni ricalcola e pubblica a ogni zoom di scheda; `set` dal telefono senza limite di dimensione — `RemoteSettingsBridge.tsx`, `remote.rs:1275`.
- Utilizzo che sparisce dal telefono a un singolo errore di lettura — `remotePublish.ts:45-47`.
- Reader/connessione non chiusi quando il loop viene abortito (scollega/ricollega) — `mobile/src-tauri/src/lib.rs`.
- `ls` su una cartella symlink resta in "Caricamento" — `TermFiles.tsx`.
- Blocco: appare subito dopo il primo pairing; telefoni con solo PIN non bloccati.
- Pulsante tastiera desincronizzato dopo Indietro; resize del pty a raffica durante l'animazione della tastiera (debounce 150 ms).
- Ctrl/Shift armati + frecce/Tab non applicati; frecce sempre CSI anche in application-cursor mode; "Sì" invia `1` (va bene solo per Claude).
- Toast nascosto sotto il pannello di riconnessione e sopra la barra tasti.
- `retry_now`: permesso residuo che salta un backoff (finestra di pochi ms).
- Zoom con le dita disabilitato (`user-scalable=no`), alcune `aria-label` in inglese.
- File remoti: elencati i symlink verso fuori dalla radice (solo esistenza); nessun filtro per `.env`, chiavi, ecc.
- Nessun rate limit su `auth` (solo flood di log/CPU, il token è a 256 bit).
- Chiave nodo del desktop in chiaro (su Windows solo ACL del profilo) → DPAPI.
- `file_paths.xml` del FileProvider più ampio del necessario.
- Documentazione del protocollo: `set` con palette sconosciuta reimposta il default (doc dice "ignorato"); "dispositivo revocato" chiude senza frame `error`.

**Scartato:** "il blocco si può disattivare senza autenticarsi" — falso, Impostazioni richiede già lo sblocco.

## 4. Refactor e pulizia

| # | Cosa | Dove | Sforzo |
|---|---|---|---|
| R1 | Tipi del protocollo copiati a mano in 3 posti; `MirroredSettings` tipizzato solo sul telefono → file TS condiviso (o generazione con `ts-rs`/`specta`) e chiavi `set` come unione di stringhe | `remote-proto/src/msg.rs`, `mobile/src/remote.ts`, `src/plugins/remotePublish.ts`, `RemoteSettingsBridge.tsx` | M |
| R2 | Bundle mobile > 500 kB per xterm: `lazy()` per `TerminalScreen` (e Settings/Reconnect) | `mobile/src/App.tsx` | S |
| R3 | `serve()` di 170 righe e `Conn::handle` lungo → estrarre handshake, spawn writer/reader/input, helper per i tre watch | `remote.rs` | M |
| R4 | `TerminalScreen` 342 righe → hook `useTerminal`, `useModifiers`, componente `KeyBar`, tasti da array | `mobile/src/TerminalScreen.tsx` | M |
| R5 | Bridge impostazioni: tabella unica `SETTING_DEFS` (valore pubblicato + setter + validatore) e test | `RemoteSettingsBridge.tsx` | S |
| R6 | CSS: classe/token condivisi per pannelli in vetro, un solo segmented, `--safe-bottom` | `ui.css`, `terminal.css`, `reconnect.css` | M |
| R7 | Icone: unire `termIcons.tsx` in `icons.tsx`, `Svg` con `size`/`strokeWidth` | `mobile/src/` | S |
| R8 | Helper colore duplicati desktop/telefono (`mix`, `alpha`) → `color.ts` condiviso con test; grana generata da funzione | `mobile/src/theme.ts`, `src/themes/palettes.ts` | S |
| R9 | Store esterni duplicati (`remote.ts`, `applock.ts`) → riuso di `src/lib/externalStore.ts`; helper `safeStorage` | `mobile/src/` | S |
| R10 | Codice morto: chiavi i18n inutilizzate (`appName`, `needTerminal`, `noTarget`, `perPeriod`, `run`, `scanning`, `tab`, `target`, `typeHere`), CSS (`.stack.tight`, `.row-icon`, `.icon-btn`, `.w3`); `en` tipizzato come `Record<Key,string>` | `mobile/src/i18n.ts`, `ui.css` | S |
| R11 | Rust mobile: `status`/`phase` come enum, `set_phase` con 7 argomenti → builder, `connect_once()` estratto, backoff come funzione pura testata | `mobile/src-tauri/src/lib.rs` | S |
| R12 | `remote_publish_*` con corpo identico → helper `publish()`; costante nominata per `MAX_FRAME / 2` | `remote.rs:854-886` | S |
| R13 | Quoting shell duplicato e senza test; due funzioni di accorciamento percorso | `TermFiles.tsx`, `TerminalScreen.tsx`, `common.tsx` | S |
| R14 | Re-render inutili: `useRemote()` intero nel terminale, `sort` in render in Agents, `setLanguage` nel render | `mobile/src/` | S |
| R15 | Test mancanti: colori, quoting, `setSetting`, validatori del bridge, coalescenza utilizzo | — | M |

## Fatto bene (dalla revisione di sicurezza)

Pairing monouso con scadenza e rate limit, conferma sul desktop, token a 256 bit salvati come hash e confrontati a tempo costante, legati al node id; revoca che chiude le connessioni; frame limitati a 1 MiB e input a 64 KiB; `confine()` corretto contro `..` e symlink; allowlist e controllo di tipo sulle impostazioni dal telefono; azioni validate contro quelle pubblicate; nessun `innerHTML` con dati non fidati; CSP restrittiva in entrambe le webview; segreti del telefono sigillati nel Keystore, backup disattivato.
