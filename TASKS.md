# Tasks

Elenco operativo di cose da fare, più granulare della ROADMAP. Spuntare e spostare in "Fatto" quando completato.

## In corso
- [x] Review 3 varianti UI (GNOME Terminal + Flowlab, glass/blur) — scelta: **Variante A (Adwaita Glass)**
- [x] Applicata variante A ai componenti reali (App.css, sidebar.css, terminal.css, themes.css): chrome ambra chiaro/quasi-nero scuro, icone SVG a contrasto controllato, sidebar e terminale a vetro sfocato (`backdrop-filter`), finestra Tauri trasparente
- [ ] Validazione visiva reale su ambiente con display (WSL2 dev corrente non ha compositor grafico) — verificare che il blur/trasparenza sia visibile su Linux/macOS/Windows

## Da fare — a breve
- [ ] Testare `npm run tauri dev` con display grafico (WSLg o X server) per validazione visiva reale
- [ ] Icone app personalizzate Flowcode (sostituire icone placeholder in `src-tauri/icons/`)
- [ ] Tab multipli terminale (vedi ROADMAP Fase 1)
- [ ] Gestione errori spawn PTY (shell non trovata, permessi) con messaggio in UI invece che silenzioso
- [ ] Validare `write_shortcuts_overrides` con test manuale (modifica, riavvio app, verifica persistenza)
- [ ] Aggiungere test automatici minimi (almeno smoke test invoke comandi Tauri)

## Da fare — dopo
- [ ] Split pane terminale
- [ ] Azioni file da sidebar (rinomina/elimina/nuovo)
- [ ] Palette comandi
- [ ] Setup CI (build multi-piattaforma: Windows/macOS/Linux)

## Fatto
- [x] Scaffold iniziale Tauri v2 + React + TS + Vite
- [x] Rinominato progetto `tauri-app` → `flowcode` (package.json, Cargo.toml, tauri.conf.json)
- [x] Backend PTY (`src-tauri/src/pty.rs`): spawn/write/resize/kill + eventi output/exit
- [x] Backend fs (`src-tauri/src/fs.rs`): read_dir, home_dir, shortcuts default/override read+write
- [x] Frontend terminal (`src/terminal/`): xterm.js + fit addon + collegamento PTY
- [x] Frontend sidebar (`src/sidebar/`): file tree lazy-load
- [x] Frontend shortcuts (`src/shortcuts/`): loader default+override, hook keydown
- [x] Frontend themes (`src/themes/`): context + toggle + CSS vars light/dark
- [x] Config base shortcut (`config/shortcuts.json`) bundlata come resource Tauri
- [x] Rust toolchain + dipendenze di sistema Linux (webkit2gtk, ecc.) installate in ambiente dev
- [x] Verifica `cargo check` e `tauri build --debug --no-bundle` senza errori
- [x] `npm run build` frontend senza errori di tipo
