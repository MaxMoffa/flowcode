# Contributing to Flowcode

Thanks for wanting to help! Flowcode is a desktop app (Tauri: Rust + React) with an Android companion app,
and it drives other people's AI agents on other people's machines. That makes a few things matter more than
usual: it must work the same on Windows, macOS and Linux (and WSL), it must never trust what comes from a web
page, an agent or the network, and it must stay smooth. This guide explains how the project is organised and
the rules every change follows.

- [Ways to contribute](#ways-to-contribute)
- [Before you start](#before-you-start)
- [Setting up](#setting-up)
- [Project map](#project-map)
- [Rules for code](#rules-for-code)
- [Tests and checks](#tests-and-checks)
- [Commits and pull requests](#commits-and-pull-requests)
- [Contributing with AI agents](#contributing-with-ai-agents)
- [License](#license)

## Ways to contribute

- **Report a bug**: open an issue with the *Bug report* template. Say which OS (and WSL distro, if any), which
  agent, the Flowcode version (Settings → Version and updates → *Copy version info*) and the steps. A crash report from the app's crash dialog
  helps a lot.
- **Suggest a feature**: open an issue with the *Feature request* template. Describe the problem first, then
  the idea.
- **Fix or build something**: see below. Small, focused pull requests are merged fastest.
- **Translate**: every string lives in a catalog per language (see [i18n](#user-facing-text-and-i18n)).
- **Write a plugin**: plugins are declarative JSON manifests; see [PLUGINS.md](PLUGINS.md).

## Before you start

- For anything bigger than a small fix, **open an issue first** so we can agree on the approach before you
  write code.
- Larger features get a short design note in `docs/design/` (`<topic>-plan.md`): the problem, the chosen
  design, the files it touches, risks and a manual test checklist. Look at the existing ones for the format.
  UI work often starts with an HTML mockup of two or three variants in the same folder.
- Adding support for a new agent? Follow the checklist in
  [docs/agents-integration-map.md](docs/agents-integration-map.md).
- Changing what the phone and the desktop say to each other? Read
  [docs/remote-protocol.md](docs/remote-protocol.md) first.

## Setting up

Requirements and the basic commands are in the README, under
[For developers](README.md#for-developers). In short:

```bash
npm install
npm run tauri dev        # desktop app with hot reload
npm run mobile:vite      # phone UI in a browser; add ?mock to the URL for mock data
```

**Windows:** the Rust crate builds whisper.cpp (local dictation), which needs clang-cl and Ninja. Before any
`cargo` command, in PowerShell:

```powershell
. .\scripts\cargo-env.ps1
```

If a build fails in `whisper-rs-sys` with a CMake *generator* mismatch, a cargo run from another shell left a
stale cache: delete `src-tauri/target/debug/build/whisper-rs-sys-*/out/build` and build again from the
PowerShell above.

## Project map

```
src/                    desktop frontend (React + TypeScript)
  app/                  window shell: tabs, panels, session restore (App.tsx is only the orchestrator)
  chat/                 chat view of ACP agents: model (chatModel.ts), view (ChatBody.tsx), cards
  terminal/             xterm.js terminals and the tab strip
  browser/              in-app browser (native child webviews + our own status pages)
  settings/ i18n/ ...   settings pages, translation catalogs
  lib/ hooks/           shared helpers: motion tokens, presence, storage
src-tauri/              Rust backend
  src/chat/             ACP client: one agent process per chat, its turn state machine, delegation
  src/agents/           agent detection and launching (native, WSL)
  src/remote/           phone link (iroh QUIC), its dispatch and streams
  src/chat_mcp.rs       Flowcode's MCP server for agents (open_in_browser, delegate_task, messages, browser_*)
  remote-proto/         the phone ⇄ desktop protocol crate (shared with the phone)
mobile/                 Android companion app (Tauri + React); Kotlin plugins under mobile/src-tauri/gen/android
shared/                 code used by both the desktop and the phone (markdown, chat session, formatting)
sdk/                    agent view SDK
docs/                   protocol docs, design notes (docs/design), release notes (docs/releases)
site/                   the project website (GitHub Pages)
```

## Rules for code

### General

- **One change, one purpose.** Don't mix a fix with an unrelated refactor or reformatting.
- **No dead code.** Remove what you replace: unused exports, CSS selectors, i18n keys, Tauri commands.
  `npx knip` lists unused TypeScript exports and files.
- **Keep files cohesive.** When a file grows past a few hundred lines with several concerns, split it by
  concern (see `src/app/` for how `App.tsx` was split).
- **Desktop and phone share logic through `shared/`.** If you are about to copy a function from `src/` to
  `mobile/src/` (or back), move it to `shared/` instead and import it from both.
- **No debugging leftovers**: no `console.log`, no commented-out code, no `TODO` without an issue.

### Comments

Comments explain **why**, not what. Write them as plain, short sentences next to the code they justify: the
platform quirk being worked around, the race being prevented, the reason a simpler approach doesn't work.
Doc comments (`///`, `/** */`) on every non-obvious function and on struct fields that carry an invariant.

### TypeScript and React

- TypeScript strict; no `any` unless a boundary truly has no type (and then narrow it right away).
- Function components and hooks. Effects clean up everything they start: listeners, timers, observers,
  Tauri `listen` handles (await the unlisten).
- Hot paths (a streaming chat, terminal output, drags, resizes) must not re-render the whole window: keep
  per-frame work out of React state (refs, CSS variables), memoize heavy children with stable props.
- Pure logic (parsing, reducers, state machines) lives in plain `.ts` modules so it can be unit-tested.

### Rust

- `cargo` must build warning-free for the code you touch.
- **Never panic on outside data** (agent output, phone messages, files, the network): no `unwrap`/`expect`
  or unchecked slicing there. Release builds abort on panic, which closes the whole app.
- Don't hold a lock across `.await`, a blocking call or an emit. When several locks are involved, follow the
  order documented next to them (for chats: log, then status, then permissions).
- Child processes and threads must end with their owner: kill what you spawn, bound what you queue.
- Blocking work (process spawning, disk scans) runs on the blocking pool, never on the main thread.

### Cross-platform

- Every change must make sense on Windows, macOS and Linux, and for agents running inside WSL. Use the
  existing path helpers instead of string concatenation; remember `\\wsl.localhost\...` paths and CRLF files.
- If you can only test on one platform, say so in the pull request.

### Security

Flowcode runs agents with the user's permissions, so treat these as hard rules:

- **Untrusted input stays untrusted**: web pages in the in-app browser, text written by agents, messages from
  other agents, repository content, anything from the phone or the network. Validate it at the boundary.
- **Never build a shell command from untrusted strings.** Spawn programs with an argument list.
- Agent-facing tools (the MCP server) that act on the user's behalf need explicit consent or a strict
  allow-list. Never widen what an agent may do without asking the user.
- No secrets in logs, crash reports or error messages. API keys are stored sealed (DPAPI / Keystore), never
  in plain settings.
- Only `http(s)` URLs are opened. Don't relax the CSP, the webview capabilities or the iframe sandboxes
  without discussing it in an issue first.
- Phone ⇄ desktop protocol changes must stay **backward compatible** (new fields optional, new behaviour
  behind a capability flag) so older phones and desktops keep working.

### User-facing text and i18n

- Every string the user can see goes through the translation function: no hard-coded text in components.
- Add each new key to **all** catalogs: desktop `src/i18n/locales/en.ts` and `it.ts`, phone
  `mobile/src/i18n.ts` (both languages). English is the reference; keep the tone short and friendly.
- Remove keys you stop using.

### UI and motion

- Reuse the existing components and styles (cards, menus, dialogs) before creating new ones.
- Animate only `transform`, `opacity` and `clip-path`; never `width`, `height`, `top` or `max-height`.
  Heights open and close with the grid `0fr → 1fr` pattern (`src/lib/Reveal.tsx`).
- Use the motion tokens (`--dur-*`, `--ease-*` in the theme, `src/lib/motion.ts`) and `usePresence` for
  enter/exit animations; respect `prefers-reduced-motion`.
- Avoid `backdrop-filter` and big shadows on things that move or sit over scrolling content.
- Check light and dark themes, and a narrow window.

## Tests and checks

Add tests with your change: Vitest for TypeScript logic (`*.test.ts` next to the module), Rust unit tests in
a `#[cfg(test)] mod tests` at the bottom of the file. A bug fix comes with a test that fails without it,
whenever that's possible.

Before opening a pull request, run what CI runs:

```bash
npm run build                 # typecheck (desktop + phone) and frontend build
npm run mobile:vite:build     # phone frontend build
npm test                      # Vitest
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path mobile/src-tauri/Cargo.toml
```

Kotlin (the Android plugins and widgets) is compiled by CI only; be extra careful there and say if you could
not build the Android app.

For UI changes, also try them in the running app (`npm run tauri dev`) and describe what you checked.

## Commits and pull requests

- **Conventional Commits**: `type(scope): summary`, imperative and lower-case, under ~70 characters.
  Types: `feat`, `fix`, `perf`, `refactor`, `chore`, `docs`, `test`. Scope is the area: `chat`, `browser`,
  `mobile`, `remote`, `agents`, `ui`, ...
  Example: `fix(browser): reopening a failed page retries it`.
- The body says **why** and anything a reviewer should know; bullet points are fine.
- Work on a branch and open a pull request against `master`. Keep it focused, fill in the template, link the
  issue, add screenshots or a short video for UI changes, and list the platforms you tested.
- CI must be green. Reviews may ask for changes: that's normal, not a rejection.
- Releases (version bumps, tags, release notes) are done by the maintainers; don't bump versions in a PR.

## Contributing with AI agents

Flowcode is built for working with AI agents, and contributions written with their help are welcome. You
stay the author: read and understand every line you submit, run the checks yourself, and make sure the
change follows this guide. Don't submit code you can't explain. If you like, credit the agent with a
`Co-Authored-By:` trailer in the commit.

## License

Flowcode is released under the [Apache License 2.0](LICENSE). By submitting a contribution you agree that it
is licensed under the same terms.
