# Roadmap Flowcode

## Fase 0 — Setup (in corso)
- [x] Scaffold Tauri v2 + React + TS + Vite
- [x] PTY locale (spawn shell, I/O, resize, kill) via `portable-pty`
- [x] xterm.js integrato con PTY
- [x] Sidebar collassabile con file explorer minimale (albero directory, lazy-load)
- [x] Sistema shortcut base (config JSON + override utente)
- [x] Temi chiaro/scuro con toggle
- [x] DECISION.md / ROADMAP.md / TASKS.md
- [ ] Stile UI definitivo (GNOME Terminal + Flowlab, glass/blur) — 3 varianti in review

## Fase 1 — Terminale usabile quotidianamente
- [ ] Tab multipli (più sessioni PTY in parallelo)
- [ ] Split pane (orizzontale/verticale)
- [ ] Copia/incolla con shortcut dedicati e menu contestuale
- [ ] Ricerca nel buffer del terminale (xterm search addon)
- [ ] Persistenza sessione (working dir, tab aperti) tra riavvii
- [ ] Editor shortcut da UI (non solo JSON a mano)

## Fase 2 — File explorer avanzato
- [ ] Azioni file (rinomina, elimina, nuovo file/cartella) dalla sidebar
- [ ] Drag&drop tra sidebar e terminale (inserimento path)
- [ ] Click su file → apertura rapida/preview
- [ ] Filtri/ignore (.gitignore aware)

## Fase 3 — Estensibilità
- [ ] Sistema temi custom (oltre chiaro/scuro: temi utente via JSON/CSS vars)
- [ ] Plugin/estensioni terminale (hook su output, comandi custom)
- [ ] Palette comandi (Ctrl+Shift+P style)

## Fase 4 — Accesso remoto
- [ ] Connessione SSH integrata
- [ ] Accesso remoto via WebSocket (sessioni condivise/monitorate da remoto)
- [ ] Autenticazione e gestione profili di connessione

## Fase 5 — Integrazione Flowlab
- [ ] Definire contratto di integrazione (API/eventi condivisi)
- [ ] Bridge UI/dati tra Flowcode e Flowlab
- [ ] Coerenza design system tra le due piattaforme

## Fase 6 — Mobile
- [ ] Valutare target Tauri Mobile (Android/iOS) per client di accesso remoto
- [ ] UI adattata touch (no PTY locale, solo client remoto)

## Backlog / idee non prioritizzate
- Auto-update app (Tauri updater)
- Telemetria opt-in per bug report
- Localizzazione (i18n) IT/EN — prevista per la prossima versione
