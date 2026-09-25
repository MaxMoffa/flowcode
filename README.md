<p align="center">
  <img src="public/flowcode-icon.svg" alt="Flowcode" width="128" height="128">
</p>

<h1 align="center">Flowcode</h1>

<p align="center">
  The desktop terminal that keeps your shell, files and AI agents together — without breaking your flow.
  <br>
  Windows · macOS · Linux
</p>

<p align="center">
  <a href="https://github.com/MaxMoffa/flowcode/releases/latest">Download the latest version</a> ·
  <a href="PLUGINS.md">Create a plugin</a> ·
  <a href="LICENSE">Apache 2.0 License</a>
</p>

<p align="center">
  <b>English</b> · <a href="README.it.md">Italiano</a>
</p>

---

## The philosophy

More and more work happens **in the terminal**: you kick off a build, open Claude Code or Codex, jump
between folders, tweak a config file. Usually that means keeping four different windows open —
terminal, file manager, editor, a browser to check your usage limits — and losing the thread every
time you switch.

Flowcode starts from a simple idea: **the terminal is the center, everything else revolves around it.**

- **One folder, one context.** The file explorer and the editor follow the active terminal's folder,
  even inside WSL. You `cd`, and the rest of the app comes along.
- **AI agents feel at home.** Claude Code and Codex CLI aren't "just another program in the shell":
  Flowcode recognizes them, shows them in a dedicated panel and tells you how much usage you have left.
- **Light and native.** Built on Tauri, not Electron: it installs in a moment, starts instantly and
  uses little memory.
- **Extensible without risk.** Plugins are declarative JSON files, not code: you can install a
  colleague's plugin without worrying about what it runs.
- **Pick up where you left off.** Tabs, folders and output come back when you reopen the app, and
  your settings survive updates.

## What you can do

| | |
|---|---|
| 🗂️ **Tabbed terminal** | Several sessions side by side, draggable between windows, grouped automatically when they don't fit the bar. Per-tab text zoom. |
| 📁 **Side file explorer** | Browse, search recursively and manage the files of the active terminal's folder. ⭐ Favorites for the folders you use most. |
| ✏️ **Built-in editor** | Open and edit files on the fly, with syntax highlighting and a symbol outline, without leaving the app. |
| 🤖 **Agents panel** | See every open Claude Code and Codex CLI session, resume it with one click and keep an eye on your remaining usage. |
| ⚡ **Features and shortcuts** | A customizable quick-action bar: commands, status popups, shortcuts to your own tools. |
| 🐧 **Your shell of choice** | PowerShell, cmd, bash, zsh, WSL… pick the default one for new tabs. |
| 🎨 **Light, dark and automatic themes** | Frosted-glass panels with adjustable opacity. |
| 🌐 **Multilingual** | English and Italian, following your system language by default — switchable any time from the settings. |
| 🔄 **In-app updates** | Flowcode checks for new versions on startup and updates itself in one click. |

## Installation

1. Go to the [Releases](https://github.com/MaxMoffa/flowcode/releases/latest) page.
2. Download the installer for your system:
   - **Windows** — `Flowcode-Setup-<version>.exe`
   - **macOS** — `Flowcode-Setup-<version>-macos-universal.zip` (Apple Silicon and Intel)
   - **Linux** — `Flowcode-Setup-<version>-linux-x86_64.tar.gz`
3. Run the installer and follow the steps. If Flowcode is already installed, the installer offers to
   update it straight away, keeping your settings.

On first launch a short tour shows you the main features and lets you pick a theme.

## Getting started

- **New tab** — the `+` button in the tab bar (right-click to choose the shell), or from the `···`
  menu.
- **Side panel** — the button in the header shows/hides the file explorer; right-click it to choose
  whether it stays docked, floating or automatic.
- **Opening a file** — click a file in the explorer to open it in the built-in editor.
- **Agents** — start `claude` or `codex` in a tab: they show up in the Agents panel on their own.
- **Settings** — from the `···` menu. They're split into:
  - **General** — language, theme, transparency, header, sidebar behavior;
  - **Terminal** — zoom, default shell, banner, startup folder, tab restore, links;
  - **Features** — enable, create or import plugins for the quick bar;
  - **About** — version, updates, configuration folder, reset.

## Language

Flowcode is available in **English** and **Italian**. By default it uses your operating system's
language (falling back to English when that language isn't available); you can pick a specific one in
**Settings → General → Language**. The change applies right away to every open window.

Want to add a language? Each one is a single catalog in `src/i18n/locales/` — copy `en.ts`, translate
the values and register it in `LANGUAGES` in `src/i18n/index.tsx`. The catalogs are typed against the
Italian reference one, so a missing key is a compile error.

## Plugins

Want a button that runs your deploy script, or a popup that shows a service's status? From
**Settings → Features** you can create one with a guided form or import a `.json` file. All the
details about the format are in [PLUGINS.md](PLUGINS.md).

---

## For developers

The following sections are only needed if you want to build Flowcode from source or contribute.

### Stack

- **Tauri v2** (Rust + WebView) — native backend, local PTY
- **React 19 + TypeScript** — frontend, with **Vite** as the build tool
- **xterm.js** — terminal emulator
- **portable-pty** — cross-platform PTY handling on the Rust side
- **CodeMirror** — built-in editor

### Structure

```
flowcode/
├── src/                 # React frontend
│   ├── terminal/        # xterm.js + PTY bridge, tabs
│   ├── sidebar/         # File explorer
│   ├── editor/          # CodeMirror editor
│   ├── agents/          # Agents panel
│   ├── plugins/         # Plugin / Features system
│   ├── settings/        # Settings pages
│   ├── i18n/            # Translations (one catalog per language)
│   ├── installer/       # Setup wizard (entry #installer)
│   └── themes/          # Light/dark themes
├── src-tauri/           # Rust backend
│   ├── src/             # Main app (pty, fs, agents, updater…)
│   ├── installer/       # Installer binary
│   └── shared/          # Code shared by the app and the installer
├── config/              # Default shortcuts
├── DECISION.md          # Technical decision log
├── ROADMAP.md           # Roadmap
└── TASKS.md             # Operational tasks
```

### Requirements

- Node.js >= 20
- Rust stable (via [rustup](https://rustup.rs))
- Tauri CLI v2 (dev dependency, available via `npx tauri`)

On **Linux** you need the system libraries for the WebView:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev build-essential
```

On **Windows / macOS** see the [official Tauri prerequisites](https://tauri.app/start/prerequisites/).

### Development

```bash
npm install
npm run tauri dev
```

Starts Vite in dev mode + the Tauri window, with hot reload on both frontend and backend.

> WSL2 note: without a display server (WSLg or an X server such as VcXsrv) the window won't show up.
> To validate only the backend: `cd src-tauri && cargo check`.

Frontend type-check only:

```bash
npx tsc --noEmit
```

### Build and release

```bash
npm run tauri build
```

The official installers for the three platforms are built by the GitHub Action
`.github/workflows/release.yml` when a `vX.Y.Z` tag is pushed.

### Shortcut configuration

The defaults live in `config/shortcuts.json` (bundled with the app). User customizations are saved in
the app's configuration folder, survive updates and override the defaults with the same name.

## License

Flowcode is distributed under the [Apache 2.0](LICENSE) license.
