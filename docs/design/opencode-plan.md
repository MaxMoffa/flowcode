# OpenCode come quinto agente

Stato: 2026-11-08, Fase 1 in implementazione. Fonte: sorgente `anomalyco/opencode` (branch `dev`, npm `opencode-ai@1.19.5`).

## Fatti su opencode 1.19 (verificati sul sorgente)

- Installazione: `npm i -g opencode-ai` → binario `opencode` (su Windows `opencode.exe` nativo, dentro il pacchetto npm).
- ACP: `opencode acp` (nativo, nessun adapter da pinnare). Avvia sempre un **server privato** (`Standalone.start()`), che eredita l'env → l'isolamento dei profili via env funziona.
- Gli altri comandi (TUI `opencode`, `opencode auth ...`, `opencode session ...`) usano di default un **servizio condiviso in background** (porta fissa 0x70DE su Windows), avviato con l'env di chi lo avvia per primo. Per i profili nominati serve il flag globale `--standalone`, altrimenti finiscono sul DB del servizio già attivo.
- Dati: `$XDG_DATA_HOME/opencode` (default `~/.local/share/opencode`, anche su Windows). Sessioni **e credenziali** stanno nel sqlite `opencode.db` (il vecchio `auth.json` viene importato da una migrazione). `OPENCODE_DB` (percorso assoluto) sposta il DB.
- Config: `~/.config/opencode` (`opencode.json(c)`, `AGENTS.md`, `agent(s)/`, `command(s)/`, `skills/`, `plugin/`). `OPENCODE_CONFIG_DIR` la sostituisce.
- Resume nel terminale: `opencode --session <id>` (alias `-s`).
- Login: `opencode auth login [target]` (picker interattivo multi-provider: OAuth con browser, codice incollato nel terminale, oppure API key). `opencode auth list --format json`, `opencode auth logout <target>`.
- Subagenti ACP: se il client dichiara `clientCapabilities._meta["opencode/child-session-updates"] = true`, gli update dei figli arrivano con `_meta["opencode/child-session"] = { id, parentID, depth, title }`, toolCallId prefissato `<childId>:` e notifica `opencode/session/child_update`.
- Provider: OpenRouter, Ollama, LM Studio, Anthropic, OpenAI, ecc. sono configurati da opencode stesso: Flowcode non deve gestirli.

## Profili

- Default: nessuna env, cartelle standard.
- Nominato `<dir>`: `OPENCODE_CONFIG_DIR=<dir>/config`, `OPENCODE_DB=<dir>/opencode.db`; i comandi da terminale (lancio, resume, login) aggiungono `--standalone`.
- Stato login: `opencode auth list --format json` (non c'è un file leggibile senza sqlite).

## Fase 1: supporto base (livello Gemini, più resume reale)

Registro (`opencode`: tutte le capacità false tranne `authNativeTerminal`), identità/icona/plugin, installazione, rilevamento processo (+ WSL), profili, stato login via comando, login nel terminale (niente dialog API key: la gestisce opencode), logout, `provider_launcher`, chat ACP `opencode acp`, resume `--session`, mobile dietro `useSupports("opencode")`, i18n, test.

## Fase 2: supporto completo (da decidere)

- Lettura di `opencode.db` (serve `rusqlite` bundled): History, `agent_session_saved`, sessione live, spesa (il costo è salvato nel DB), contesto, insight.
- Subagenti in chat tramite `opencode/child-session`.
- Terminali in background: forma della tool call `bash`.
