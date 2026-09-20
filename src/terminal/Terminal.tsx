import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTheme } from "../themes/ThemeContext";
import { useTerminalSettings } from "./TerminalSettingsContext";
import { buildAsciiBanner, type BannerSystemInfo } from "./asciiBanner";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

function readTermColors() {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    // The container div already paints --term-bg (same glass surface as the
    // rest of the window). Giving xterm's own canvas a background too would
    // stack two translucent layers on top of each other, compositing to a
    // darker/more opaque result than every other panel - so it stays transparent.
    // xterm.js only accepts hex colors here (it matches /#[\da-f]{3,8}/) -
    // the CSS keyword "transparent" and rgba() syntax silently fail to parse
    // and fall back to opaque black, so this must be 8-digit hex.
    background: "#00000000",
    foreground: v("--term-fg", "#e6e6e6"),
    cursor: v("--accent", "#e6e6e6"),
    cursorAccent: v("--term-bg", "#000000"),
    // xterm.js's own ANSI defaults assume a dark background (pure white/
    // near-white foreground colors), which goes unreadable against the
    // light theme - both palettes are supplied explicitly per theme in
    // themes.css instead of relying on the built-in ones.
    black: v("--ansi-black", "#3a2c1c"),
    red: v("--ansi-red", "#cd3131"),
    green: v("--ansi-green", "#0dbc79"),
    yellow: v("--ansi-yellow", "#e5e510"),
    blue: v("--ansi-blue", "#2472c8"),
    magenta: v("--ansi-magenta", "#bc3fbc"),
    cyan: v("--ansi-cyan", "#11a8cd"),
    white: v("--ansi-white", "#e5e5e5"),
    brightBlack: v("--ansi-bright-black", "#666666"),
    brightRed: v("--ansi-bright-red", "#f14c4c"),
    brightGreen: v("--ansi-bright-green", "#23d18b"),
    brightYellow: v("--ansi-bright-yellow", "#f5f543"),
    brightBlue: v("--ansi-bright-blue", "#3b8eea"),
    brightMagenta: v("--ansi-bright-magenta", "#d670d6"),
    brightCyan: v("--ansi-bright-cyan", "#29b8db"),
    brightWhite: v("--ansi-bright-white", "#e5e5e5"),
    selectionBackground: v("--term-selection-bg", "rgba(120, 150, 200, 0.3)"),
  };
}

/** Quotes a path for the target shell: `'it's/here'` -> `'it'\''s/here'` on
 * POSIX shells (bash/zsh/...). cmd.exe (the Windows default) doesn't strip
 * single quotes at all - they'd become literal characters in the path, so
 * `cd`'s target simply wouldn't exist - and it has no path characters that
 * need escaping inside a double-quoted string (`"` isn't legal in a Windows
 * filename), so wrapping in plain double quotes is enough there.
 * `forcePosix` overrides the app's own host-platform guess for a tab whose
 * live shell doesn't match it - a WSL bash session inside an otherwise
 * Windows tab, most notably, where the host being Windows says nothing
 * about what's actually reading this command right now. */
function shellQuote(path: string, forcePosix = false): string {
  if (!forcePosix && document.documentElement.dataset.platform === "windows") return `"${path}"`;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

export interface TerminalHandle {
  clear: () => void;
  focus: () => void;
  refit: () => void;
  runCommand: (cmd: string) => void;
  /** Same as `runCommand`, but hides the injected command and its echo
   * entirely once the launched program redraws the prompt/title - the
   * terminal's on-screen content doesn't show the typed line at all. Meant
   * for shortcuts that launch a full-screen CLI (Claude Code, Codex), not
   * for arbitrary user-defined `runCommand` plugins where the typed command
   * is expected to stay visible. */
  runCommandSilently: (cmd: string) => void;
  /** Actually `cd`s the shell, but hides the injected command and its echo
   * entirely - the terminal's on-screen content doesn't change at all.
   * `forcePosix` - see `shellQuote` - is for a WSL tab: `path` there is
   * already the POSIX path bash itself expects (translated back from the
   * `\\wsl.localhost\...` form the explorer browses), not this app's own
   * host-platform path. */
  navigateSilently: (path: string, forcePosix?: boolean) => void;
  /** The backend pty session id for this tab's shell, once spawned - lets
   * the Agents sidebar match a `list_agent_sessions` result back to the tab
   * that owns it. `null` before the pty has finished spawning. */
  getPtyId: () => string | null;
  /** Whether a full-screen program currently owns this tab (see
   * `onBusyChange`) - a pull-based read of the same signal, for callers that
   * need the value at a specific moment rather than a running subscription. */
  isBusy: () => boolean;
}

interface TerminalViewProps {
  cwd?: string;
  hidden?: boolean;
  onTitleChange?: (title: string) => void;
  /** Fires whenever this tab's shell switches into/out of an alternate
   * screen buffer - the signal xterm itself gives for "a full-screen program
   * (vim, htop, Claude Code, Codex...) now owns the terminal", as opposed to
   * a plain shell prompt. Used to auto-suspend the file explorer's
   * click-to-`cd` link (injecting a `cd` into, say, Claude Code's input
   * would just type garbage into it) and to gate "save as favorite". */
  onBusyChange?: (busy: boolean) => void;
  /** Fires with the user's own typed command line, the moment they press
   * Enter - a best-effort local shadow of what's on the prompt line (built
   * from the same keystrokes this view forwards to the pty, not read back
   * from it), used to notice a shell-inside-the-shell (`wsl`, `ssh`, `docker
   * exec/run -it`) starting. Backspace is tracked; arrow-key/history editing
   * isn't, so a heavily-edited line can drift from what's really on screen -
   * acceptable here since the only thing read out of it is a leading command
   * name, not the full line. */
  onCommandLine?: (line: string) => void;
  /** A command to type and submit the moment this tab's shell is ready -
   * for a freshly-opened tab meant to run one specific thing (e.g. a CLI's
   * install/login command from a setup prompt), not a general-purpose API.
   * Only read once, at mount - reusing a TerminalView instance for a
   * different `runOnStart` later does nothing. */
  runOnStart?: string;
}

export const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>(
  ({ cwd, hidden, onTitleChange, onBusyChange, onCommandLine, runOnStart }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const runOnStartRef = useRef(runOnStart);
  const cwdRef = useRef(cwd);
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  const onCommandLineRef = useRef(onCommandLine);
  onCommandLineRef.current = onCommandLine;
  const lineBufferRef = useRef("");
  const { theme } = useTheme();
  const { fontSize, bannerEnabled } = useTerminalSettings();
  const bannerEnabledRef = useRef(bannerEnabled);
  bannerEnabledRef.current = bannerEnabled;
  const initialFontSizeRef = useRef(fontSize);

  // Absolute row (scrollback-inclusive) where a pending silent navigation's
  // injected `cd` started - real pty output is never touched or dropped, so
  // a second/third terminal tab can never get "stuck"; once the resulting
  // prompt redraw is detected (via the title-change signal below), those
  // in-between rows are collapsed back out with a standard VT erase, so
  // browsing folders never lengthens the terminal.
  const pendingCollapseRowRef = useRef<number | null>(null);
  const collapseSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function refit() {
    const term = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    const id = ptyIdRef.current;
    if (!term || !fitAddon || !containerRef.current) return;
    if (containerRef.current.clientWidth === 0 || containerRef.current.clientHeight === 0) return;
    fitAddon.fit();
    if (id) {
      invoke("pty_resize", { id, cols: term.cols, rows: term.rows }).catch(() => {});
    }
  }

  /** Arms the title-change-triggered collapse (see the `onTitleChange`
   * handler below) so the rows an injected command adds get erased once the
   * launched program redraws a titled prompt/screen, then sends the
   * command. Shared by `navigateSilently` (a `cd`) and `runCommandSilently`
   * (any other command, e.g. launching a full-screen CLI). */
  function writeSilently(data: string, safetyMs = 2000) {
    const id = ptyIdRef.current;
    const term = xtermRef.current;
    if (!id || !term) return;
    if (collapseSafetyRef.current) clearTimeout(collapseSafetyRef.current);
    const buf = term.buffer.active;
    pendingCollapseRowRef.current = buf.baseY + buf.cursorY;
    // If the launched program never redraws a titled prompt/screen (no OSC
    // title support, or something unexpected happened), give up on
    // collapsing rather than risk erasing unrelated later output.
    collapseSafetyRef.current = setTimeout(() => {
      pendingCollapseRowRef.current = null;
    }, safetyMs);
    invoke("pty_write", { id, data }).catch(() => {});
  }

  useImperativeHandle(ref, () => ({
    clear: () => xtermRef.current?.clear(),
    focus: () => xtermRef.current?.focus(),
    refit,
    runCommand: (cmd: string) => {
      const id = ptyIdRef.current;
      // `\r`, not `\n`: that's what xterm.js itself sends for a real Enter
      // keypress (see term.onData below) - matching it here, rather than
      // the more "written text" instinct of `\n`, is what makes ConPTY
      // (the Windows pty backend) actually treat this as pressing Enter
      // instead of leaving the line sitting there typed but unsubmitted.
      if (id) invoke("pty_write", { id, data: `${cmd}\r` }).catch(() => {});
    },
    // A launched full-screen CLI can take a while to draw its first titled
    // frame (cold start, update check, ...), longer than a plain `cd`'s
    // fresh prompt - a more generous safety window than navigateSilently's.
    runCommandSilently: (cmd: string) => writeSilently(`${cmd}\r`, 8000),
    // The collapse above only fires once xterm sees a title-change escape -
    // that's how bash/zsh's own prompt naturally signals "the injected
    // command is done", via PROMPT_COMMAND retitling on every prompt. cmd.exe
    // (the Windows default shell) never retitles on its own, plain `cd`
    // included, so nothing would ever trigger the collapse there and the
    // typed `cd` would just sit on screen looking like it did nothing.
    // Chaining an explicit `title` onto the `cd` forces that same signal -
    // using the real path as the title also happens to be exactly what
    // App.tsx's title handler needs to pick the new cwd/tab label back up.
    navigateSilently: (path: string, forcePosix = false) =>
      writeSilently(
        !forcePosix && document.documentElement.dataset.platform === "windows"
          ? `cd ${shellQuote(path)} && title ${path}\r`
          : `cd ${shellQuote(path, forcePosix)}\r`,
      ),
    getPtyId: () => ptyIdRef.current,
    isBusy: () => (xtermRef.current ? xtermRef.current.buffer.active.type !== "normal" : false),
  }));

  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = readTermColors();
    }
  }, [theme]);

  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.fontSize = fontSize;
      refit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize]);

  useEffect(() => {
    if (!hidden) requestAnimationFrame(refit);
  }, [hidden]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: initialFontSizeRef.current,
      fontFamily: "Menlo, Consolas, monospace",
      theme: readTermColors(),
      // buffer.active.type (used below to detect an alternate-screen app
      // like Claude Code before collapsing rows) is gated behind this flag
      // at runtime - without it xterm.js throws the moment it's read.
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    // This effect body only ever runs once per tab, at the moment it's
    // created (tabs stay mounted, just hidden, once switched away from - see
    // the `hidden` prop) - and every call site that creates one also makes
    // it the active tab immediately, so focusing here always lands on the
    // tab the user is actually looking at, letting them start typing without
    // an extra click.
    term.focus();
    // Only fit against a container that has actually been laid out. FitAddon
    // clamps to a 2x1 minimum rather than refusing, so fitting an unmeasured
    // container spawns the shell into a 2-column pty - which mangles its
    // banner/prompt beyond recognition even though the tab resizes correctly a
    // moment later. xterm's own 80x24 default is the better placeholder; the
    // ResizeObserver below (and the refit after spawn) correct it for real.
    if (containerRef.current.clientWidth > 0 && containerRef.current.clientHeight > 0) {
      fitAddon.fit();
    }
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Most shells emit an OSC title escape (e.g. bash's PROMPT_COMMAND) with
    // "user@host: cwd", and some update it further while a command runs -
    // that's the actual live "what's happening in this terminal" signal, and
    // also exactly when a silent navigation's fresh prompt has finished
    // drawing, so it doubles as the trigger to collapse the rows in between.
    const titleDisposable = term.onTitleChange((title) => {
      if (pendingCollapseRowRef.current !== null) {
        if (collapseSafetyRef.current) {
          clearTimeout(collapseSafetyRef.current);
          collapseSafetyRef.current = null;
        }
        const startRow = pendingCollapseRowRef.current;
        pendingCollapseRowRef.current = null;
        // The OSC title sequence is parsed (firing this callback) *before*
        // the prompt text that follows it in the same chunk has actually
        // been written - reading the cursor position synchronously here
        // would catch it mid-line (column 0, right after the preceding
        // linefeed), which is exactly why the collapse below used to land
        // the cursor at the start of the line instead of after the prompt.
        // Deferring a tick lets xterm finish writing the rest of the chunk
        // first, so the position read afterward is the real one.
        setTimeout(() => {
          const buf = term.buffer.active;
          // A launched full-screen program (e.g. Claude Code) can switch to
          // the terminal's alternate screen buffer before its first title
          // update - `startRow` was recorded against the primary buffer, so
          // diffing it against the alternate buffer's own (unrelated)
          // cursor position would be meaningless and risks erasing rows of
          // the program's own freshly drawn UI instead of the intended
          // leftover command line. The primary buffer is fully hidden by
          // the alt screen anyway, so there's nothing to clean up until the
          // program exits back to it - just give up here rather than guess.
          if (buf.type !== "normal") return;
          const linesToDelete = buf.baseY + buf.cursorY - startRow;
          const endCol = buf.cursorX;
          if (linesToDelete > 0) {
            // Cursor Previous Line x N (this also resets to column 1), then
            // Delete Line x N: jump back up to where the old prompt sat and
            // remove exactly the rows the injected `cd` + its fresh prompt
            // added, pulling that fresh prompt up to reclaim the old one's
            // spot - net zero rows added. DL leaves the cursor on that same
            // row but still at column 1, not at the end of the (shell-drawn)
            // prompt text it's now showing - readline still thinks it's
            // typing from that original column, so the next keystrokes
            // would land there and overwrite the prompt. Cursor Character
            // Absolute moves it back to match, keyed off the column it was
            // actually at (the true end of the fresh prompt).
            term.write(`\x1b[${linesToDelete}F\x1b[${linesToDelete}M\x1b[${endCol + 1}G`);
          }
        }, 0);
      }
      if (title) onTitleChangeRef.current?.(title);
    });

    const bufferDisposable = term.buffer.onBufferChange((buf) => {
      onBusyChangeRef.current?.(buf.type !== "normal");
    });

    // Registered now, not after pty_spawn resolves: xterm is live from this
    // point on, so anything typed while the shell is still starting is held
    // and flushed instead of vanishing (the first tab of a cold start is the
    // one that has a startup long enough to type into).
    const pendingInput: string[] = [];
    const dataDisposable = term.onData((data) => {
      const id = ptyIdRef.current;
      if (!id) {
        pendingInput.push(data);
        return;
      }
      invoke("pty_write", { id, data }).catch(() => {});

      // See `onCommandLine`'s own doc comment for what this shadow buffer
      // is (and isn't) good for. Arrow keys/function keys arrive from xterm
      // as one atomic ESC-led chunk - skipped whole, rather than scanned
      // char-by-char, so its non-ESC bytes don't get spliced into the
      // buffer as garbage. A pasted multi-line chunk has no such prefix, so
      // it's scanned to catch any \r/\n it carries.
      if (data.charCodeAt(0) !== 0x1b) {
        for (const ch of data) {
          if (ch === "\r" || ch === "\n") {
            const line = lineBufferRef.current;
            lineBufferRef.current = "";
            if (line.trim()) onCommandLineRef.current?.(line);
          } else if (ch === "\x7f" || ch === "\b") {
            lineBufferRef.current = lineBufferRef.current.slice(0, -1);
          } else if (ch >= " ") {
            lineBufferRef.current += ch;
          }
        }
      }
    });

    let unlistenOutput: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    let disposed = false;

    (async () => {
      // A quiet splash above the real prompt, not a competing banner: skips
      // itself on a too-narrow tab (see buildAsciiBanner) rather than wrap
      // and look broken. Awaited here, before the pty output listener/spawn
      // below, so it's always the very first thing written to this tab -
      // xterm's write queue is FIFO by call order, not by which async call
      // happens to resolve first, so writing it any later (e.g. off of its
      // own unawaited invoke) could race the shell's own first output and
      // land below it instead of above.
      if (bannerEnabledRef.current) {
        const sysInfo = await invoke<BannerSystemInfo>("system_info").catch(() => undefined);
        if (disposed) return;
        const banner = buildAsciiBanner(term.cols, sysInfo);
        if (banner) term.write(banner);
      }

      // The output listener has to be in place *before* pty_spawn, not after
      // it. The backend starts the shell and its reader thread inside that
      // call, and Tauri events are fire-and-forget: anything emitted before
      // `listen` has completed its own IPC round-trip reaches nobody. That is
      // not just cosmetic here - the very first thing ConPTY emits is `ESC[6n`
      // (a cursor-position query) and it then *waits* for the terminal's
      // reply before letting the session proceed. Miss that one query and the
      // shell never prints its banner, never draws a prompt and never acts on
      // anything typed - a tab that looks dead because it is, on both ends.
      // (Measured: an unanswered ESC[6n yields 4 bytes of output and a shell
      // that ignores input forever; answering it yields the normal banner,
      // prompt and echo.) Every tab raced that window and the first tab of a
      // cold start lost, because that is when the round-trip is slowest -
      // first event-plugin call, main thread busy with the initial render.
      //
      // xterm.js answers the query itself, but only once it has been *given*
      // the bytes, and it answers through `onData` - which is why that handler
      // is hooked up above the spawn too, with a queue for anything it
      // produces before there is a pty id to send it to.
      //
      // Which pty is "ours" isn't known until pty_spawn returns, so output is
      // parked per id until then and the matching id's backlog is replayed;
      // the other ids belong to other tabs, which have their own listeners,
      // so those are simply dropped.
      let ourId: string | null = null;
      const buffered = new Map<string, string[]>();
      const exitedEarly = new Set<string>();

      unlistenOutput = await listen<{ id: string; data: string }>("pty://output", (event) => {
        const { id: eventId, data } = event.payload;
        if (ourId === null) {
          const backlog = buffered.get(eventId);
          if (backlog) backlog.push(data);
          else buffered.set(eventId, [data]);
          return;
        }
        if (eventId === ourId) term.write(data);
      });
      unlistenExit = await listen<{ id: string }>("pty://exit", (event) => {
        const eventId = event.payload.id;
        if (ourId === null) {
          exitedEarly.add(eventId);
          return;
        }
        if (eventId === ourId) term.write("\r\n[process exited]\r\n");
      });
      // The cleanup below can have already run while those awaits were in
      // flight, in which case it saw both handles still undefined - unhook
      // here instead of leaking a listener onto a disposed terminal.
      if (disposed) {
        unlistenOutput?.();
        unlistenExit?.();
        return;
      }

      const id = await invoke<string>("pty_spawn", {
        // "" (the initial tab, before homeDir has loaded) must reach the
        // backend as no cwd at all, not as an empty string - portable_pty's
        // CommandBuilder::cwd("") sets lpCurrentDirectory to "" on Windows,
        // which CreateProcessW treats as an invalid working directory rather
        // than "inherit the current one", breaking that shell silently (no
        // prompt, no cursor, but no error either - it just never starts
        // right).
        cwd: cwdRef.current || null,
        cols: term.cols,
        rows: term.rows,
      });
      if (disposed) {
        unlistenOutput?.();
        unlistenExit?.();
        invoke("pty_kill", { id }).catch(() => {});
        return;
      }
      ptyIdRef.current = id;
      ourId = id;
      const backlog = buffered.get(id) ?? [];
      buffered.clear();
      const exitedBeforeReplay = exitedEarly.has(id);
      exitedEarly.clear();

      // Everything below reads the terminal's cursor position
      // (writeSilently, via pendingCollapseRowRef) or otherwise assumes the
      // backlog is actually on screen - `term.write()` parses asynchronously
      // (its own write buffer defers large/queued chunks to keep the UI
      // responsive), so without this callback the very next line could run
      // before the banner above was actually applied, reading a stale
      // (pre-banner) cursor row. That mismeasurement is exactly what let the
      // injected `prompt` command below show up unhidden instead of
      // collapsing away - the collapse math was working off the wrong start
      // row. `term.write(data, cb)` guarantees `cb` runs only once `data`
      // has actually been parsed.
      const afterBacklog = () => {
        if (exitedBeforeReplay) term.write("\r\n[process exited]\r\n");

        // The pty was sized from whatever xterm measured at mount; if the
        // container hadn't been laid out yet that is a placeholder, so push
        // the real size across now that there is a session to resize.
        refit();

        for (const data of pendingInput.splice(0)) {
          invoke("pty_write", { id, data }).catch(() => {});
        }

        // Windows retitling (cmd.exe never does it on its own, unlike
        // bash/zsh) is set up at spawn time via `cmd.exe /k prompt ...` -
        // see pty.rs's pty_spawn - not by typing a `prompt` command into the
        // already-running shell here, which used to echo visibly and rely on
        // a fragile row-collapse trick to erase it again.

        if (runOnStartRef.current) {
          invoke("pty_write", { id, data: `${runOnStartRef.current}\r` }).catch(() => {});
        }
      };

      if (backlog.length > 0) term.write(backlog.join(""), afterBacklog);
      else afterBacklog();
    })();

    const resizeObserver = new ResizeObserver(() => refit());
    resizeObserver.observe(containerRef.current);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      titleDisposable.dispose();
      bufferDisposable.dispose();
      dataDisposable.dispose();
      if (collapseSafetyRef.current) clearTimeout(collapseSafetyRef.current);
      unlistenOutput?.();
      unlistenExit?.();
      if (ptyIdRef.current) {
        invoke("pty_kill", { id: ptyIdRef.current }).catch(() => {});
      }
      term.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{ display: hidden ? "none" : "flex" }}
    />
  );
});

TerminalView.displayName = "TerminalView";
