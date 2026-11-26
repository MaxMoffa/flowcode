## What and why

<!-- What does this change do, and why is it needed? Link the issue: "Closes #123". -->

## How it works

<!-- The approach, in a few lines. Anything a reviewer should look at closely (locks, protocol, security)? -->

## Tested on

- [ ] Windows
- [ ] macOS
- [ ] Linux
- [ ] WSL agent
- [ ] Android app

<!-- What you tried in the running app. Screenshots or a short video for UI changes. -->

## Checklist

- [ ] `npm run build`, `npm run mobile:vite:build` and `npm test` pass
- [ ] `cargo test` passes for `src-tauri` (and `mobile/src-tauri` if touched)
- [ ] Tests added or updated for the change
- [ ] New user-facing text is translated in every catalog (desktop `en`/`it`, phone `mobile/src/i18n.ts`)
- [ ] No dead code left behind; follows [CONTRIBUTING.md](../CONTRIBUTING.md)
