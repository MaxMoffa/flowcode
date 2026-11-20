# Flowcode MCP nelle tab terminale — piano

Stato: fase 1 implementata 2026-11-20 (non provata nell'app). Verificato a mano con i CLI veri (senza app): Claude carica `--mcp-config=<file>` e `--allowedTools=` lascia passare `call_user` senza chiedere; Codex 0.166 accetta gli override `-c`, inoltra l'env con `env_vars` e `tools.<tool>.approval_mode='approve'` evita la richiesta di approvazione. Entrambi scrivono la richiesta con `cwd` e `agent`.

## Obiettivo

Gli agenti avviati in una tab terminale (dal launcher **o scritti a mano** nella shell) ricevono il server MCP `flowcode` come le chat: `open_in_browser`, `call_user`, poi `list_agents` / `delegate_task` / `get_task_result` / `cancel_task`.

## Cosa esiste già (da riusare)

- **Shim nel PATH** (`src-tauri/src/provider_launcher.rs`): per ogni tab non-WSL, `pty_spawn` (`pty/mod.rs:479`) mette in testa al PATH `app_local_data/provider-launch/<profilo>/` con `claude.cmd`, `codex.cmd`, `gemini.cmd`, `vibe.cmd`, `opencode.cmd`, `cline.cmd` (sh su unix). Lo shim richiama `flowcode.exe --flowcode-provider <cli> <record> <programma reale> <argomenti utente>`; `run_if_requested` avvia il binario vero con le credenziali del profilo. **Copre già il comando scritto a mano**: qui si aggiungono i flag MCP.
- **Server MCP** (`flowcode-mcp.cjs` + `chat_mcp.rs`): stdio via `node`, IPC a file in `FLOWCODE_MCP_DIR`, identità via `FLOWCODE_MCP_TOKEN`, strumenti via `FLOWCODE_MCP_TOOLS`. Non sa nulla di ACP: va bene così com'è anche per i terminali.
- **Tag della tab**: `FLOWCODE_PTY_ID` in ogni processo della tab, WSL compreso (WSLENV).
- **Bolla `call_user`**: `callStore.addCall({ tabId, ... })` è già per tab, non per chat.

## Disegno

### 1. Identità: il chiamante può essere una tab

`chat_mcp::Caller { chat_id, depth }` → `Caller { owner: Owner, depth }` con `enum Owner { Chat(String), Terminal(String /* pty id */) }`.

- `pty_spawn` riceve `tools: Option<ToolsConfig>` dal frontend (stesso `toolsConfig()` delle chat, `ptyClient.ts:45`). Se ha strumenti attivi (`enabled_tools(cfg, 0)`): `register_terminal(pty_id)` → token; env della PTY: `FLOWCODE_MCP_TOKEN`, `FLOWCODE_MCP_DIR`, `FLOWCODE_MCP_TOOLS`, `FLOWCODE_MCP_SCRIPT` (percorsi Windows; per WSL tradotti con `/p` in WSLENV).
- Il token si revoca alla chiusura della PTY (`pty_kill` e uscita del processo).
- Il `ToolsConfig` della tab viene salvato in `PtyState` accanto alla sessione (serve a `mcp_call` per il controllo "strumento attivo" e a `auto_allow`). Cambio impostazioni → vale per le tab nuove (come per le chat).

### 2. Iniezione nello shim (`run_if_requested`)

Se l'env ha `FLOWCODE_MCP_TOKEN` e la CLI lo supporta, aggiunge argomenti/env **prima** di quelli dell'utente. Niente token negli argomenti (coerente con "No credential is put in arguments"): il token resta in env e il server lo eredita.

| CLI | Come | Da verificare |
|---|---|---|
| Claude | `--mcp-config <file>`: file per tab `mcp/term-<pty>.json` (0600) con `mcpServers.flowcode = { command: "node", args: [script], env: {...} }`. Si somma ai server dell'utente (non usare `--strict-mcp-config`). Con `openAutoAllow`: `--allowedTools mcp__flowcode__open_in_browser`. | che `--allowedTools` si sommi alle regole utente |
| Codex | `-c mcp_servers.flowcode.command='node'` `-c mcp_servers.flowcode.args=['<script>']` (stringa TOML letterale) `-c mcp_servers.flowcode.env_vars=[...]` (Codex filtra l'env dei server MCP: va inoltrato esplicitamente) + `-c mcp_servers.flowcode.tools.<tool>.approval_mode='approve'` per gli strumenti di `FLOWCODE_MCP_AUTO_ALLOW`. | ✅ verificato su 0.166 |
| OpenCode | env `OPENCODE_CONFIG_CONTENT` = `{"mcp":{"flowcode":{"type":"local","command":["node",script],"environment":{...}}}}`. Si unisce alla config utente. | che non sovrascriva un `OPENCODE_CONFIG_CONTENT` già impostato (in quel caso unire) |
| Cline | env `CLINE_MCP_SETTINGS_PATH` → copia per tab del `cline_mcp_settings.json` dell'utente + `flowcode`. | che il CLI legga la variabile; che non riscriva la copia |
| Gemini | env `GEMINI_CLI_SYSTEM_SETTINGS_PATH` → file con solo `mcpServers.flowcode`. | come unisce `mcpServers` tra scope system/user/workspace |
| Vibe | nessun modo noto senza toccare `~/.vibe/config.toml`. | **escluso** finché non c'è un flag/env |

**Sottocomandi da non toccare** (l'iniezione rompe o è inutile): Claude `mcp`, `config`, `update`, `doctor`, `install`, `migrate-installer`, `setup-token`, `plugin`, `auth`; Codex `login`, `logout`, `mcp`, `mcp-server`, `app-server`, `completion`; `--version`/`-v`/`--help`/`-h` per tutti. Regola: si inietta solo se il primo argomento non-flag è assente o non è in lista. Lista centralizzata in `agents/registry.rs` accanto ai nomi.

**Profilo**: lo shim si installa per ogni tab non-WSL anche senza profilo (`pty/mod.rs:479`, cartella `default`), quindi copre anche le tab "normali".

### 3. Cosa fanno gli strumenti per una tab

`delegate::mcp_call` smista per `Owner`:

- `open_in_browser` → nuovo `PtyEvent::Ext { method, params }` sul canale della tab (`pty/mod.rs:343`); `ptyClient.ts` lo passa al gestore della tab → `routeAgentOpen` come nelle chat (cwd = cwd corrente della tab, quello che il frontend segue già).
- `call_user` → stesso `PtyEvent::Ext` → `addCall({ tabId, ... })`.
- `list_agents` / `delegate_task` / `get_task_result` / `cancel_task` → fase 3. `Task.parent_chat_id` diventa `parent: Owner`; `start_child` oggi vuole un `&Chat` padre (vita, emit della card): serve un tratto `Parent` (vivo? emit?) implementato da Chat e da tab. Limite `max_parallel` per tab.
- `auto_allow` (permessi ACP) non serve: nei terminali i permessi li chiede la CLI nella sua TUI.

### 4. WSL

Oggi `provider_launcher::install` è saltato per le tab WSL (`pty/mod.rs:475`). Serve uno shim Linux:

- Script sh per CLI in `app_local_data/mcp/wsl-shims/` (visto dalla distro come `/mnt/c/...`). Lo shim trova il binario vero nel PATH saltando la propria cartella e lo avvia con gli stessi flag del punto 2 (logica duplicata in sh, oppure lo shim chiama `node <script> --launch <cli> -- args`: un solo posto in JS — **preferito**, node è comunque richiesto dal server).
- **Problema PATH**: i file di avvio della shell (`~/.profile`, `~/.bashrc`) di solito anteppongono `~/.local/bin` (dove sta `claude`) e scavalcherebbero lo shim. Soluzione: integrazione della shell come VS Code — bash `--rcfile <flowcode.bashrc>` che fa `source ~/.bashrc` e **poi** antepone la cartella shim; zsh via `ZDOTDIR` temporaneo che carica i file dell'utente e poi antepone; fish via `--init-command`. Shell sconosciuta → nessuno shim (fallback silenzioso, la tab funziona come oggi).
- Lo stesso problema esiste su **Linux/mac nativi** (`path_helper` su mac riordina il PATH in `/etc/zprofile`): stessa integrazione, va verificato se gli shim credenziali di oggi funzionano davvero lì.

### 5. Limiti accettati

- Percorso assoluto (`/usr/bin/claude`) o alias che punta al binario → niente MCP.
- SSH, `tmux` già avviato fuori da Flowcode, `sudo -i` → niente MCP.
- Agente avviato prima di cambiare le impostazioni → tiene la config vecchia.
- Il token è leggibile da ogni processo della tab (come oggi `FLOWCODE_PTY_ID`): stesso livello di fiducia dell'utente locale. Il token vale solo per quella tab e muore con lei.

## Fasi

1. **Fase 1 — Windows nativo, Claude + Codex, `open_in_browser` + `call_user`.** `Owner` in `chat_mcp.rs`, token per PTY, `PtyEvent::Ext`, iniezione in `run_if_requested`, lista sottocomandi, frontend (`ptyClient.ts` + gestore tab). Test: unit test dei builder di argomenti (come `shim_target`), poi prova reale in app.
2. **Fase 2 — WSL + OpenCode + Cline + Gemini.** Shim Linux via `node --launch`, integrazione bash/zsh/fish, iniezione via env per OpenCode/Cline/Gemini. Test sulla distro dell'utente prima di tutto.
3. **Fase 3 — Delega dalle tab.** `Owner` nei task, tratto `Parent`, UI dei figli (scelta aperta: card nella tab / drawer laterale / solo notifica).
4. **Fase 4 — Telefono e mappa.** Le tab aperte dal telefono passano lo stesso `tools`; aggiornare `docs/agents-integration-map.md` (nuova riga "Flowcode MCP nei terminali").

## Scelte aperte

- UI dei figli delegati da una tab (fase 3).
- Integrazione della shell (fase 2) cambia il modo in cui parte bash/zsh nelle tab: attivarla sempre o dietro un'impostazione "Integrazione shell"?
