# Tablet layout ↔ desktop parity

Goal: the phone app's wide layout (`mobile/src/WideShell.tsx`, ≥ 760 px) mirrors the desktop shell
(`src/App.tsx`) as far as touch allows. Reference = the desktop; no variants.

| Phase | Scope | Proto | Status |
|---|---|---|---|
| 1 | Strip order by window + `order` (shared `remoteEntries`), window separators; terminal→chat (`onChat`) and delegate open (`onOpenChat`) in wide; "done" tab state; long-press tab menu (rename, close); header order like desktop (files · host · tabs · quick actions · features · ⋮); ⋮ menu gains zoom row + theme | no | done (untested on device) |
| 2 | Right panel = agent insight of the front agent (Context / Usage / Delegates tabs, tools inside Context) instead of the agents list | no (chat store) | done (untested on device) |
| 3 | Left panel = Explorer tree / Git / History tabs | yes: `git`, `history`, `resume` | done (untested on device) |
| 4 | Browser docked as a right panel from 1100 px | no | done (untested on device) |
| 5 | Hardware keyboard shortcuts (Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+T, Ctrl+W, Ctrl+\`, Ctrl+B, Ctrl+1..9) | no | done (untested on device) |
| 6 | "+" opens a new-tab page in the main card (launcher) instead of the sheet | no | done (untested on device) |
| 7 | Tab duplicate / notifications toggle (terminals) / drag reorder within a window (`tabDrag.ts`) | yes: `tabop`, cap `tabOps`, `notify` on Tab | done (untested on device; touch drag is the main risk) |
| 8 | ⋮ menu "Novità" sheet (`WideChangelog.tsx`, phone `release_notes` command); quick-action usage mini bar + popover (`WideUsageAction.tsx`) | no | done (untested on device) |

Touch-only extras kept: key bar, Ctrl+C, pin panels.
