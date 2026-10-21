# Standard dei plugin di Flowcode

Un plugin di Flowcode è un **file JSON dichiarativo**, non codice. Il campo
`action` seleziona una di un piccolo insieme fisso di cose che l'app sa già
fare: un plugin non può eseguire nulla che l'app non implementi già, quindi
installarne uno scritto da altri non è un rischio di esecuzione di codice
arbitrario, a differenza di un'estensione browser tradizionale basata su JS.

## Dove va il file

I plugin vivono nella cartella di configurazione dell'app:

- Linux: `~/.config/com.maxmoffa.flowcode/plugins/`
- macOS: `~/Library/Application Support/com.maxmoffa.flowcode/plugins/`
- Windows: `%APPDATA%\com.maxmoffa.flowcode\plugins\`

Ogni plugin è un file `<id>.json`. Il nome del file deve corrispondere al
campo `id` del manifest (viene comunque forzato dall'app al salvataggio).
La cartella viene creata automaticamente al primo avvio.

Dopo aver aggiunto/modificato/rimosso un file, riapri la pagina
**Impostazioni → Funzionalità** per ricaricare l'elenco. Per i casi semplici
non serve toccare i file a mano:

- **"+ Nuovo plugin"** apre un modulo guidato per i casi base (un comando, o
  un popup).
- **"Importa da file"** carica un file `.json` scritto a mano (o scaricato
  da altrove) senza doverlo copiare manualmente nella cartella dei plugin -
  è il modo per installare un plugin "avanzato" (dialog con più pulsanti,
  output dinamico da comando) che il modulo guidato non copre.

## Schema del manifest

```ts
interface PluginManifest {
  id: string;            // identificativo univoco (solo lettere/numeri/-/_)
  label: string;         // nome mostrato nella barra e nel menu Funzionalità
  description?: string;  // sottotitolo mostrato nella tabella Funzionalità
  action: PluginAction;  // vedi sotto
  command?: string;      // solo per action = "runCommand"
  message?: string;      // solo per action = "notify" | "dialog"
  title?: string;        // solo per action = "dialog" (default: label)
  buttons?: PluginButton[]; // solo per action = "dialog"
  icon?: string;         // valore `d` di un singolo <path> SVG (facoltativo)
}

type PluginAction =
  | "newTerminal"          // apre una nuova tab terminale
  | "clearTerminal"        // pulisce il terminale attivo
  | "toggleSidebar"        // mostra/nasconde il pannello laterale (file explorer) a sinistra
  | "toggleAgentsSidebar"  // mostra/nasconde il pannello "Agenti attivi" a destra
  | "runCommand"      // digita `command` nel terminale attivo, come se l'utente l'avesse scritto
  | "notify"          // mostra `message` in un popup (toast) temporaneo
  | "dialog"          // apre un dialog con `title` + `message` e i pulsanti `buttons`
  | "commandOutput"  // esegue `command` senza terminale (niente stdin) e ne mostra l'output in un popup
  | "openInVsCode";  // apre la cartella del terminale attivo in VS Code (se installato)

interface PluginButton {
  label: string;
  action: Exclude<PluginAction, "dialog">; // i dialog non si annidano
  command?: string;   // se action = "runCommand" | "commandOutput"
  message?: string;   // se action = "notify"
}
```

`commandOutput` è pensata per plugin che mostrano informazioni *dinamiche*
(stato di un servizio, limiti di utilizzo di una CLI, versione installata...)
invece di un testo fisso: l'output combinato di stdout+stderr del comando
diventa il testo del popup risultato. Il comando gira senza stdin, quindi un
comando che aspetta input interattivo fallisce subito invece di restare
bloccato - va scelto un comando non interattivo (es. `codex login status`,
non `codex login`).

Un dialog mostra sempre anche un pulsante "Chiudi" aggiunto automaticamente
dall'app, oltre a quelli elencati in `buttons`.

## Esempi

### Comando rapido

```json
{
  "id": "avvia-test",
  "label": "Avvia i test",
  "description": "Esegue la suite di test del progetto",
  "action": "runCommand",
  "command": "npm test"
}
```

### Popup informativo

```json
{
  "id": "promemoria-deploy",
  "label": "Checklist deploy",
  "action": "notify",
  "message": "Ricorda: aggiorna il changelog prima di taggare la release."
}
```

### Dialog con pulsanti che agiscono sul terminale

```json
{
  "id": "gestione-servizio",
  "label": "Servizio web",
  "description": "Avvia, ferma o controlla lo stato del servizio locale",
  "action": "dialog",
  "title": "Servizio web",
  "message": "Cosa vuoi fare?",
  "buttons": [
    { "label": "Avvia", "action": "runCommand", "command": "npm run start" },
    { "label": "Stato", "action": "runCommand", "command": "curl -s localhost:3000/health" },
    { "label": "Fatto", "action": "notify", "message": "Operazione completata." }
  ]
}
```

### Dialog con output dinamico da comando

```json
{
  "id": "stato-servizio",
  "label": "Stato servizio",
  "description": "Controlla se il servizio locale risponde",
  "action": "dialog",
  "title": "Stato servizio",
  "message": "Cosa vuoi vedere?",
  "buttons": [
    { "label": "Versione installata", "action": "commandOutput", "command": "node --version" }
  ]
}
```

## Codex CLI / Claude Code / Mistral Vibe: un caso a parte

I plugin "Codex CLI", "Claude Code" e "Mistral Vibe" installati automaticamente al primo
avvio sono manifest normalissimi (`action: "runCommand"`, avviano la CLI nel
terminale al click) - non c'è nulla di speciale nel file `.json` in sé, si
possono eliminare o clonare come qualsiasi altro plugin.

Quello che **non** fa parte dello standard è il popup di stato account che
appare passando il mouse sull'icona nella barra delle scorciatoie: è logica
scritta apposta per questi `id` (`src/plugins/usage.ts`), non qualcosa
che un manifest JSON può descrivere.

- **Claude Code**: `claude -p "/usage"` - "/usage" è uno slash command
  gestito lato client (nessuna chiamata al modello, nessun costo), lo stesso
  disponibile in una sessione interattiva; `-p` lo esegue e ne stampa il
  testo invece di renderlo in TUI. L'output è testo semplice con righe tipo
  `Current session: 52% used · resets Sep 19, 12am (Europe/Rome)`, parsate
  con una regex. "Current session" è la finestra di 5 ore - è la percentuale
  che riempie la mini barra nella barra delle scorciatoie.
- **Codex CLI**: non esiste un flag/comando non interattivo equivalente
  (`codex exec "/status"` passa il testo al modello come prompt letterale,
  non esegue lo slash command lato client - verificato, produce un errore
  di credito/costo invece dei dati). `/status` esiste solo dentro la TUI
  interattiva, quindi `src/plugins/codexStatus.ts` pilota una sessione
  `codex` invisibile e usa a `@xterm/headless` per leggere lo schermo
  renderizzato dopo aver inviato `/status` (stesso meccanismo pty dei tab
  terminale veri, nessun DOM). La sessione viene chiusa subito dopo aver
  letto i dati - non resta mai in background.
- **A consumo (chiave API)**: Claude Code e Codex possono girare anche su
  una chiave API invece che su un abbonamento - allora non hanno limiti da
  mostrare. Prima di ogni aggiornamento del popup Flowcode chiede alla CLI
  come è collegata (`claude auth status`: `authMethod` `claude.ai` =
  abbonamento, altro o un provider cloud = a consumo; `codex login status`:
  "ChatGPT" = abbonamento, "API key" = a consumo) e in modalità a consumo
  mostra la spesa invece dei limiti: token di ogni chiamata letti dai
  transcript locali (`~/.claude/projects/**/*.jsonl`, `usage` dei messaggi;
  `~/.codex/sessions/**/rollout-*.jsonl`, eventi `token_count`) e moltiplicati
  per i prezzi di listino (`src-tauri/src/spend.rs`). È una stima: prezzi
  negoziati, Bedrock/Vertex e sessioni su altri computer non sono inclusi.
  I file sono letti in modo incrementale (solo le righe nuove).
- **Mistral Vibe**: si paga a token su una chiave API di Mistral, non ha
  limiti di utilizzo da mostrare. Il popup mostra invece la spesa (oggi,
  ultimi 7 e 30 giorni: costo, token, sessioni) sommando i `meta.json` che
  Vibe salva per ogni sessione in `~/.vibe/logs/session/`
  (`src-tauri/src/vibe.rs`) - nessun processo avviato, nessuna chiamata di
  rete. Prima di ogni avvio Flowcode registra Mistral Large 4 in
  `~/.vibe/config.toml` (con prezzi e contesto da 1M) e lo rende il modello
  attivo, a meno che l'utente non ne abbia già scelto un altro.

## Pannello "Agenti attivi"

`toggleAgentsSidebar` mostra/nasconde un pannello a destra (stessa
dimensione/struttura del file explorer a sinistra) con l'elenco delle tab
terminale che hanno in corso un processo `claude`, `codex` o `vibe` riconoscibile
nell'albero dei processi della loro shell (`src-tauri/src/agents.rs`,
comando `list_agent_sessions`). È rilevamento onesto, non introspezione
della CLI: mostra quale CLI gira, in quale tab, da quanto tempo - non uno
stato "sta pensando/aspetta input" (richiederebbe leggere lo schermo di ogni
tab in continuo) né una gerarchia "orchestratore/agenti figli" (concetto
interno di Claude Code, non esposto da nessuna API pubblica). Doppio click
su una riga passa a quella tab.

## Icona (facoltativa)

`icon` è il valore `d` di un singolo elemento SVG `<path>`, disegnato in un
riquadro `viewBox="0 0 24 24"` a stroke fisso. Non è consentito incollare
SVG/HTML arbitrari: solo i dati del path, per la stessa ragione di sicurezza
alla base dell'intero standard. Se omessa, viene usata un'icona generica.

## Attivazione/disattivazione ed eliminazione

Nella pagina **Impostazioni → Funzionalità** ogni plugin (di base o
personalizzato) ha un interruttore che lo aggiunge/rimuove dalla barra delle
scorciatoie in alto. I plugin di base (quelli inclusi con l'app) non possono
essere eliminati, solo disattivati. I plugin personalizzati si possono
eliminare dalla stessa pagina.

## Apri in VS Code

`openInVsCode` apre in Visual Studio Code la cartella del terminale attivo
(quella in cui si trova la shell, o quella del file explorer se la shell
non l'ha ancora comunicata). Il backend (`open_in_vscode` in
`src-tauri/src/plugins.rs`) cerca VS Code prima nel PATH e poi nelle
cartelle di installazione standard; se non lo trova, mostra un avviso invece
di non fare nulla. Una cartella dentro WSL si apre tramite il remote WSL di
VS Code (`--remote wsl+<distro>`), come `code .` digitato nella shell WSL.
Le sessioni remote (ssh) non sono supportate.

## Viste agente (plugin di tipo agentView)

Una **vista agente** è un modo alternativo di mostrare la conversazione con un
agente: compare nel menu della sessione ("Visualizza come") accanto a Chat e
Terminale. A differenza dei plugin descritti sopra, che sono JSON dichiarativi,
una vista **è codice** (HTML + JavaScript) e gira dentro Flowcode, ma isolata:
in un iframe con `sandbox="allow-scripts"`, senza accesso alla pagina
dell'app, a internet o ai file dell'utente. Parla con la sessione solo
attraverso il protocollo qui sotto, e solo per le azioni che il manifest
dichiara e che l'utente ha accettato installandola.

Un punto fermo: **le richieste di permesso degli agenti le gestisce sempre
Flowcode**, con i propri pulsanti disegnati fuori dall'iframe (sopra la vista).
Il protocollo non ha nessun messaggio per rispondere a un permesso: una vista
non può né approvarlo né rifiutarlo.

### Cartella e installazione

Una vista è una cartella:

```
hello-view/
  manifest.json
  index.html       (l'`entry`)
  view.js, ...     (script, stili, immagini: tutto dentro la cartella)
```

Si installa da **Impostazioni → Funzionalità → Viste agente → "Installa
vista…"**, scegliendo la cartella. Prima dell'installazione Flowcode mostra
nome, autore, versione e permessi richiesti; se esiste già una vista con lo
stesso `id` chiede se sovrascriverla. Le viste installate vivono in
`<cartella plugin>/views/<id>/` (la cartella dei plugin è quella indicata in
"Dove va il file"); si eliminano dalla stessa pagina. Il menu della sessione si
aggiorna subito, senza riavviare. Un punto di partenza pronto è in
`docs/agent-views/hello-view` (protocollo a mano, nessuna libreria); la vista
completa di riferimento è `docs/agent-views/timeline`.

### SDK

Per non riscrivere handshake e ricostruzione della conversazione,
`docs/agent-views/sdk/` contiene una piccola libreria senza dipendenze
(`flowcode-view.iife.js`, oppure il modulo ES `flowcode-view.js`, più i tipi):
`connect()` fa l'handshake e tiene il modello della chat aggiornato dagli
eventi, `client.send/cancel/openFile/can` fanno le richieste. Una vista ne porta
con sé una copia. Uso e API in `docs/agent-views/sdk/README.md`; si rigenera con
`npm run build:view-sdk`. La vista **Timeline** (`docs/agent-views/timeline`) la
usa ed è l'esempio completo: piano fissato, eventi con orario, diff, file
cliccabili, coda dei messaggi.

### Manifest

```ts
interface ViewPluginManifest {
  id: string;            // identificativo univoco (lettere/numeri/-/_), uguale al nome della cartella
  kind: "agentView";
  apiVersion: 1;         // versione del protocollo bridge
  label: string;         // nome nel menu della sessione
  labels?: Record<string, string>; // traduzioni di label per lingua dell'interfaccia ("it", "en")
  description?: string;
  version?: string;
  author?: string;
  entry: string;         // file HTML di partenza, relativo alla cartella
  transport: "acp";      // la vista mostra una chat ospitata dall'app
  devices: ("desktop" | "tablet" | "phone")[]; // dove viene offerta
  permissions: ("send" | "cancel" | "setMode" | "openFile")[];
}
```

### Permessi

| Permesso   | Cosa consente | Come lo vede l'utente |
|------------|---------------|-----------------------|
| `send`     | `send`: invia un messaggio all'agente (passa dalla coda dei messaggi, come dalla chat) | "Invia messaggi all'agente" |
| `cancel`   | `cancel`: interrompe il turno in corso | "Interrompe l'agente" |
| `setMode`  | `setMode`: cambia la modalità della sessione | "Cambia modalità" |
| `openFile` | `openFile`: apre un file del progetto in un editor | "Apre file del progetto" |

`switchView` non richiede nessun permesso. Una richiesta senza il permesso
corrispondente riceve un messaggio `error` con `code: "permission_denied"`.

### Limiti dell'iframe

I file della vista sono serviti da uno schema dedicato con una
Content-Security-Policy rigida: **niente rete** (`fetch`, `XMLHttpRequest`,
WebSocket non escono), **niente risorse esterne** (script, stili, font, immagini
devono stare nella cartella o essere `data:`), **niente frame**. L'origine della
pagina è opaca (sandbox senza `allow-same-origin`): niente `localStorage` né
cookie condivisi con l'app. Niente popup, form, navigazione della pagina
principale. Lo sfondo dell'iframe è trasparente: sotto c'è quello dell'app.

### Protocollo bridge v1

**Handshake.** La vista manda alla finestra padre

```js
window.parent.postMessage({ type: "flowcode:hello", apiVersion: 1 }, "*");
```

Flowcode accetta il messaggio solo se arriva dall'iframe della vista, crea un
`MessageChannel` e risponde (a `window`) con `{ type: "flowcode:connect",
apiVersion: 1 }` allegando la porta: la vista la prende da `event.ports[0]` e da
quel momento **tutto passa dalla porta**. Un secondo `hello` (la vista si è
ricaricata) sostituisce il canale precedente. Se entro 10 secondi la vista non
si presenta, Flowcode mostra "La vista non risponde" con un pulsante per tornare
alla chat. La vista deve mettere `onmessage` sulla porta subito: i messaggi
inviati prima restano in coda.

**Host → vista**

| Messaggio | Contenuto |
|-----------|-----------|
| `init` | `apiVersion`, `viewId`, `session` (`agent`, `agentLabel`, `cwd`, `sessionId`, `title`), `modes` (`{ currentModeId, availableModes[] }` o `null`), `permissions` (quelli concessi), `locale` (`it`/`en`), `device` (`desktop`, `tablet` o `phone`), `insets` (facoltativo, `{ top, right, bottom, left }` in px: aree non sicure dello schermo), `theme`. Un nuovo `init` significa una nuova conversazione: la vista scarta quello che sapeva. |
| `events` | `events`: array di eventi grezzi del backend (`kind`: `update`, `user`, `permission`, `permissionResolved`, `turnEnd`, `error`, `exit`; vedi `src/chat/chatTypes.ts`), ognuno con `seq` e `at`. Prima arriva l'intera cronologia, poi i lotti dal vivo; ogni `seq` arriva una volta sola. `at` (epoch ms) è il momento in cui Flowcode ha *ricevuto* l'evento, non quello in cui è avvenuto: in una sessione ripresa la cronologia riprodotta porta tutta l'ora della ripresa. `update.update` è l'oggetto ACP `session/update` (es. `sessionUpdate: "agent_message_chunk"` con `content.text`). |
| `status` | `status` (`starting`, `idle`, `busy`, `waiting`, `exited`), `queued` (messaggi in coda), `currentModeId`. Inviato a ogni cambiamento. |
| `theme` | `theme`: inviato quando cambia il tema dell'app. |
| `error` | `code` (`permission_denied` o `bad_request`) e `request` (il `type` della richiesta rifiutata). |

`theme` è `{ scheme: "dark" | "light", tokens: Record<string, string> }`. I
token sono proprietà CSS già risolte: la vista le applica a `:root`
(`document.documentElement.style.setProperty(nome, valore)`) e usa `var(--fg)`
ecc. Elenco fisso:

| Token | Significato |
|-------|-------------|
| `--fg` | testo |
| `--fg-muted` | testo secondario |
| `--bg-elevated` | superficie (può essere semitrasparente) |
| `--sidebar-hover` | superficie leggera, per hover e chip |
| `--border` | bordi |
| `--accent` | colore di accento |
| `--accent-2` | accento secondario |
| `--danger` | errori, azioni distruttive |
| `--warning` | avvisi |
| `--info` | informazioni |
| `--font-ui` | font dell'interfaccia |
| `--font-mono` | font a spaziatura fissa |

**Vista → host** (sulla porta; ogni messaggio è validato, quelli di tipo
sconosciuto sono ignorati)

| Messaggio | Permesso | Effetto |
|-----------|----------|---------|
| `{ type: "send", text }` | `send` | invia `text` all'agente (in coda se un turno è in corso) |
| `{ type: "cancel" }` | `cancel` | interrompe l'agente |
| `{ type: "setMode", modeId }` | `setMode` | cambia modalità |
| `{ type: "openFile", path }` | `openFile` | apre il file in un editor; `path` è relativo a `session.cwd` o assoluto, e deve stare dentro la cartella del progetto (altrimenti `permission_denied`) |
| `{ type: "switchView", viewId }` | nessuno | mostra la sessione con un'altra vista (es. `chat`) |

Una richiesta con forma sbagliata riceve `error` con `code: "bad_request"`.

### Cosa resta a Flowcode

Fuori dall'iframe, dove la vista non arriva né può cliccare, Flowcode disegna:
la barra della **richiesta di permesso** dell'agente (titolo dello strumento e
un pulsante per opzione), lo stato **"L'agente si è chiuso"** con il pulsante
Riavvia, e la schermata di errore se la vista non si presenta. La vista riceve
comunque gli eventi `permission` e `permissionResolved` e può mostrarli, ma non
può rispondere.
