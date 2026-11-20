# Agent detection reliability — study + plan (2026-11-20)

Goal for next release: terminal-tab agent detection (bar with Chat/Terminal
switch) as reliable as possible for claude, codex, gemini, opencode, cline, vibe,
on Windows, macOS, Linux and WSL.

Sources: 4 parallel studies (empirical Windows lab with real ConPTY + sysinfo
0.32.1, per-agent install/process-shape audit, detection→bar path audit,
alternative-signal design). Lab: `%TEMP%\fc-detect-lab` (180+ reps).

## Findings

### Confirmed by measurement (Windows lab)
- PowerShell / cmd tabs, every launch form (codex, codex.cmd, node codex.js,
  vendor codex.exe, provider shim) for codex/claude/vibe/cline: **100 %**,
  latency ≤ 2.2 s (worst 4.2 s, slow PowerShell command resolution).
- **Git Bash interactive `codex` (and any npm sh-shim agent: cline, gemini,
  opencode): 0 %.** MSYS fork+exec leaves `sh.exe` with a dead parent pid, so
  the BFS from the tab shell never reaches it. Native exes (claude, vibe) fine.
  Git Bash also ignores the `.cmd` provider shim (profile auth env lost).
- sysinfo returns stale ppids of dead parents → possible false edges (orphan
  `codex app-server --managed-daemon`, reused pids) → false positives.
- Windows OnlyIfNotSet is fine (no exec, empty cmd re-read).

### Code audit
1. **No hysteresis** (App.tsx:1710 rebuilds per poll): one missed poll removes
   the bar and refits xterm → "sometimes no bar".
2. **Poll stalls behind WSL**: any WSL tab makes every poll spawn `wsl.exe`
   (10 s timeout, cache 1.5 s < poll 2 s); `agentSessions.ts:107` skips ticks
   while a call is in flight → host tabs get the bar 10–20 s late.
3. First/timed-out WSL scan returns an empty result to concurrent callers
   (wsl.rs:96-121).
4. WSL attribution only via `FLOWCODE_PTY_ID` in `/proc/*/environ`: tmux,
   screen, sudo, `env -i` lose it or point to the wrong tab.
5. `find_wsl_client` only accepts `wsl.exe`: `bash`, `ubuntu*.exe` launchers missed.
6. Any panic in an enrichment reader freezes the whole list (error → previous result).
7. Codex without a prompt yet has no session_id → "switch to chat" silently
   opens a fresh chat.

### Per agent (process-shape audit)
| Agent | Gaps |
|---|---|
| claude | old npm `cli.js` (≤2.0) runs as `node` → no `node_runs_claude` (✗ Win/mac); launch by version path `versions/2.1.x` ✗ (rare) |
| codex | Git Bash ✗ (above); macOS exec staleness (fixed e884ace); Linux host asdf bash shim stale ~ |
| gemini | node argv check only args 1-3 (flaky with interpreter flags, false positive `node x.js gemini`) |
| opencode | WSL full-path `opencode.exe` ✗; loose `ends_with` false positives |
| cline | Linux/mac npm: native child is `.cline`, no node rule → ✗ |
| vibe | setproctitle → `"Vibe CLI"`: Linux ~✗, WSL ✗ always (case-sensitive list), macOS ✗ (python name, no rule) |
| all | Linux host: name/cmd/exe never refreshed after exec (no Linux `refresh_execed`); bun-run JS ✗; tmux/ssh not in tree |

macOS fix from e884ace has a perf issue: `refresh_execed` compares realpath
(`proc_pidpath`) with sysinfo's unresolved exe → every symlinked binary
(Homebrew, node, claude) is re-read every poll. Canonicalise before comparing.
macOS shim may be bypassed (login zsh `path_helper` / brew shellenv reorder
PATH) — verify with `echo $PATH` in a Mac tab.

## Plan — next release

**P1 Sticky identity + hysteresis (backend `agents/tracker.rs`).** Per pty keep
`{pid, start_time, cli}` once matched; each poll only verifies pid alive with
same start time; drop on exit, else after 2 consecutive misses. Frontend keeps
last session ~2 misses unless pty exited.

**P2 Env-tag fallback on host (all OS).** Tabs without a BFS match: candidates =
processes whose name/argv passes agent rules; read environ only for them
(sysinfo `with_environ`, OnlyIfNotSet, ~22 ms once); match
`FLOWCODE_PTY_ID=<pty>`; oldest wins (same rule as `wsl_agents`). Fixes Git Bash
0 %, orphaning launchers, broken parent chains. Prototype verified in lab.

**P3 Unified matcher.** One `classify(name, exe, argv)` used by host and WSL:
- shim process classified by its `--flowcode-provider <cli>` argument;
- interpreters `node|bun|deno|python*` → script basename / package path
  (`@openai/codex`, `@google/gemini-cli`, `@anthropic-ai/claude-code`, `cline`,
  `opencode-ai`, `vibe`), only first non-flag arg;
- name normalisation: strip leading `.`, accept `<bin> ` and `<bin>-`
  (`vibe cli`), case-insensitive in WSL too; `argv[0]` basename for
  process.title rewrites; claude version-path exe.

**P4 Fresh reads for tab subtrees.** Re-read name/argv/exe only for pids in a
tab's subtree that are wrappers (shell, interpreter, flowcode) — Linux via
`/proc/<pid>/comm|cmdline|exe`, macOS via existing `refresh_execed` (+
canonicalise fix, + cwd). Keeps cost tiny.

**P5 Drop stale parent edges** (`child.start_time < parent.start_time`) in
`children_of` (agents/mod.rs:342) and `foreground_by_tree`.

**P6 WSL decoupled.** WSL scan in its own background task + cache ≥ poll
interval; `list_agent_sessions` never waits on it; concurrent callers wait for
the running scan instead of getting `Default`. `find_wsl_client` also accepts
System32 `bash.exe` and distro launchers. Fallback attribution by pts/tree when
env tag missing.

**P7 Robustness.** Per-reader `catch_unwind`/error isolation so bare sessions
are always returned; frontend logs errors.

**P8 Diagnostics.** Debug command/setting dumping per tab: subtree (pid, ppid,
name, exe, argv, start), matcher decision, env-tag hits, lock/registry hits →
log file. Lets testers send evidence for remaining misses.

**P9 Latency (optional).** Trigger a targeted rescan of one tab ~300 ms after
Enter / on OSC title change; push event `agent-sessions-changed`.

Later: OSC 133/633 shell integration, agent-set OSC titles as trigger, shim
registration file, per-tab Windows job + completion port, macOS kqueue,
tmux client attribution.

## Test matrix after implementation
Lab (`%TEMP%\fc-detect-lab`) re-run with new matcher: pwsh/cmd/Git Bash × all
installed CLIs × shim on/off × poll offsets; WSL tab codex/claude/cline plus
tmux; Mac tester: brew codex, npm codex, claude native, `echo $PATH`.

## Status (2026-11-20)
P1–P8 implemented (P9 not). Windows lab re-run on the new code: Git Bash
codex/cline 0/20 → 20/20 (env tag), all pwsh/cmd/shim scenarios 20/20,
orphaned `codex app-server` / `cline --cline-hub-daemon` ignored, killed agent
dropped next poll, multi-tab no cross-attribution, idle tabs no false
positives; cost ~20 ms/poll (env fallback ~+15 ms before the environ-cache
fix). Lab fixes applied: shim tabs report the real CLI pid (registry/status),
`refresh_environ` skips cached pids, Codex helper exes excluded.
Not verified: macOS/Linux code (not compiled here), WSL launcher/tty paths on a
real machine, diagnostics menu item in the app.
