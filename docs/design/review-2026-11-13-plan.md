# Review generale 2026-11-13 — piano di risoluzione

Fonti: review Claude (C) + review Codex (X), unite e verificate nel codice.
**Stato (2026-11-13): implementato** tranne 4.2 (scartato: un path Linux assoluto si risolve già sotto la share `\wsl.localhost` del cwd). 1.8 deciso: variante A (resta il focus del tab che ha già la sessione).

Baseline: `tsc` pulito, vitest 104 file / 914 test verdi. Clippy non eseguito (whisper richiede l'env di `scripts/tauri.mjs`).

## Fase 1 — Cronologia: chat vs terminale (priorità massima)

| # | Sev | Dove | Problema | Fix |
|---|-----|------|----------|-----|
| 1.1 | alta | `src/App.tsx:1102` | `front è chat \|\| defaultOpensChat()`: con default "chat", una sessione scelta dalla History di un **terminale** apre una chat. (C+X) | Vista = `view` esplicito → tipo del tab davanti (chat/terminale) → default solo senza contesto. Passare `view` da `AgentHistoryPanel` (come il tablet). |
| 1.2 | alta | `src/App.tsx:2771-2782` (`onNewSession`) | "Nuova sessione" dalla History: in una chat con altro agente/profilo chiama `launchAgentInNewTab` senza vista → **terminale** se default è terminale; da un terminale con default chat → **chat**. (C) | Stessa regola di 1.1: `forceTerminal` se front è terminale, `openChatTab` se front è chat. |
| 1.3 | alta | `src/App.tsx:1113` (`fits`) | Il resume può riusare un **tab delegato** (`t.delegate`): cambia `sessionId` ma il pane resta attaccato al vecchio child (`attachChatId`) → mostra la conversazione sbagliata. (X) | Escludere `t.delegate` da `fits`. |
| 1.4 | alta | `AgentHistoryPanel.tsx:203-207`, `WideHistory.tsx:101`, `shared/remote-types.ts` | Terminale agente con `session_id` non ancora rilevato → riga "live" con chiave `tab:` + riga salvata della stessa sessione. Clic sulla salvata = **secondo processo** sulla stessa sessione (Codex: "session in use"). Sul tablet sempre, perché il protocollo non manda il `sessionId` dei terminali. (C+X) | Mandare `sessionId` dei terminali nel protocollo; in `resumeAgentSession` controllare prima se un tab (terminale o chat, anche parcheggiato) ha già quella sessione → focus invece di resume. |
| 1.5 | media | `src/App.tsx:1114, 2295` | Doppio clic durante `ensureCliReady`/`openChatTab` → due chat sulla stessa sessione. (X) | Set "resume in corso" per cli/profilo/distro/sessione + ricontrollo tab dopo gli `await`. |
| 1.6 | media | `src/App.tsx:2017` | Chat in WSL: `historyAgent.wslDistro` sempre `undefined` → "Nuova sessione" dalla History apre agente host su path `\\wsl…`; sessioni Claude in WSL mai elencate. (C) | `wslDistro = wslDistroOfShell(shell) ?? wslDistroOfPath(cwd)` per le chat. (Claude-in-WSL history = limite noto, fuori scope.) |
| 1.7 | media | `delegate.rs:332`, `AgentHistoryPanel.tsx:238`, `App.tsx:2317` | Oltre 3 deleghe finite il backend ritira il child più vecchio; History/card passano ancora `childChatId` → chat vuota invece del transcript. (X) | Esporre stato "retired"; se ritirato → resume da `childSessionId`. |
| 1.8 | decisione | `AgentHistoryPanel.tsx:284`, `App.tsx:2396` | Sessione già aperta in un terminale, cliccata dalla History di una chat → porta al terminale (e viceversa). Non duplica: è il comportamento attuale. (X) | **Da decidere**: tenere il focus del tab esistente, oppure spostarla nella vista corrente (handoff chat↔terminale). |

## Fase 2 — Tablet / remoto

| # | Sev | Dove | Problema | Fix |
|---|-----|------|----------|-----|
| 2.1 | alta | `App.tsx:2015, 2756, 3093` | PC→PC: la sidebar History resta quella del PC **locale** mentre si guarda un altro PC; i clic agiscono in locale. (X) | Collegare la sidebar all'host selezionato (richieste history/resume a quell'host) o nasconderla lì. |
| 2.2 | media | `WideHistory.tsx:112`, `gitRemote.ts:36` | Resume dal tablet apre sul desktop ma il tablet resta sul tab di prima. (X) | Risposta al resume con id del tab creato → `onOpenChat`/`onOpenPty`. |

## Fase 3 — Bubble chiamate (d71e450 / 8a50d03)

| # | Sev | Dove | Problema | Fix |
|---|-----|------|----------|-----|
| 3.1 | alta | `useChatCalls.ts:41`, `callStore.ts:98` | Chiave globale `perm:<requestId>`/`ask:<requestId>`: gli id JSON-RPC ripartono per ogni processo → due chat si sovrascrivono; risolverne una cancella la bubble dell'altra. (X, verificato) | Chiave con id chat/pane: `perm:<chatKey>:<requestId>`. |
| 3.2 | media | `App.tsx:3221`, `callStore.ts:81` | Conversazioni parcheggiate nello stesso tab: bubble soppressa perché `tabId` = tab corrente; "Vai al tab" mostra l'altro pane. (X) | Associare la call a `paneKey`; sopprimere solo se quel pane è visibile; il "vai" fa `showChatSession`. |
| 3.3 | bassa | `useChat.ts` (call_user) | Le call `custom` non hanno `key` né TTL → si accumulano. `raised` in `useChatCalls` non si azzera se le bubble vengono spente e riaccese → richieste pendenti non riappaiono. (C) | `key: call:<tabId>` (sostituisce) ; svuotare `raised` quando `enabled` torna true. |

## Fase 4 — Terminale / rilevamento agenti

| # | Sev | Dove | Problema | Fix |
|---|-----|------|----------|-----|
| 4.1 | media | `agents/mod.rs:633` | `node /home/u/codex-project/server.js` → classificato Codex (ogni segmento del path passa per `agent_binary`). (X, verificato) | Controllare solo il nome dello script / percorsi package noti (`node_modules/@openai/codex/...`). |
| 4.2 | media | `Terminal.tsx:187` | OSC 8 `file:///mnt/c/...` in terminale WSL non convertito → file non trovato. (X) | `toWindowsPath(distro, path)` se il tab è WSL (anche per path assoluti stampati). |

## Fase 5 — Pulizia

- Rimuovere `toggleBrowser` (`browserStore.ts:47`): inutilizzato e aggira i pannelli parcheggiati.
- Togliere `export` inutili (knip): `goalTone` (mobile + desktop), `splitLines`, `openPdfInPreview`, `parseGoal`, `GitBranch`, `TabTarget`, `TabOp`.
- `knip.json`: togliere le entry ridondanti `mobile/src/main.tsx`, `sdk/agent-view/index.ts`.
- `browserStore`: pulire `pendingByTab` e i `focusWaiters` alla chiusura del tab e quando la richiesta è risolta dalla bubble.

## Fase 6 — Ottimizzazione

- `codex.rs:507`: la scansione rilegge tutto `session_index.jsonl` a ogni giro → riusare la cache per mtime di `thread_names_in`.
- `remote/mod.rs:1604`: history tablet raccoglie Claude/Codex/Vibe/OpenCode in serie → `tokio::join!`.

## Ordine di lavoro

1. Fase 1 (1.1-1.6) in un commit; 1.7 separato (backend).
2. Fase 3.1-3.2 (bug utente visibili).
3. Fase 2 (protocollo, tocca anche mobile).
4. Fasi 4, 5, 6.
Test: unit su regola vista (1.1/1.2), `fits` con delegato (1.3), dedup per sessione (1.4), chiavi call (3.1), detector (4.1).
