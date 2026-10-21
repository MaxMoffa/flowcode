# SDK per le viste agente

Una piccola libreria che nasconde il protocollo bridge v1 (vedi `PLUGINS.md`,
"Viste agente"): handshake, porta, e la conversazione già ricostruita dagli
eventi con lo stesso modello della chat di Flowcode. Zero dipendenze, nessuna
rete: la vista ne porta con sé una copia.

## File

- `flowcode-view.js`: modulo ES.
- `flowcode-view.iife.js`: script classico, espone `FlowcodeView`. È quello da
  usare in una vista: la pagina ha un'origine opaca, quindi un
  `<script type="module">` caricato dalla cartella della vista non è affidabile.
- `flowcode-view.d.ts`: i tipi, per l'editor.

Sono generati da `sdk/agent-view/index.ts` con `npm run build:view-sdk` (che
aggiorna anche la copia in `docs/agent-views/timeline/`). Non si modificano a mano.

## Uso

```html
<script src="flowcode-view.iife.js"></script>
<script>
  FlowcodeView.connect().then(function (client) {
    FlowcodeView.applyTheme(client.theme);

    function render() {
      // client.model.items: user, agent, thought, tool, permission, error, in ordine.
      // client.model.plan, client.status.queued, client.timing (inizio/fine per item).
    }
    client.on("model", render);
    client.on("status", render);
    client.on("theme", FlowcodeView.applyTheme);
    client.on("init", render); // nuova conversazione: il modello è già azzerato
    render();

    if (client.can("send")) client.send("Ciao");
  });
</script>
```

`connect(options?)` risolve dopo il primo `init`. Un nuovo `init` azzera il modello.

| Membro | Cosa è |
|--------|--------|
| `init` | il payload di `init` (`session`, `locale`, `device`, `insets`, `permissions`...) |
| `model` | `ChatModelState`: `items`, `plan`, `commands`, `turnActive`... |
| `timing` | `Map` id elemento → `{ start, end }` (ms, dai `at` degli eventi) |
| `status` | l'ultimo messaggio `status` (`null` finché non arriva) |
| `theme` | il tema corrente |
| `on(tipo, fn)` | `"model"`, `"status"`, `"theme"`, `"init"`, `"error"`; restituisce la funzione per annullare |
| `send(text)`, `cancel()`, `setMode(id)`, `openFile(path)`, `switchView(id)` | richieste all'host |
| `can(permesso)` | se il manifest ha ottenuto quel permesso |

`applyTheme(theme, root?)` imposta i token come variabili CSS e `color-scheme`;
`lineDiff(vecchio, nuovo)` è il diff per righe usato dalla chat.
`renderMarkdown(testo, document?)` rende un sottoinsieme di markdown (blocchi di
codice, `codice`, **grassetto**, elenchi "- ", a capo, link) come nodi DOM, mai
con innerHTML. I link sono `span.md-link` con l'indirizzo nel `title`: una vista
non può aprire nulla da sola. Classi: `md-p`, `md-pre`, `md-code`, `md-list`.

Un esempio completo è `docs/agent-views/timeline`.
