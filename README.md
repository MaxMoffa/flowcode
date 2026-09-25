<p align="center">
  <img src="public/flowcode-icon.svg" alt="Flowcode" width="128" height="128">
</p>

<h1 align="center">Flowcode</h1>

<p align="center">
  Il terminale desktop che tiene insieme shell, file e agenti AI — senza farti uscire dal flusso.
  <br>
  Windows · macOS · Linux
</p>

<p align="center">
  <a href="https://github.com/MaxMoffa/flowcode/releases/latest">Scarica l'ultima versione</a> ·
  <a href="PLUGINS.md">Crea un plugin</a> ·
  <a href="LICENSE">Licenza Apache 2.0</a>
</p>

---

## La filosofia

Oggi si lavora sempre di più **nel terminale**: si lancia una build, si apre Claude Code o Codex, si
salta tra cartelle, si ritocca un file di configurazione. Di solito questo vuol dire tenere aperte
quattro finestre diverse — terminale, file manager, editor, browser per controllare i limiti di
utilizzo — e perdere il filo a ogni cambio.

Flowcode parte da un'idea semplice: **il terminale è il centro, tutto il resto gli gira attorno.**

- **Una cartella, un contesto.** Il file explorer e l'editor seguono la cartella del terminale
  attivo, anche dentro WSL. Fai `cd`, e il resto dell'app ti viene dietro.
- **Gli agenti AI sono di casa.** Claude Code e Codex CLI non sono "un programma qualsiasi nella
  shell": Flowcode li riconosce, li mostra in un pannello dedicato e ti fa vedere quanto utilizzo
  ti resta.
- **Leggero e nativo.** Costruito su Tauri, non su Electron: si installa in un attimo, parte subito
  e usa poca memoria.
- **Estendibile senza rischi.** I plugin sono file JSON dichiarativi, non codice: puoi installare
  quello di un collega senza preoccuparti di cosa esegue.
- **Riprendi da dove avevi lasciato.** Schede, cartelle e output tornano al loro posto alla
  riapertura, e le tue impostazioni sopravvivono agli aggiornamenti.

## Cosa puoi fare

| | |
|---|---|
| 🗂️ **Terminale a schede** | Più sessioni in parallelo, trascinabili tra finestre diverse, raggruppate in automatico quando non entrano nella barra. Zoom del testo per singola scheda. |
| 📁 **File explorer laterale** | Naviga, cerca ricorsivamente e gestisci i file della cartella del terminale attivo. ⭐ Preferiti per le cartelle che usi più spesso. |
| ✏️ **Editor integrato** | Apri e modifica file al volo, con evidenziazione sintattica e struttura dei simboli, senza lasciare l'app. |
| 🤖 **Pannello Agenti** | Vedi ogni sessione di Claude Code e Codex CLI aperta, riprendila con un clic e tieni d'occhio l'utilizzo residuo. |
| ⚡ **Funzionalità e shortcut** | Una barra di azioni rapide personalizzabile: comandi, popup di stato, scorciatoie verso i tuoi strumenti. |
| 🐧 **Shell a scelta** | PowerShell, cmd, bash, zsh, WSL… scegli quella predefinita per le nuove schede. |
| 🎨 **Temi chiaro, scuro e automatico** | Pannelli in vetro smerigliato con opacità regolabile. |
| 🔄 **Aggiornamenti in-app** | Flowcode controlla le nuove versioni all'avvio e si aggiorna con un clic. |

## Installazione

1. Vai alla pagina [Releases](https://github.com/MaxMoffa/flowcode/releases/latest).
2. Scarica l'installer per il tuo sistema:
   - **Windows** — `Flowcode-Setup-<versione>.exe`
   - **macOS** — `Flowcode-Setup-<versione>-macos-universal.zip` (Apple Silicon e Intel)
   - **Linux** — `Flowcode-Setup-<versione>-linux-x86_64.tar.gz`
3. Avvia l'installer e segui i passaggi. Se Flowcode è già installato, l'installer propone
   direttamente l'aggiornamento mantenendo le tue impostazioni.

Al primo avvio una breve presentazione ti mostra le funzioni principali e ti fa scegliere il tema.

## Primi passi

- **Nuova scheda** — pulsante `+` nella barra delle schede (clic destro per scegliere la shell),
  oppure dal menu `···`.
- **Pannello laterale** — il pulsante nell'intestazione mostra/nasconde il file explorer; con il
  clic destro scegli se tenerlo fissato, flottante o automatico.
- **Aprire un file** — clic su un file nell'explorer per aprirlo nell'editor integrato.
- **Agenti** — avvia `claude` o `codex` in una scheda: compaiono da soli nel pannello Agenti.
- **Impostazioni** — dal menu `···`. Sono divise in:
  - **Generali** — tema, trasparenza, intestazione, comportamento della sidebar;
  - **Terminale** — zoom, shell predefinita, banner, cartella di avvio, ripristino schede, link;
  - **Funzionalità** — attiva, crea o importa plugin per la barra rapida;
  - **Informazioni** — versione, aggiornamenti, cartella di configurazione, ripristino.

## Plugin

Vuoi un pulsante che lancia il tuo script di deploy, o un popup che mostra lo stato di un servizio?
Da **Impostazioni → Funzionalità** puoi crearne uno con un modulo guidato oppure importare un file
`.json`. Tutti i dettagli sul formato sono in [PLUGINS.md](PLUGINS.md).

---

## Per sviluppatori

Le sezioni seguenti servono solo se vuoi compilare Flowcode dai sorgenti o contribuire.

### Stack

- **Tauri v2** (Rust + WebView) — backend nativo, PTY locale
- **React 19 + TypeScript** — frontend, con **Vite** come build tool
- **xterm.js** — emulatore di terminale
- **portable-pty** — gestione PTY cross-platform lato Rust
- **CodeMirror** — editor integrato

### Struttura

```
flowcode/
├── src/                 # Frontend React
│   ├── terminal/        # xterm.js + collegamento PTY, schede
│   ├── sidebar/         # File explorer
│   ├── editor/          # Editor CodeMirror
│   ├── agents/          # Pannello Agenti
│   ├── plugins/         # Sistema plugin / Funzionalità
│   ├── settings/        # Pagine impostazioni
│   ├── installer/       # Wizard di installazione (entry #installer)
│   └── themes/          # Temi chiaro/scuro
├── src-tauri/           # Backend Rust
│   ├── src/             # App principale (pty, fs, agents, updater…)
│   ├── installer/       # Binario dell'installer
│   └── shared/          # Codice condiviso tra app e installer
├── config/              # Shortcut predefiniti
├── DECISION.md          # Log decisioni tecniche
├── ROADMAP.md           # Roadmap
└── TASKS.md             # Task operativi
```

### Requisiti

- Node.js >= 20
- Rust stable (via [rustup](https://rustup.rs))
- Tauri CLI v2 (dev dependency, disponibile via `npx tauri`)

Su **Linux** servono le librerie di sistema per il WebView:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev build-essential
```

Su **Windows / macOS** vedi i [prerequisiti ufficiali Tauri](https://tauri.app/start/prerequisites/).

### Sviluppo

```bash
npm install
npm run tauri dev
```

Avvia Vite in dev mode + finestra Tauri con hot reload su frontend e backend.

> Nota WSL2: senza server grafico (WSLg o X server come VcXsrv) la finestra non viene visualizzata.
> Per validare solo il backend: `cd src-tauri && cargo check`.

Solo type-check del frontend:

```bash
npx tsc --noEmit
```

### Build e release

```bash
npm run tauri build
```

Gli installer ufficiali per le tre piattaforme vengono generati dalla GitHub Action
`.github/workflows/release.yml` al push di un tag `vX.Y.Z`.

### Configurazione shortcut

I default stanno in `config/shortcuts.json` (inclusi nell'app). Le personalizzazioni utente vengono
salvate nella cartella di configurazione dell'app, sopravvivono agli aggiornamenti e sovrascrivono i
default con lo stesso nome.

## Licenza

Flowcode è distribuito con licenza [Apache 2.0](LICENSE).
