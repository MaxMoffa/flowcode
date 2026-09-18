# Decisioni di progetto

Log delle decisioni tecniche/architetturali rilevanti. Formato: data, decisione, motivazione, alternative scartate.

## 2026-09-17 — Stack scaffolding
- **Decisione**: Tauri v2 + React 19 + TypeScript + Vite come base frontend, Rust stable come backend.
- **Motivo**: richiesto da progetto, ecosistema maturo, bundle piccolo rispetto a Electron.
- **Alternative scartate**: Svelte/Vue (ok ma React scelto per ecosistema componenti più ampio in fase iniziale).

## 2026-09-17 — PTY via `portable-pty`
- **Decisione**: uso crate `portable-pty` per spawn shell locale cross-platform, comunicazione con frontend via eventi Tauri (`pty://output`, `pty://exit`) + comandi invoke (`pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`).
- **Motivo**: astrae differenze PTY/ConPTY tra Unix e Windows, API semplice, mantenuta attivamente (usata anche da WezTerm).
- **Alternative scartate**: bindings diretti a `nix`/`winpty` (troppo lavoro manuale per portabilità Windows).

## 2026-09-17 — Shortcut a due livelli (default + override)
- **Decisione**: default in `config/shortcuts.json` (bundlato come resource Tauri, letto anche da disco in dev), override utente salvati in `app_config_dir()/shortcuts.json` (scrivibile, sopravvive agli update).
- **Motivo**: evita di scrivere nella directory di installazione (spesso read-only su Windows/macOS in produzione) mantenendo comunque un file di config locale versionabile per i default di progetto.
- **Alternative scartate**: singolo file scrivibile in `config/` (rotto su install packaged read-only).

## 2026-09-17 — Direzione visiva: Variante A "Adwaita Glass"
- **Decisione**: tra le 3 varianti esplorate in artifact (GNOME + Flowlab), scelta **A**: proporzioni GTK/Libadwaita (headerbar 46px-like, radius 12px finestra / 6px controlli), un solo accento razionato (moss `#9db984`/`#4f6e3a`), chrome UI tendente ad ambra chiaro (`#f7e9d3`/`#edcda0`) in light mode e quasi-nero caldo (`#120d09`/`#070502`) in dark mode.
- **Motivo**: richiesta esplicita utente dopo review artifact; contrasto icone verificato (~7-8:1) sulle nuove superfici.
- **Implementazione**: finestra Tauri con `transparent: true` (+ `macOSPrivateApi: true` e feature Cargo `macos-private-api`) per lasciare intravedere il desktop reale dietro l'app; sidebar e terminale con `backdrop-filter: blur()` e sfondi rgba a bassa opacità (vetro offuscato) invece di sfondi opachi; icone da emoji a SVG stroke `currentColor` per controllo diretto del contrasto via CSS var `--ctrl-fg`.
- **Nota**: su WSL2 senza compositor non è possibile validare visivamente trasparenza/blur; da verificare su ambiente con GUI reale (Linux con compositor, macOS, Windows).

## 2026-09-17 — Toolchain Rust/apt installata nell'ambiente dev
- **Decisione**: installato rustup (stable) e pacchetti apt `libwebkit2gtk-4.1-dev`, `libjavascriptcoregtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libssl-dev` per poter compilare Tauri v2 su Linux/WSL2.
- **Motivo**: ambiente dev pulito, nessuna delle due era presente.
- **Nota**: su WSL2 senza server X, `tauri dev` compila ma non mostra finestra GUI; usare `cargo build`/`cargo check` per validare il backend, oppure X server (WSLg/VcXsrv) per test visivi.
