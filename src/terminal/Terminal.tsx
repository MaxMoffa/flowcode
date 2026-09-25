import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useContextMenu } from "../context-menu/ContextMenuContext";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { attachPty, detachPty, killPty, resizePty, spawnPty, writePty } from "./ptyClient";
import { useTheme } from "../themes/ThemeContext";
import { useTerminalSettings } from "./TerminalSettingsContext";
import { buildAsciiBanner, type BannerSystemInfo } from "./asciiBanner";
import { t } from "../i18n";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

/** --term-bg's RGB as `#rrggbb00`: fully transparent to paint (see the
 * `background` comment below), but xterm still reads the RGB channels -
 * it's what `minimumContrastRatio` checks text against and what it reports
 * to apps that query the background (OSC 11). A plain `#00000000` made both
 * treat every theme as black: dark-tuned colors were left unreadable on the
 * light theme, and apps deriving a panel shade from the reported background
 * drew it off-tone. */
function termBackgroundHex(): string {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;background:var(--term-bg)";
  document.body.appendChild(probe);
  const bg = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const [r = 0, g = 0, b = 0] = (bg.match(/[\d.]+/g) ?? []).map(Number);
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}00`;
}

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
    background: termBackgroundHex(),
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

export interface TerminalHandle {
  clear: () => void;
  /** Copies the current selection to the clipboard (no-op without one). */
  copySelection: () => void;
  /** Pastes the clipboard as if typed (bracketed-paste aware). */
  paste: () => void;
  runCommand: (cmd: string) => void;
  /** Same as `runCommand`, but hides the injected command and its echo
   * entirely once the launched program redraws the prompt/title - the
   * terminal's on-screen content doesn't show the typed line at all. Meant
   * for shortcuts that launch a full-screen CLI (Claude Code, Codex), not
   * for arbitrary user-defined `runCommand` plugins where the typed command
   * is expected to stay visible. */
  runCommandSilently: (cmd: string) => void;
  /** Types a `cd` (built for the shell at the prompt - see shellDialect.ts's
   * `cdCommand`), but hides it and its echo entirely - the terminal's
   * on-screen content doesn't change at all. */
  navigateSilently: (cdCommand: string) => void;
  /** The backend pty session id for this tab's shell, once spawned - lets
   * the Agents sidebar match a `list_agent_sessions` result back to the tab
   * that owns it. `null` before the pty has finished spawning. */
  getPtyId: () => string | null;
  /** This tab's normal-screen text (with colors) for session restore - the
   * last `SESSION_SCROLLBACK_LINES` lines, never a full-screen program's
   * alternate screen (that frame means nothing once the program is gone). */
  serialize: () => string;
  /** Whether anything was ever sent to this tab's shell on the user's
   * behalf - typed/pasted input, a command run in it, an explorer `cd`.
   * A tab that's still `false` at exit is a virgin one (opened, never
   * touched), which session restore doesn't bring back. */
  wasUsed: () => boolean;
  /** Hands this tab's running session over for a move to another window:
   * stops its output reaching this terminal (the program keeps running),
   * then snapshots the screen exactly as shown - scrollback, a full-screen
   * program's alternate screen and the terminal modes it set. Once released,
   * unmounting this view no longer kills the session. `null` when there's no
   * session yet to move. */
  release: () => Promise<TerminalTransfer | null>;
}

/** A running terminal session on its way to another window - see
 * `TerminalHandle.release` and the `attach` prop. */
export interface TerminalTransfer {
  ptyId: string;
  snapshot: string;
}

/** What xterm itself answers on the shell's behalf - cursor position /
 * device attribute / status reports, focus in/out, OSC color queries - so
 * none of it counts as the user having actually used the tab. */
const TERMINAL_REPORT = /^(?:\x1b\[[\d;?>]*[Rcn]|\x1b\[[IO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/;

const SESSION_SCROLLBACK_LINES = 2000;

interface TerminalViewProps {
  /** This tab's own id - used only to look up its per-tab zoom override
   * (see TerminalSettingsContext's `getTabFontSize`), same idea as a
   * browser's per-tab zoom. */
  tabId: string;
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
  /** One-off shell for this tab, overriding the configured default (see
   * TerminalSettingsContext's `shellId`) - set by the "+" button's own
   * context menu when a specific shell (e.g. WSL) was picked instead of
   * just clicking it. Only read once, at spawn, same as `runOnStart`. */
  shellOverride?: string;
  /** Text saved from this tab in the previous session (see `serialize`) -
   * replayed in place of the banner before the new shell starts. Only read
   * once, at mount, like `runOnStart`. */
  restoredContent?: string;
  /** A session moved here from another window (see `release`): its screen
   * is redrawn from the snapshot and it keeps running - nothing is spawned.
   * Only read once, at mount. */
  attach?: TerminalTransfer;
}

export const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>(
  ({ tabId, cwd, hidden, onTitleChange, onBusyChange, onCommandLine, runOnStart, shellOverride, restoredContent, attach }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // xterm mounts into this padding-free inner box, not the padded container:
  // FitAddon sizes the grid off its parent's computed height, which under
  // border-box includes padding - so opening straight into the container
  // made the rows overflow into (and past) the padding.
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const restoredContentRef = useRef(restoredContent);
  const ptyIdRef = useRef<string | null>(null);
  const attachRef = useRef(attach);
  // `seq` of the last output written here (see ptyClient's `detachPty`).
  const lastSeqRef = useRef(0);
  // Set once this tab's session has been handed to another window - its pty
  // must then outlive this view.
  const releasedRef = useRef(false);
  const runOnStartRef = useRef(runOnStart);
  // A tab opened to run something (agent session, install command) is in
  // use from the start - see `wasUsed`. So is one moved here mid-session.
  const usedRef = useRef(!!runOnStart || !!attach);
  const cwdRef = useRef(cwd);
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  const onCommandLineRef = useRef(onCommandLine);
  onCommandLineRef.current = onCommandLine;
  const lineBufferRef = useRef("");
  const { theme } = useTheme();
  const { getTabFontSize, bannerEnabled, shellId, confirmLinkOpen, setConfirmLinkOpen } = useTerminalSettings();
  const { show: showMenu } = useContextMenu();
  // xterm's link callbacks are registered once at mount - read the live
  // setting/menu through a ref instead of the values captured back then.
  const linkClickRef = useRef<(event: MouseEvent, uri: string) => void>(() => {});
  linkClickRef.current = (event, uri) => {
    // Only web links: OSC 8 hyperlinks can carry any scheme (file:, custom
    // app protocols...), which a click shouldn't hand to the OS.
    if (!/^https?:\/\//i.test(uri)) return;
    const open = () => {
      openUrl(uri).catch(() => {});
    };
    if (!confirmLinkOpen) {
      open();
      return;
    }
    const shown = uri.length > 60 ? `${uri.slice(0, 57)}…` : uri;
    showMenu(event.clientX, event.clientY, [
      { label: shown, disabled: true },
      { label: "link-separator", separator: true },
      { label: t("link.open"), onSelect: open },
      {
        label: t("link.openAlways"),
        onSelect: () => {
          setConfirmLinkOpen(false);
          open();
        },
      },
      { label: t("link.copy"), onSelect: () => navigator.clipboard.writeText(uri).catch(() => {}) },
    ]);
  };
  const fontSize = getTabFontSize(tabId);
  const bannerEnabledRef = useRef(bannerEnabled);
  bannerEnabledRef.current = bannerEnabled;
  // Read at spawn time only (like bannerEnabledRef above) - changing the
  // shell in Settings takes effect on the next new tab, not by tearing down
  // whatever's already running in existing ones.
  const shellIdRef = useRef(shellOverride ?? shellId);
  shellIdRef.current = shellOverride ?? shellId;
  const initialFontSizeRef = useRef(fontSize);

  // Absolute row (scrollback-inclusive) where a pending silent navigation's
  // injected `cd` started - real pty output is never touched or dropped, so
  // a second/third terminal tab can never get "stuck"; once the resulting
  // prompt redraw is detected (via the title-change signal below), those
  // in-between rows are collapsed back out with a standard VT erase, so
  // browsing folders never lengthens the terminal.
  const pendingCollapseRowRef = useRef<number | null>(null);
  const collapseSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Size last pushed to the pty - the ResizeObserver fires for every layout
  // tweak (sidebar drag, window resize frames), and most of those don't
  // change the cell grid at all, so there's nothing worth an IPC call.
  const ptySizeRef = useRef({ cols: 0, rows: 0 });

  function refit() {
    const term = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    const container = containerRef.current;
    if (!term || !fitAddon || !container) return;
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    fitAddon.fit();
    const id = ptyIdRef.current;
    const last = ptySizeRef.current;
    if (id && (last.cols !== term.cols || last.rows !== term.rows)) {
      ptySizeRef.current = { cols: term.cols, rows: term.rows };
      resizePty(id, term.cols, term.rows);
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
    usedRef.current = true;
    writePty(id, data);
  }

  useImperativeHandle(ref, () => ({
    clear: () => xtermRef.current?.clear(),
    copySelection: () => {
      const selection = xtermRef.current?.getSelection();
      if (selection) navigator.clipboard.writeText(selection).catch(() => {});
    },
    paste: () => {
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) xtermRef.current?.paste(text);
        })
        .catch(() => {});
    },
    runCommand: (cmd: string) => {
      const id = ptyIdRef.current;
      // `\r`, not `\n`: that's what xterm.js itself sends for a real Enter
      // keypress (see term.onData below) - matching it here, rather than
      // the more "written text" instinct of `\n`, is what makes ConPTY
      // (the Windows pty backend) actually treat this as pressing Enter
      // instead of leaving the line sitting there typed but unsubmitted.
      if (id) {
        usedRef.current = true;
        writePty(id, `${cmd}\r`);
      }
    },
    // A launched full-screen CLI can take a while to draw its first titled
    // frame (cold start, update check, ...), longer than a plain `cd`'s
    // fresh prompt - a more generous safety window than navigateSilently's.
    runCommandSilently: (cmd: string) => writeSilently(`${cmd}\r`, 8000),
    // The collapse above only fires once xterm sees a title-change escape -
    // that's how bash/zsh's own prompt naturally signals "the injected
    // command is done", via PROMPT_COMMAND retitling on every prompt, and
    // what the prompts pty.rs gives cmd.exe/PowerShell do too. That title is
    // also exactly what App.tsx's title handler needs to pick the new
    // cwd/tab label back up.
    navigateSilently: (cdCommand: string) => writeSilently(`${cdCommand}\r`),
    getPtyId: () => ptyIdRef.current,
    wasUsed: () => usedRef.current,
    serialize: () =>
      serializeAddonRef.current?.serialize({
        scrollback: SESSION_SCROLLBACK_LINES,
        excludeAltBuffer: true,
        excludeModes: true,
      }) ?? "",
    release: async () => {
      const id = ptyIdRef.current;
      const term = xtermRef.current;
      if (!id || !term || releasedRef.current) return null;
      const sentSeq = await detachPty(id);
      releasedRef.current = true;
      // Output sent before the detach may still be in flight on the channel
      // - wait (briefly) until the last of it has landed here.
      const deadline = Date.now() + 500;
      while (lastSeqRef.current < sentSeq && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Then let xterm finish parsing everything written so far.
      await new Promise<void>((resolve) => term.write("", resolve));
      const snapshot =
        serializeAddonRef.current?.serialize({ scrollback: SESSION_SCROLLBACK_LINES }) ?? "";
      return { ptyId: id, snapshot };
    },
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
      // Most CLIs tune their colors for a black background, so some come
      // out washed out or invisible on the light theme (and a few too dark
      // on the dark one). xterm nudges any foreground below this contrast
      // against its background until it's readable - same default as VS
      // Code's terminal.
      minimumContrastRatio: 4.5,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    const serializeAddon = new SerializeAddon();
    term.loadAddon(serializeAddon);
    serializeAddonRef.current = serializeAddon;
    // Plain URLs detected in the text, plus OSC 8 hyperlinks (link text that
    // isn't the URL itself - Claude Code and others emit these); both go
    // through the same confirm menu.
    term.loadAddon(new WebLinksAddon((event, uri) => linkClickRef.current(event, uri)));
    term.options.linkHandler = { activate: (event, uri) => linkClickRef.current(event, uri) };
    term.open(hostRef.current!);
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

    // xterm sends a plain `\r` for Shift+Enter, indistinguishable from Enter,
    // so multi-line prompts in CLIs like Claude Code were impossible. Send
    // ESC+CR (Alt+Enter) instead - the sequence those CLIs read as "insert a
    // newline", and what VS Code's terminal setup maps Shift+Enter to.
    term.attachCustomKeyEventHandler((e) => {
      const key = e.key.toLowerCase();
      const ctrlOnly = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
      // Ctrl+V / Shift+Insert: xterm would turn these into ^V / an escape
      // sequence for the shell. Returning false *without* preventDefault lets
      // the browser run its native paste into xterm's textarea, which xterm
      // then handles (bracketed-paste aware) - the path dictation tools like
      // Wispr Flow rely on, since they paste by synthesizing Ctrl+V.
      if ((ctrlOnly && key === "v") || (e.key === "Insert" && e.shiftKey && !e.ctrlKey)) return false;
      // Ctrl+C copies when there's a selection (and clears it, so the next
      // Ctrl+C interrupts as usual); without one it stays ^C.
      if (ctrlOnly && key === "c" && term.hasSelection()) {
        if (e.type === "keydown") {
          e.preventDefault();
          navigator.clipboard.writeText(term.getSelection()).catch(() => {});
          term.clearSelection();
        }
        return false;
      }
      if (e.key !== "Enter" || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return true;
      if (e.type === "keydown") {
        e.preventDefault();
        const id = ptyIdRef.current;
        usedRef.current = true;
        if (id) writePty(id, "\x1b\r");
      }
      return false;
    });

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
      if (!TERMINAL_REPORT.test(data)) usedRef.current = true;
      const id = ptyIdRef.current;
      if (!id) {
        pendingInput.push(data);
        return;
      }
      writePty(id, data);

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

    let disposed = false;

    const attached = attachRef.current;
    if (attached) {
      // Moved here from another window: redraw what it was showing, then
      // take over its output - everything it printed during the move comes
      // first. The pty is resized to this terminal's grid by the refit below
      // (`ptySizeRef` starts at 0x0, so it always sends), which also has a
      // full-screen program redraw itself for the new size.
      term.write(attached.snapshot);
      void attachPty(attached.ptyId, {
        onOutput: (data, seq) => {
          lastSeqRef.current = seq;
          if (!disposed) term.write(data);
        },
        onExit: () => {
          if (!disposed) term.write(`\r\n[${t("terminal.exited")}]\r\n`);
        },
      })
        .then(() => {
          if (disposed) return;
          ptyIdRef.current = attached.ptyId;
          term.write("", () => {
            if (disposed) return;
            refit();
            for (const data of pendingInput.splice(0)) writePty(attached.ptyId, data);
          });
        })
        .catch((e) => {
          if (!disposed) term.write(`\r\n[${t("terminal.moveFailed", { error: String(e) })}]\r\n`);
        });
    }

    (async () => {
      if (attached) return;
      // A quiet splash above the real prompt, not a competing banner: skips
      // itself on a too-narrow tab (see buildAsciiBanner) rather than wrap
      // and look broken. Awaited before the spawn so it's always the very
      // first thing written to this tab - xterm's write queue is FIFO by call
      // order, so writing it any later could land below the shell's output.
      if (restoredContentRef.current) {
        // Replayed as-is, with no "restored" marker of its own: an untouched
        // restored tab is saved back with this same content (see App.tsx's
        // session snapshot), so a marker would pile up one more line on
        // every restart.
        term.write(`${restoredContentRef.current}\x1b[0m\r\n`);
      } else if (bannerEnabledRef.current) {
        const [sysInfo, appVersion] = await Promise.all([
          invoke<BannerSystemInfo>("system_info").catch(() => undefined),
          getVersion().catch(() => undefined),
        ]);
        if (disposed) return;
        const banner = buildAsciiBanner(term.cols, sysInfo, appVersion);
        if (banner) term.write(banner);
      }

      let id: string;
      try {
        // Output is written as it arrives, even before `pty_spawn` resolves
        // (see spawnPty for why that window matters) - xterm's replies to
        // the shell's startup queries go through `onData`, which queues them
        // in `pendingInput` until the id is known.
        id = await spawnPty({
          cwd: cwdRef.current,
          cols: term.cols,
          rows: term.rows,
          shell: shellIdRef.current,
          onOutput: (data, seq) => {
            lastSeqRef.current = seq;
            if (!disposed) term.write(data);
          },
          onExit: () => {
            if (!disposed) term.write(`\r\n[${t("terminal.exited")}]\r\n`);
          },
        });
      } catch (e) {
        if (!disposed) term.write(`\r\n[${t("terminal.spawnFailed", { error: String(e) })}]\r\n`);
        return;
      }
      if (disposed) {
        killPty(id);
        return;
      }
      ptyIdRef.current = id;
      ptySizeRef.current = { cols: term.cols, rows: term.rows };

      // An empty write's callback runs once everything queued before it has
      // been parsed - so the cursor position `writeSilently` reads afterwards
      // reflects the banner and any early shell output, not a stale row.
      term.write("", () => {
        if (disposed) return;
        // The pty was sized from whatever xterm measured at mount; if the
        // container hadn't been laid out yet that was a placeholder.
        refit();
        for (const data of pendingInput.splice(0)) writePty(id, data);
        // Windows retitling (cmd.exe/PowerShell never do it on their own)
        // is set up at spawn time - see pty.rs's pty_spawn.
        if (runOnStartRef.current) writePty(id, `${runOnStartRef.current}\r`);
      });
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
      if (ptyIdRef.current && !releasedRef.current) killPty(ptyIdRef.current);
      term.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{ display: hidden ? "none" : "flex" }}
    >
      <div ref={hostRef} className="terminal-host" />
    </div>
  );
});

TerminalView.displayName = "TerminalView";
