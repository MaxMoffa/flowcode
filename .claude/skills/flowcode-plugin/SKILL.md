---
name: flowcode-plugin
description: Create or edit a Flowcode plugin (a declarative JSON manifest for the app's shortcuts bar / "Funzionalità" menu) - use when the user asks to add a shortcut, a quick action, a status popup, or otherwise extend Flowcode's plugin system.
---

# Flowcode plugin authoring

Flowcode plugins are **declarative JSON, never code**. The `action` field
picks one of a small fixed vocabulary the app already knows how to run - a
plugin file can never make the app execute anything it didn't ship with.
Full human-facing reference: `PLUGINS.md` at the repo root - read it if
anything here is unclear or seems out of date, it is the source of truth.

## Before writing a manifest

1. **Read `PLUGINS.md`** for the current `PluginAction` union and any notes
   added since this skill was written (skills drift, the doc is canonical).
2. **Ask what the plugin should actually do** if it's not obvious from the
   request - which of the fixed actions below fits, and don't invent
   behavior outside that vocabulary. If the request needs something no
   existing action can do (e.g. reading structured data from an API,
   multi-step logic, state), say so plainly instead of forcing it into
   `commandOutput`/`dialog` in a way that doesn't actually work - that's a
   real code change to the app (`src/plugins/types.ts` PluginAction union +
   `src/App.tsx`'s `runPlugin` switch + `src-tauri` if a new backend command
   is needed), not a plugin file.

## The manifest shape

```ts
interface PluginManifest {
  id: string;            // unique, filesystem-safe: only [A-Za-z0-9_-] survive (sanitized on save)
  label: string;         // shown in the shortcuts bar / "Funzionalità" menu
  description?: string;  // subtitle in the Funzionalità table
  action: PluginAction;
  command?: string;      // action = "runCommand" | "commandOutput"
  message?: string;      // action = "notify" | "dialog"
  title?: string;        // action = "dialog" (defaults to label)
  buttons?: PluginButton[]; // action = "dialog"
  icon?: string;          // a single SVG <path> `d` value, drawn in a 24x24 stroke frame - optional, falls back to a generic icon
}

type PluginAction =
  | "newTerminal"          // opens a new terminal tab
  | "clearTerminal"        // clears the active terminal
  | "toggleSidebar"        // shows/hides the left file-explorer panel
  | "toggleAgentsSidebar"  // shows/hides the right "Agenti attivi" panel
  | "runCommand"      // types `command` into the active terminal, as if the user had typed it
  | "notify"          // shows `message` as a transient toast
  | "dialog"          // opens a dialog with `title` + `message` + `buttons`
  | "commandOutput";  // runs `command` headlessly (no terminal, no stdin) and shows combined stdout+stderr in a popup

interface PluginButton {
  label: string;
  action: Exclude<PluginAction, "dialog">; // dialogs don't nest
  command?: string;
  message?: string;
}
```

Rules that matter:

- `id` gets sanitized to `[A-Za-z0-9_-]` on save (see
  `src-tauri/src/plugins.rs`'s `sanitize_id`) - pick one that's already
  clean (kebab-case is the house style: `avvia-test`, not `Avvia Test`).
- `commandOutput`'s command runs with **no stdin** - an interactive command
  hangs instead of failing fast. Use a command that prints and exits
  (`codex login status`, `node --version`), never one that waits for input
  (`codex login`, a REPL, `npm init` without `-y`).
- A `dialog` always gets an automatic "Chiudi" button in addition to
  whatever's in `buttons`.
- `icon`, if given, is **only** the `d` attribute of one `<path>` - never a
  full `<svg>`/arbitrary markup. Omit it if you don't have a real,
  deliberately-drawn path; the generic fallback icon is better than a wrong
  or lazy one.
- UI strings in this codebase are **Italian** - `label`/`description`/
  `message`/`title` should be too, matching the tone of the built-in plugins
  in `src/plugins/registry.ts` (short, direct, no exclamation marks).

## Where the file goes

- Linux: `~/.config/com.maxmoffa.flowcode/plugins/<id>.json`
- macOS: `~/Library/Application Support/com.maxmoffa.flowcode/plugins/<id>.json`
- Windows: `%APPDATA%\com.maxmoffa.flowcode\plugins\<id>.json`

If you (the assistant) have shell/file access to the user's machine, you can
write the file directly there - it's picked up next time the user opens
**Impostazioni → Funzionalità** (or reloads it). If you don't have that
access, or the user is on a different machine, give them the finished JSON
and tell them to use **Impostazioni → Funzionalità → "Importa da file"**
instead of hand-copying it into the folder.

## Examples (copy the shape, not the content)

Quick command:

```json
{
  "id": "avvia-test",
  "label": "Avvia i test",
  "description": "Esegue la suite di test del progetto",
  "action": "runCommand",
  "command": "npm test"
}
```

Dialog with buttons that act on the terminal:

```json
{
  "id": "gestione-servizio",
  "label": "Servizio web",
  "description": "Avvia, ferma o controlla lo stato del servizio locale",
  "action": "dialog",
  "title": "Servizio web",
  "message": "Cosa vuoi fare?",
  "buttons": [
    { "label": "Avvia", "action": "runCommand", "command": "npm run start" },
    { "label": "Stato", "action": "runCommand", "command": "curl -s localhost:3000/health" }
  ]
}
```

Dynamic status popup (no terminal opened):

```json
{
  "id": "stato-servizio",
  "label": "Stato servizio",
  "action": "commandOutput",
  "command": "curl -s -o /dev/null -w '%{http_code}' localhost:3000/health"
}
```

More real examples, including the two CLI launcher plugins Flowcode ships
with: `src/plugins/registry.ts` (`BUILTIN_PLUGINS`/`EXAMPLE_PLUGINS`).

## After writing it

1. Validate the JSON parses and `id` matches the filename.
2. Tell the user to reopen **Impostazioni → Funzionalità** to pick it up (or
   restart the app in dev).
3. If the plugin is meant to be always visible, mention they can pin it to
   the shortcuts bar from that same page.

## When this isn't enough

A hover popover with live numeric data (like the Claude Code / Codex CLI
usage bars) is **not** something a manifest can describe - it's bespoke
logic keyed to a specific plugin `id` in `src/plugins/usage.ts` (see that
file and `PLUGINS.md`'s "Codex CLI / Claude Code: un caso a parte" section
for how those two are wired up as a precedent). If a request genuinely needs
that level of custom behavior, say so explicitly and treat it as an app code
change, not a plugin file - don't pretend the manifest format can express it.
