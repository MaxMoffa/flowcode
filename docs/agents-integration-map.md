# Mappa integrazione agenti

Stato al 2026-11-08 (dopo la release 0.30.0). Elenca ogni punto del codice in cui Flowcode tratta un agente in modo specifico, così da sapere cosa serve per aggiungerne uno nuovo con supporto completo.

Agenti supportati (`src/agents/cliInfo.ts`, `AGENT_CLIS`): **claude** (Claude Code), **codex** (Codex CLI), **vibe** (Mistral Vibe), **gemini** (Gemini CLI), **opencode** (OpenCode, multi-provider: OpenRouter, Ollama, LM Studio…).

OpenCode (aggiunto il 2026-11-08) è l'ultima colonna della matrice. Fatti, peculiarità (`--standalone` per i profili nominati, credenziali e sessioni in `opencode.db`) e Fase 2 sono in `docs/design/opencode-plan.md`.

Legenda: ✅ completo · 🟡 parziale/approssimato · ❌ assente · — non applicabile

## 1. Matrice delle funzionalità

| Area | Claude | Codex | Vibe | Gemini | OpenCode |
|---|---|---|---|---|---|
| **Identità / registro** (`cliInfo.ts`, `plugins/registry.ts`, `icons.tsx`, `remotePublish.ts`, `remote/chat.rs::agent_name`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Comando d'installazione** (`cli/cliInstallCommands.ts`) | ✅ | ✅ npm | ✅ (uv/pip) | ✅ npm | ✅ npm |
| **Rilevamento processo nel terminale** (`agents/mod.rs::AGENT_BINARIES`, `agent_of`, `node_runs_gemini`) | ✅ | ✅ | ✅ (python/vibe-rs) | ✅ (node+argv) | ✅ |
| **Sessione live del terminale → id sessione/stato** | ✅ registro `claude agents --json` / `~/.claude/sessions/<pid>.json`: id, titolo, busy/idle | 🟡 thread accoppiati per cwd+orario di avvio (`assign_codex_threads`) | 🟡 `vibe::live_session_in` (cwd+orario) | ❌ solo processo | 🟡 cwd+orario dal DB |
| **Rilevamento dentro WSL** (`agents/wsl.rs`) | ✅ (+ json registro) | ✅ (+ thread) | ✅ | 🟡 solo processo | 🟡 solo processo |
| **Sessioni salvate / pannello History** (`AgentHistoryPanel.tsx`) | ✅ `list_claude_sessions` (`claude_history.rs`) | ✅ `list_codex_sessions` (rollout) | ✅ `list_vibe_sessions` | ❌ non letto (`gemini.rs` lo dice) | ✅ `list_opencode_sessions` (`opencode.db`) |
| **`agent_session_saved`** (`agents/mod.rs:224`) | ✅ controllo reale | ✅ controllo reale (rollout con turn) | 🟡 sempre `true` | 🟡 sempre `true` | ✅ controllo reale |
| **Riprendi nel terminale** (`App.tsx::resumeCommand`) | ✅ `claude --resume` | ✅ `codex resume` + flag di avvio | ✅ `vibe --resume` | ✅ `gemini --resume` | ✅ `opencode [--standalone] --session` |
| **Flag di avvio speciali** | — | ✅ `withCodexLaunchFlags` (`--no-daemon` su Windows) | ✅ `vibe_ensure_model` (registra Mistral Large 4) | — | — |
| **Auto-resume dopo il limite** (`useAutoResume.ts`) | ✅ | ✅ (+ `/goal resume`) | ❌ | ❌ | ❌ |
| **Gauge usage/limiti** (`plugins/usage.ts`) | ✅ probe `claude -p "/usage"` (`run_claude_usage_probe`) | ✅ PTY nascosto con `/status` (`codexStatus.ts`) | 🟡 spesa da `meta.json` (`vibe_usage_stats`) | ❌ solo "connesso" | ❌ solo "connesso" |
| **Spesa in modalità API key** (`spend.rs`) | ✅ transcript `projects/**/*.jsonl` | ✅ rollout `token_count` | ✅ (costo proprio di Vibe) | ❌ | ✅ costo proprio di OpenCode |
| **Notifica reset limite** (`limitResetWatcher.ts`) | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Riempimento contesto** (`context.rs`, mobile `contexts_for`) | ✅ | ✅ | ❌ | ❌ | ✅ |
| **Agent insight: MCP/skill/memorie + costo sessione** (`agent_insight.rs`, `AgentInsightPanel.tsx`, `useAgentInsight.ts`) | ✅ (non in WSL) | ✅ (non in WSL) | ❌ "unsupported" | ❌ "unsupported" | ✅ (non in WSL) |
| **Avviso cache TTL** (`cacheWarning.ts`, `useCacheWarning.ts`, `agent_insight::read_cache_info`) | ✅ desktop+mobile | ❌ | ❌ | ❌ | ❌ |
| **Profili account: cartella/env** (`profiles.rs::env_for`) | ✅ `CLAUDE_CONFIG_DIR` | ✅ `CODEX_HOME` | ✅ `VIBE_HOME` (+ keyring off nei profili nominati) | ✅ `GEMINI_CLI_HOME` | ✅ `OPENCODE_CONFIG_DIR` + `OPENCODE_DB` |
| **Profili: copia impostazioni dal default** (`copy_settings_from_default`) | ✅ settings, CLAUDE.md, commands, agents, skills, output-styles, mcpServers | ✅ config.toml, AGENTS.md, prompts | ✅ config.toml, prompts, agents | ✅ settings.json, GEMINI.md, commands | ✅ |
| **Stato login da file** (`profiles.rs::login_state`) | ✅ `.credentials.json` / `.claude.json` | ✅ `auth.json` | ✅ `.env`/keyring | ✅ `oauth_creds.json` / `.env` | — |
| **Stato login via comando** (`plugins.rs`) | ✅ `claude auth status` | ✅ `codex login status` | 🟡 "api" | 🟡 file / "unknown" | 🟡 `opencode auth list` |
| **Logout** (`profiles.rs:499`) | ✅ `claude auth logout` | ✅ `codex logout` | ✅ rimuove API key | ✅ rimuove oauth file | ✅ |
| **Dialog login browser** (`provider_auth.rs`, `shared/ProviderAuthDialog.tsx`) | ✅ `claude auth login` + codice manuale | ✅ `codex login` / `--device-auth` da remoto (device code) | ✅ via ACP `vibe-acp` (`read_vibe`, `signInUrl`) | ✅ `gemini` + codice manuale | ✅ terminale nativo, multi-provider |
| **Login con API key** (`provider_auth_keys.rs`) | ✅ `ANTHROPIC_API_KEY` | ✅ `OPENAI_API_KEY` (+ `auth.json`) | ✅ `MISTRAL_API_KEY` | ✅ `GEMINI_API_KEY`/`GOOGLE_API_KEY` (+ `settings.json`) | — (gestita da OpenCode) |
| **Validazione key** (endpoint `/models`) | ✅ | ✅ | ✅ | ✅ | — |
| **Shim credenziali nel terminale** (`provider_launcher.rs`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Chat mode: avvio ACP** (`chat.rs::launch_command`) | ✅ `claude-agent-acp@0.101.0` | ✅ `codex-acp@2.5.0` | ✅ `vibe-acp` nativo | 🟡 `gemini --experimental-acp` | ✅ `opencode acp` |
| **Adapter ACP installato e pinnato** (`acp_adapters.rs`, avvio in `lib.rs`) | ✅ | ✅ | — (binario proprio) | — (binario proprio) | — (nativo) |
| **Chat in WSL** (`chat.rs::wsl_target`) | ✅ | ✅ | ✅ | ✅ (generico) | ✅ generico |
| **Retry su store occupato + start gate** (`transient_start_failure`, `start_gate`) | — | ✅ sqlite `~/.codex` | — | — | — |
| **Retry `session/load` con sessione in uso** | generico | ✅ (`thread_active_writer`) | generico | generico | generico |
| **Immagini in chat** (capability `promptCapabilities.image`) | generico (dipende dall'adapter) | generico | generico | generico | generico |
| **Subagenti in chat** (`chatModel.ts`, `codexSubagents.ts`) | ✅ `_meta.claudeCode.parentToolUseId` + transcript subagente | ✅ parser dedicato | ❌ | ❌ | ✅ via `opencode/child-session` |
| **Subagenti nativi (esperimento `FLOWCODE_NATIVE_SUBAGENTS`)** | 🟡 solo Claude | ❌ (disattivato apposta) | ❌ | ❌ | ❌ |
| **Card terminali in background** (`backgroundTerminals.ts`) | ✅ `run_in_background` | ✅ execute aperto | ✅ `background` + `session_id` | ✅ `is_background` + PID | ❌ (da definire) |
| **Comandi slash / skill** (`commandMenu.ts`) | generico (ACP `available_commands`) | ✅ trattamento `/$x` e `$skill` | generico | generico | generico |
| **Compaction, ask in composer (elicitation), modello/modalità** | generico ACP | generico ACP | generico ACP | generico ACP | generico ACP |
| **Handoff terminale ↔ chat** (`App.tsx:2436`, `chat.rs` attende la morte dell'agente) | ✅ | ✅ | ✅ | 🟡 serve l'id sessione, che per Gemini non viene rilevato | ✅ |
| **Delega cross-agente (Flowcode MCP)** (`chat/delegate.rs`, `agentToolsSettings.ts`) | ✅ | ✅ | ✅ | ✅ (lista configurabile) | ✅ |
| **Pulizia della dettatura** (`dictation/cleanup.rs`, `dictationModels.ts`) | ✅ | ✅ (`codex.cmd`, file temporaneo) | ❌ | ❌ | ✅ |
| **Mobile: lancio/profili/login** (`mobile/src/*`) | ✅ | ✅ | ✅ | 🟡 dietro `useSupports("gemini")` (desktop recenti) | ✅ dietro `useSupports("opencode")` |
| **Mobile: insight/contesto** (`remote/mod.rs`) | ✅ | ✅ | ❌ | ❌ | ✅ |

## 2. Classifica del supporto

1. **Claude**: il più completo. È l'unico con il registro sessioni nativo (stato busy/idle esatto), l'avviso cache, la probe `/usage` e i subagenti nativi sperimentali.
2. **Codex**: quasi alla pari. Ha in più la gestione dei problemi propri di Codex (sqlite, `--no-daemon`, device-auth da remoto, `/goal resume`), ma la sessione live è approssimata (accoppiamento per cwd e orario) e manca l'avviso cache.
3. **OpenCode**: supporto alto, vicino a Codex: sessioni live (approssimate) e salvate da `opencode.db`, resume, contesto, insight, spesa propria, subagenti via `opencode/child-session`, dettatura, login multi-provider e chat ACP nativa; mancano limiti/auto-resume, avviso cache e terminali in background.
4. **Vibe**: supporto medio. Ci sono sessioni live/salvate, spesa, login completo e chat ACP nativa; mancano contesto, insight, limiti, auto-resume, subagenti e dettatura.
5. **Gemini**: supporto base. Ci sono lancio, profili, login/key e chat ACP sperimentale; non si leggono le sessioni (né live né salvate), quindi niente history, insight, usage, spesa né handoff affidabile.

## 3. Checklist per aggiungere un nuovo agente `X`

Obbligatorio (supporto base, livello Gemini):
- [ ] `src/agents/cliInfo.ts`: `AgentCli`, `AGENT_CLIS`, `CLI_INFO` (pluginId, nome, label, loginCommand).
- [ ] `src/plugins/registry.ts`: plugin di esempio con il comando di lancio; `remotePublish.ts`: mappa pluginId → cli; `icons.tsx`: icona.
- [ ] `src/cli/cliInstallCommands.ts`: comando d'installazione.
- [ ] `src-tauri/src/agents/mod.rs`: `AGENT_BINARIES` + `agent_of` (attenzione ai wrapper node/python); `agents/wsl.rs`: `case` nello script `/proc`.
- [ ] `src-tauri/src/profiles.rs`: campo in `ProfileDirs`, `default_dirs`/`profile_dirs`, variabile home in `env_for`, `login_state`, logout, `copy_settings_from_default`, `ProfileHomes`.
- [ ] `src-tauri/src/plugins.rs`: stato login (comando o file).
- [ ] `provider_auth.rs`: `validate_provider`, `safe_auth_url` (host esatti), comando di login, `credential_stamp`, ed eventuale parsing di link e codice.
- [ ] `provider_auth_keys.rs`: `provider_dir`, nomi delle env var, endpoint di validazione, eventuale file di config da scrivere.
- [ ] `provider_launcher.rs`: aggiungere a lista e cartelle.
- [ ] `chat.rs::launch_command`: comando ACP (se è un adapter npm: `acp_adapters.rs` pin + `package` + `refresh_in_background` in `lib.rs`).
- [ ] `App.tsx::resumeCommand`: sintassi di resume.
- [ ] `remote/mod.rs`: liste `matches!(cli, ...)` (righe ~313, 2256, 2610); `remote/chat.rs::agent_name`; `src/remote/profileOps.ts`; i tipi in `SettingsPage.tsx`, `mobile/src/ProviderAuth.tsx`; `remote-proto` (capability `useSupports` se serve un gate per desktop vecchi).
- [ ] i18n (nomi, messaggi di login).

Per arrivare al supporto completo (livello Claude/Codex):
- [ ] Lettore delle sessioni (modulo come `vibe.rs`/`codex.rs`): sessione live per tab (id, titolo, busy), `list_X_sessions` per la History, controllo reale in `agent_session_saved`.
- [ ] Usage/limiti in `plugins/usage.ts` (fetcher legato al pluginId) + `limitResetWatcher.ts` + `useAutoResume.ts`.
- [ ] Spesa per uso API in `spend.rs` (transcript + prezzi di listino).
- [ ] `context.rs` (riempimento contesto) e `agent_insight.rs` (MCP/skill/memorie + costo); togliere i gate `cli === "claude" || "codex"` in `AgentInsightPanel.tsx`, `useAgentInsight.ts` e `remote/mod.rs`.
- [ ] Subagenti in chat: parser dei metadati dell'adapter (come `codexSubagents.ts`).
- [ ] Terminali in background: forma della chiamata in `backgroundTerminals.ts::launchOf`.
- [ ] Cache TTL (se il provider fa prompt caching): `cacheWarning.ts` e `read_cache_info`.
- [ ] Dettatura: `CLEANUP_AGENTS` + `dictation/cleanup.rs`.
- [ ] Peculiarità di avvio (lock dello store, flag, modello predefinito), sul modello di Codex e Vibe.
- [ ] Mock mobile (`devMock*.ts`) per i test UI.

## 4. Registro centrale degli agenti

L'elenco degli agenti e i flag di capacità stanno in due file speculari:
- **`shared/agentRegistry.ts`**: `AgentCli`, `AGENT_CLIS`, `AGENT_CAPS`, `isAgentCli`, `hasCap(cli, cap)` (è un type guard). `cliInfo.ts` lo riesporta; lo usano desktop, mobile e `shared/`.
  - Capacità: `readsSessions` (contesto, insight), `usageLimit` (avviso al reset del limite, auto-resume), `cacheWarning`, `authManualCode`, `authNativeTerminal`.
  - Valori attuali: `readsSessions` = claude, codex, opencode; `usageLimit` = claude, codex; `cacheWarning` = claude; `authManualCode` = claude, gemini, opencode; `authNativeTerminal` = tutti tranne vibe.
- **`src-tauri/src/agents/registry.rs`**: `AGENT_CLIS`, `is_known`, `reads_sessions`.

Per un agente nuovo: aggiungilo in entrambi i registri e imposta i flag. Tutti i controlli "agente valido?" e i gate di capacità passano da lì (`provider_auth`, `provider_launcher`, `plugins`, `remote/mod.rs`, `agent_insight`, insight/usage/limiti/cache/auth nel frontend).

I nomi restano scritti a mano solo dove c'è davvero codice specifico per un agente (percorsi, comandi, formati): i `match` in `profiles.rs`, `provider_auth*.rs`, `spend.rs`, `context.rs`, `agent_insight.rs`, `chat.rs::launch_command`, `App.tsx::resumeCommand`, `cliInstallCommands.ts`, `backgroundTerminals.ts`, `dictation`. Quando un agente nuovo ottiene una capacità, imposta il flag nel registro **e** aggiungi il suo ramo in quei `match`.
