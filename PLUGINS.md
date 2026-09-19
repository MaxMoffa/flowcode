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
  | "commandOutput";  // esegue `command` senza terminale (niente stdin) e ne mostra l'output in un popup

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

## Codex CLI / Claude Code: un caso a parte

I due plugin "Codex CLI" e "Claude Code" installati automaticamente al primo
avvio sono manifest normalissimi (`action: "runCommand"`, avviano la CLI nel
terminale al click) - non c'è nulla di speciale nel file `.json` in sé, si
possono eliminare o clonare come qualsiasi altro plugin.

Quello che **non** fa parte dello standard è il popup di stato account che
appare passando il mouse sull'icona nella barra delle scorciatoie: è logica
scritta apposta per questi due `id` (`src/plugins/usage.ts`), non qualcosa
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

## Pannello "Agenti attivi"

`toggleAgentsSidebar` mostra/nasconde un pannello a destra (stessa
dimensione/struttura del file explorer a sinistra) con l'elenco delle tab
terminale che hanno in corso un processo `claude` o `codex` riconoscibile
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
