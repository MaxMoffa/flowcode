# Flowcode

Terminale desktop moderno cross-platform (Windows, macOS, Linux) con file explorer integrato, shortcut personalizzabili e temi chiaro/scuro.

## Stack
- **Tauri v2** (Rust + WebView) — backend nativo, spawn PTY locale
- **React 19 + TypeScript** — frontend
- **Vite** — build tool
- **xterm.js** — emulatore terminale
- **portable-pty** — gestione PTY cross-platform lato Rust

## Struttura
```
flowcode/
├── src/                # Frontend
│   ├── terminal/        # Componente xterm.js + collegamento PTY
│   ├── sidebar/          # File explorer (albero directory)
│   ├── shortcuts/        # Sistema shortcut (loader + hook keydown)
│   └── themes/           # Tema chiaro/scuro (context + toggle)
├── src-tauri/           # Backend Rust
│   └── src/
│       ├── pty.rs        # Spawn/IO/resize/kill PTY
│       └── fs.rs         # File system (albero dir) + config shortcut
├── config/              # Config utente locale (default shortcut)
├── DECISION.md          # Log decisioni tecniche
├── ROADMAP.md           # Roadmap feature
└── TASKS.md             # Task operativi
```

## Requisiti
- Node.js >= 20
- Rust stable (via [rustup](https://rustup.rs))
- Tauri CLI v2 (installata come dev dependency, disponibile via `npx tauri`)

### Linux
Librerie di sistema richieste per compilare il backend WebView:
```bash
sudo apt-get install libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev build-essential
```

### Windows / macOS
Vedi [prerequisiti ufficiali Tauri](https://tauri.app/start/prerequisites/).

## Sviluppo

```bash
npm install
npm run tauri dev
```

Avvia Vite in dev mode + finestra Tauri con hot reload su frontend e backend.

> Nota WSL2: senza server grafico (WSLg o X server come VcXsrv) la finestra non viene visualizzata. Per validare solo il backend: `cd src-tauri && cargo check` oppure `npx tauri build --debug --no-bundle`.

## Build produzione

```bash
npm run tauri build
```

Genera i pacchetti installabili per la piattaforma corrente in `src-tauri/target/release/bundle/`.

## Configurazione shortcut

Default in `config/shortcuts.json` (bundlato con l'app). Le personalizzazioni utente vengono salvate separatamente nella directory di configurazione dell'app (persistono tra gli aggiornamenti) e sovrascrivono i default allo stesso nome chiave.

## Solo type-check / lint frontend

```bash
npx tsc --noEmit
```
