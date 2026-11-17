# Cline come sesto agente

Stato: 2026-11-17, piano. Niente implementato. Fonti: documentazione ufficiale (`docs.cline.bot/cli/cli-reference`, `docs.cline.bot/usage/acp`) e README npm `cline@3.0.74`. Cline **non** è installato sul PC dell'utente: tutto ciò che è segnato "da verificare" va provato dal vivo prima della Fase 2.

Base già in master (PR #3): `src-tauri/src/cline.rs` (quote ClinePass via `api.cline.bot`, credenziali da env o `providers.json`), `usage_limits.rs` (`UsageWindow` condiviso con OpenCode Go), `fetchClineUsage` in `src/plugins/usage.ts`. La scorciatoia plugin "Cline" della PR è stata tolta: Cline arriva come agente.

## Fatti su Cline CLI 3.x (dalla documentazione)

- Installazione: `npm i -g cline` → binario nativo `cline` (macOS/Linux/Windows, x64/arm64, nessun runtime Node necessario). Nightly: `cline@nightly`.
- ACP: `cline --acp`, nativo (nessun adapter da pinnare, come OpenCode). Sopra ACP: modalità Plan/Act, scelta modello, toggle auto-approve (in ACP il default è `false`).
- Cartelle: config `~/.cline` (`CLINE_DIR` o `--config`), dati `~/.cline/data` (`CLINE_DATA_DIR` o `--data-dir`; `--data-dir` attiva anche il sandbox mode).
  - `data/settings/providers.json`: provider e credenziali (OAuth `auth.accessToken`, `apiKey`).
  - `data/settings/global-settings.json`, `data/settings/cline_mcp_settings.json` (`CLINE_MCP_SETTINGS_PATH`).
  - `data/sessions/<id>/`: messaggi della sessione (formato non documentato).
  - `data/db/sessions.db`: indice sessioni sqlite.
  - `rules/`, `skills/`, `hooks/`, `agents/`, `plugins/` globali; `.cline/` per progetto.
- Resume nel terminale: `cline --id <session-id>`.
- History: `cline history --json --limit N` (lista sessioni JSON), `history export|delete|update`.
- Login: `cline auth` (TUI), `cline auth cline` (OAuth account Cline/ClinePass), `cline auth --provider <id> --apikey <key> --modelid <id> [--baseurl]`. Provider OAuth: `cline`, `openai-codex`, `oca`; per gli altri si usa una API key. Env: `CLINE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`… Nessun comando `status`/`logout` documentato.
- Hub daemon in background (`cline hub`, `CLINE_HUB_PORT`, `CLINE_HUB_ADDRESS`), usato da `--zen` e dai team. **Rischio come per OpenCode**: se è un servizio condiviso avviato con l'env del primo che lo lancia, i profili nominati vanno isolati (porta o modalità per profilo).
- La documentazione ACP avverte: due istanze sulla stessa cartella di config danno errori di permesso. Impatta l'handoff terminale ↔ chat (Flowcode deve aspettare che l'agente nel terminale sia terminato, come già fa).
- Subagenti: tool `spawn`/`team` ("agent teams"). Come arrivino via ACP: da verificare.

## Profili

- Default: nessuna env, cartelle standard.
- Nominato `<dir>`: `CLINE_DIR=<dir>` (ne deriva `<dir>/data`). Da verificare: che `CLINE_DIR` basti anche per l'hub e per `--acp`; altrimenti aggiungere `CLINE_DATA_DIR=<dir>/data` e `CLINE_HUB_PORT` dedicata.
- Copia impostazioni dal default: `data/settings/global-settings.json`, `cline_mcp_settings.json`, `rules/`, `skills/`, `agents/`, `hooks/` (non `providers.json`: contiene credenziali).
- Stato login da file: `providers.json` → `providers.<id>.settings` con `auth.accessToken` o `apiKey` (stessa lettura di `cline.rs::settings_token`, da generalizzare oltre il provider `cline`).
- Logout: rimuovere le credenziali da `providers.json` (non c'è un comando).

## Fase 0: verifica dal vivo (prima di scrivere codice)

Serve Cline installato (Windows + WSL): `npm i -g cline`.
1. `cline --acp`: handshake `initialize` (capability: `loadSession`, immagini, `promptCapabilities`), `session/new`, `session/load`, modalità e modelli esposti, forma delle tool call (shell, edit, spawn), errore strutturato su limite/quota.
2. Profili: `CLINE_DIR` su una cartella vuota isola davvero login, sessioni e hub?
3. `cline history --json`: campi (id, cwd, titolo, orari, costo/token?). Schema di `sessions.db` e dei file in `data/sessions/<id>/`.
4. Processo nel terminale: nome del binario su Windows (`cline.exe` o shim npm `.cmd`) e in WSL, per `AGENT_BINARIES`.
5. Login: dove scrive `cline auth cline` il token, e se il formato coincide con quello letto da `cline.rs`.

## Fase 1: supporto base (checklist di `docs/agents-integration-map.md`)

Registro `cline` in `cliInfo.ts` (`AGENT_CLIS`, `CLI_INFO`, loginCommand `cline auth`), plugin di esempio + icona + `remotePublish.ts`, `cliInstallCommands.ts` (`npm i -g cline`), rilevamento processo (+ WSL), profili (`ProfileDirs`, `env_for`, `login_state`, logout, `copy_settings_from_default`), stato login in `plugins.rs`, login: terminale nativo (`cline auth`, picker multi-provider come OpenCode) + dialog API key solo per `CLINE_API_KEY`, `provider_launcher.rs`, chat ACP `cline --acp`, resume `cline --id`, `remote/*` + mobile dietro `useSupports("cline")`, i18n, test. Quote ClinePass: collegare `fetchClineUsage` al plugin dell'agente e far seguire a `cline_usage` il profilo (oggi legge solo il default).

## Fase 2: supporto completo (dopo la Fase 0)

- History, `agent_session_saved`, sessione live da `cline history --json` o `sessions.db` (sola lettura).
- Spesa e contesto, se i dati di sessione riportano token/costo.
- Subagenti in chat (se `spawn` emette metadati riconoscibili via ACP).
- Terminali in background (forma della tool call shell).
- Auto-resume e notifica di reset sulle quote ClinePass (`limitResetWatcher` copre già 5 ore/settimana/mese).
- Aggiornare la matrice in `docs/agents-integration-map.md`.

## Domande aperte

- Hub condiviso: serve una modalità "standalone" per i profili come per OpenCode?
- Default auto-approve in ACP è `false`: allinearlo alla modalità di revisione scelta in Flowcode tramite l'opzione di sessione ACP.
- Account identity nei profili: per l'account Cline l'email è leggibile? (`providers.json` o API `users/me`).
