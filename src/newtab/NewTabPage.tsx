import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from "react";
import { listShellOptions, shellOptionLabel, type ShellOption } from "../terminal/shellOptions";
import { shellOptionIcon } from "../terminal/TabStrip";
import type { PromptAnchor } from "../terminal/Terminal";
import { sameShell, wslDistroOfShell } from "../terminal/wslPath";
import { listFavorites, subscribeFavorites, type FavoriteFolder } from "../favorites/favoritesStore";
import { listRecentTerminals, subscribeRecentTerminals, type RecentTerminal } from "./recentTerminals";
import { flushSync } from "react-dom";
import { useProfiles } from "../profiles/profiles";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import {
  FROG_BOX,
  FROG_HEIGHT,
  FROG_WIDTH,
  buildAsciiBanner,
  FROG_PIXELS,
  drawFrog,
  frogPlacement,
  REST_POSE,
  rememberBannerInfo,
  type BannerSystemInfo,
} from "../terminal/asciiBanner";
import { FrogCatch } from "./FrogCatch";
import { useFrogPose } from "./useFrogPose";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { historyFor } from "./commandHistory";
import { useI18n } from "../i18n";
import { useTheme } from "../themes/ThemeContext";
import { findPalette, resolveTerminalPagePalette } from "../themes/palettes";
import { FLY_WORDS, FLY_WORD_IDLE_MS, UNIT_X, UNIT_Y, bannerLines, drawRealCatch, flyArea, flyWordIn, useTermGrid, type CatchGrid } from "./catchGrid";
import { isPowerShell, promptFor, shownPath } from "./promptText";
import { shellChips } from "./shellChips";
import { useRelativeTime } from "./useRelativeTime";
import { useNewTabSettings } from "./newTabSettings";
import type { NewTabLaunch, NewTabLayoutProps } from "./types";
import "./newtab.css";

/** The page draws the terminal's banner and prompt on the cells the terminal
 * will, so on launch the prompt barely moves: it settles onto the real row
 * (a few px at most, or more when the shell prints a greeting first). */
const FLIGHT_MS = 240;
const HAND_OFF_EASING = "cubic-bezier(.16,1,.3,1)";
/** Settle on the page's own row if the terminal hasn't reported where its
 * prompt will be by now. */
const ANCHOR_WAIT_MS = 80;
/** The prompt slides to the real one when the shell printed lines of its own
 * first (a profile's greeting). */
const NUDGE_MS = 120;
/** Fade anyway if the terminal never reports in. */
const READY_TIMEOUT_MS = 1800;
const OVERLAY_FADE_MS = 90;

const RECENTS_SHOWN = 6;

/** How long the frog stays awake once the pointer has left it. */
const FROG_AWAKE_MS = 3000;

/** `.terminal-container`'s top and left padding, where its first cell is. */
const TERM_PADDING_TOP = 14;
const TERM_PADDING_LEFT = 14;

/** The "terminal" layout: the page looks like the terminal it turns into. */
export function NewTabPage({ hidden, defaultShell, startDir, termFontSize, onLaunch, anchor, promptShown, onShellChange, profileId, onProfileChange, onDone }: NewTabLayoutProps) {
  const { t } = useI18n();
  const { profiles } = useProfiles();
  const { bannerEnabled } = useTerminalSettings();
  const { theme, paletteId, terminalPaletteId, contrast } = useTheme();
  // The page is the terminal's first screen: in the terminal's own palette,
  // when it has one.
  const terminalPalette = terminalPaletteId ? findPalette(terminalPaletteId) : undefined;
  const paletteVars = terminalPalette ? resolveTerminalPagePalette(terminalPalette, theme, contrast) : null;
  const relativeTime = useRelativeTime();
  const [options, setOptions] = useState<ShellOption[]>([]);
  const [shell, setShell] = useState(defaultShell || "system");
  const [command, setCommand] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [flyPrompt, setFlyPrompt] = useState<string | null>(null);
  const [phase, setPhase] = useState<"page" | "overlay" | "fading">("page");
  /** The list row picked with the arrow keys (-1: the prompt itself). */
  const [selected, setSelected] = useState(-1);
  /** The chosen shell's command history, oldest first, and how far back
   * the up arrow has gone into it (-1: not at all - the line is the user's
   * own draft, kept in `draftRef` while walking). */
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const draftRef = useRef("");
  const [width, setWidth] = useState(0);
  const [{ sections }] = useNewTabSettings();
  const allFavorites = useSyncExternalStore(subscribeFavorites, listFavorites, listFavorites);
  const allRecents = useSyncExternalStore(subscribeRecentTerminals, listRecentTerminals, listRecentTerminals);
  // A section the user hid is no list at all: its rows aren't numbered or walked either.
  const favorites = sections.favorites ? allFavorites : [];
  const recents = sections.recents ? allRecents.slice(0, RECENTS_SHOWN) : [];
  const rootRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLLabelElement>(null);
  const psRef = useRef<HTMLSpanElement>(null);
  /** The measurements the hand-off needs, taken when it was launched - the
   * prompt only moves once the terminal says where its own is. */
  const flightRef = useRef<{ text: DOMRect; started: boolean; landedTop: number } | null>(null);
  const finishingRef = useRef(false);
  const timersRef = useRef<number[]>([]);
  const [version, setVersion] = useState("");
  const [system, setSystem] = useState<BannerSystemInfo | null>(null);
  const [flightDone, setFlightDone] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  /** The frog sits still in the banner, like the one the terminal prints,
   * until the pointer comes over it: then it comes alive for a while. */
  const [awake, setAwake] = useState(false);
  const sleepTimerRef = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const grid = useTermGrid(termFontSize, width);

  useEffect(() => {
    let cancelled = false;
    void listShellOptions().then((opts) => {
      if (cancelled) return;
      setOptions(opts);
      const match = opts.find((o) => sameShell(o.id, defaultShell));
      if (match) setShell(match.id);
    });
    return () => {
      cancelled = true;
    };
  }, [defaultShell]);

  useEffect(() => {
    void getVersion()
      .then((v) => {
        setVersion(v);
        rememberBannerInfo({ version: v });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    void invoke<BannerSystemInfo>("system_info")
      .then((info) => {
        rememberBannerInfo({ info });
        if (!cancelled) setSystem(info);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => timersRef.current.forEach(window.clearTimeout), []);
  useEffect(() => () => window.clearTimeout(sleepTimerRef.current), []);

  const wakeFrog = () => {
    window.clearTimeout(sleepTimerRef.current);
    setAwake(true);
  };
  const letFrogSleep = () => {
    window.clearTimeout(sleepTimerRef.current);
    sleepTimerRef.current = window.setTimeout(() => setAwake(false), FROG_AWAKE_MS);
  };

  useEffect(() => {
    if (!hidden) inputRef.current?.focus({ preventScroll: true });
  }, [hidden]);

  useEffect(() => {
    if (selected >= 0) document.getElementById(`newtab-row-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => setWidth(root.getBoundingClientRect().width));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const { chips, chipShell, defaultLabel } = shellChips(options, defaultShell);
  const labelOf = (id: string | undefined) => {
    const opt = options.find((o) => sameShell(o.id, id ?? defaultShell));
    // "Predefinita (PowerShell)" is just PowerShell to the reader: name the shell.
    if (opt?.id === "system" && opt.label) return opt.label;
    return opt ? shellOptionLabel(opt) : (id ?? "");
  };

  // The up arrow walks the history of the shell the prompt belongs to.
  const powershell = isPowerShell(shell, defaultLabel);
  useEffect(() => {
    let cancelled = false;
    setHistoryIndex(-1);
    void historyFor(shell, powershell).then((list) => {
      if (!cancelled) setHistory(list);
    });
    return () => {
      cancelled = true;
    };
  }, [shell, powershell]);

  /** Puts a history entry (or the draft) on the line, caret at its end. */
  function showLine(text: string, index: number) {
    setHistoryIndex(index);
    setCommand(text);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(text.length, text.length));
  }

  // The same banner a fresh terminal writes (none when it's turned off or
  // the tab is too narrow for it), so the prompt below it sits on the row
  // the shell will print its own on. Its frog's cells are blank: the frog is
  // drawn over them, here as in the terminal.
  const banner =
    bannerEnabled && grid
      ? buildAsciiBanner(grid.cols, system ?? undefined, version || undefined, paletteVars?.["--accent"])
      : null;
  const lines = banner ? bannerLines(banner) : [];
  const frogAt = grid && lines.length > 0 ? frogPlacement(grid.cols) : null;
  /** The page's cell grid as it stands, for the catch. */
  const catchGrid = (): CatchGrid | null => {
    const root = rootRef.current;
    if (!root || !grid || !frogAt) return null;
    const r = root.getBoundingClientRect();
    return {
      originX: r.left + TERM_PADDING_LEFT,
      originY: r.top + TERM_PADDING_TOP - root.scrollTop,
      cellWidth: grid.cellWidth,
      cellHeight: grid.cellHeight,
      cols: grid.cols,
      rows: Math.max(1, Math.floor((root.clientHeight - 2 * TERM_PADDING_TOP) / grid.cellHeight)),
      frogAt,
    };
  };
  // The frog is pixel art on the banner's frog cells, finer than the
  // terminal's: still, like the terminal's, until the pointer wakes it, and
  // easing in and out of life. Its catches run either way.
  const { pose, catching, huntWord } = useFrogPose({
    active: !hidden && !leaving && !!frogAt,
    awake,
    frogRect: () => {
      const root = rootRef.current;
      if (!root || !grid || !frogAt) return null;
      const r = root.getBoundingClientRect();
      return new DOMRect(
        r.left + TERM_PADDING_LEFT + frogAt.col * grid.cellWidth,
        r.top + TERM_PADDING_TOP - root.scrollTop + frogAt.top * grid.cellHeight,
        FROG_WIDTH * grid.cellWidth,
        FROG_HEIGHT * grid.cellHeight,
      );
    },
    caret: () => {
      const input = inputRef.current;
      if (!input || document.activeElement !== input || !command || !grid) return null;
      const r = input.getBoundingClientRect();
      return { x: r.left + Math.min(r.width, input.value.length * grid.cellWidth), y: r.top + r.height / 2 };
    },
    flyArea: () => {
      const g = catchGrid();
      return g && rootRef.current ? flyArea(g, lines, rootRef.current) : null;
    },
  });
  const catchGridNow = catching ? catchGrid() : null;
  // The frog's canvas goes away during a catch (and with the page hidden),
  // taking the pointer's `pointerleave` with it: send the frog to sleep as if
  // the pointer had left, or it stays awake until hovered and left again.
  const frogShown = !!frogAt && !!grid && !catching && !hidden;
  useEffect(() => {
    if (!frogShown) letFrogSleep();
  }, [frogShown]);
  // The rare real frog is painted on a canvas under the pixel-art catch, which
  // fades out over it - except for the odd frame mid-glitch, which flickers
  // back to the pixel frog (`flicker`, rolled in useFrogPose).
  const realFrame = !!catching?.real && catching.real.amount > 0 && !catching.flicker;
  const realCanvasRef = useRef<HTMLCanvasElement>(null);

  // The page's frog, drawn on its canvas - at rest on the hand-off, the very
  // frog the terminal draws over its banner, so it stays put as the page
  // fades away.
  const frogCanvasRef = useRef<HTMLCanvasElement>(null);
  const frogPose = leaving ? REST_POSE : pose;
  const redrawFrog = () => {
    const canvas = frogCanvasRef.current;
    if (canvas && grid) drawFrog(canvas, frogPose, FROG_WIDTH * grid.cellWidth, FROG_HEIGHT * grid.cellHeight);
  };
  const redrawFrogRef = useRef(redrawFrog);
  redrawFrogRef.current = redrawFrog;
  // Redraws when the pose or grid changes, or when the canvas (re)mounts
  // (`frogAt`, `catching` decide whether it is rendered) - not every render.
  useLayoutEffect(redrawFrog, [frogPose, grid, frogAt, catching === null]);
  // Its colors follow the theme's accent, which the theme sets in a layout
  // effect of its own - after this page's: redraw once it's in.
  useEffect(() => redrawFrogRef.current(), [theme, paletteId, terminalPaletteId, contrast]);
  useLayoutEffect(() => {
    const canvas = realCanvasRef.current;
    if (canvas && realFrame && catching && catchGridNow) drawRealCatch(canvas, catchGridNow, catching);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catching, realFrame, grid, frogAt]);

  // "mosca" or "fly" left on the line: the frog catches it and eats it,
  // taking it off the line.
  useEffect(() => {
    if (leaving || hidden) return;
    const found = flyWordIn(command);
    if (!found) return;
    const timer = window.setTimeout(() => {
      const input = inputRef.current;
      const g = catchGrid();
      if (!input || !g) return;
      // The word's middle on screen: the line is monospace, scrolled by the
      // input when it overflows.
      const r = input.getBoundingClientRect();
      const px = r.left - input.scrollLeft + (found.index + found.word.length / 2) * g.cellWidth;
      const col = Math.floor((px - g.originX) / g.cellWidth);
      const row = Math.floor((r.top + r.height / 2 - g.originY) / g.cellHeight);
      const spot = {
        x: FROG_BOX.x + (col - g.frogAt.col + 0.5) * UNIT_X,
        y: FROG_BOX.y + (2 * (row - g.frogAt.top) + 1) * UNIT_Y,
      };
      huntWord(found.word, spot, () => {
        setCommand((line) => {
          const at = line.slice(found.index, found.index + found.word.length) === found.word ? found.index : line.search(FLY_WORDS);
          if (at < 0) return line;
          // Gone, with the space it leaves behind.
          return (line.slice(0, at) + line.slice(at + found.word.length)).replace(/ {2,}/g, " ").trimStart();
        });
        setHistoryIndex(-1);
      });
    }, FLY_WORD_IDLE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, leaving, hidden]);

  /** Hands the tab over to the terminal: mounts it underneath, keeps the
   * banner and prompt in place over it while everything else clears away,
   * then lets the prompt settle onto the shell's own before fading. */
  function launch(next: NewTabLaunch) {
    if (leaving) return;
    // The prompt the terminal will print: for a recent or favorite that is
    // its own folder and shell, not the ones shown now.
    flushSync(() => {
      setLeaving(true);
      setSelected(-1);
      if (next.cwd !== undefined || next.shell !== undefined) {
        setFlyPrompt(promptFor(next.shell ?? defaultShell, defaultLabel, next.cwd ?? startDir));
      }
    });
    const root = rootRef.current;
    const ps = psRef.current;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!root || !ps || reduceMotion) {
      onLaunch(next);
      onDone();
      return;
    }
    const text = ps.getBoundingClientRect();
    flightRef.current = { text, started: false, landedTop: text.top };
    setPhase("overlay");
    onLaunch(next);
    timersRef.current.push(window.setTimeout(() => setTimedOut(true), READY_TIMEOUT_MS));
    // Where the terminal's prompt lands depends on its banner, which it
    // reports as soon as it is written; staying put is the fallback.
    timersRef.current.push(
      window.setTimeout(() => settle({ left: text.left, top: text.top, cellHeight: text.height }), ANCHOR_WAIT_MS),
    );
  }

  /** Moves the prompt onto the terminal's prompt row - by nothing or a few
   * px when the grids agree. */
  function settle(a: PromptAnchor) {
    const f = flightRef.current;
    const prompt = promptRef.current;
    if (!f || f.started || !prompt) return;
    f.started = true;
    f.landedTop = a.top;
    const dx = a.left - f.text.left;
    const dy = a.top + a.cellHeight / 2 - (f.text.top + f.text.height / 2);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
      setFlightDone(true);
      return;
    }
    const animation = prompt.animate([{ transform: "translate(0, 0)" }, { transform: `translate(${dx}px, ${dy}px)` }], {
      duration: FLIGHT_MS,
      easing: HAND_OFF_EASING,
      fill: "forwards",
    });
    animation.onfinish = () => setFlightDone(true);
  }

  useEffect(() => {
    if (anchor) settle(anchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  // Once the prompt has landed and the shell has drawn its own, fade the
  // page out to reveal it - after sliding onto the real row if the shell
  // printed something of its own first.
  useEffect(() => {
    if (phase !== "overlay" || !flightDone || finishingRef.current) return;
    if (promptShown === undefined && !timedOut) return;
    finishingRef.current = true;
    const finish = () => {
      setPhase("fading");
      timersRef.current.push(window.setTimeout(onDone, OVERLAY_FADE_MS));
    };
    const delta = promptShown && flightRef.current ? promptShown.top - flightRef.current.landedTop : 0;
    const prompt = promptRef.current;
    if (prompt && Math.abs(delta) > 2) {
      const slide = prompt.animate(
        [{ transform: "translateY(0)" }, { transform: `translateY(${delta}px)` }],
        { duration: NUDGE_MS, easing: HAND_OFF_EASING, composite: "add", fill: "forwards" },
      );
      slide.onfinish = finish;
    } else {
      finish();
    }
  }, [phase, flightDone, promptShown, timedOut, onDone]);

  const shellChangedRef = useRef(false);
  useEffect(() => {
    // Nothing to do for the initial default: the tab already starts there.
    if (!shellChangedRef.current) {
      shellChangedRef.current = true;
      return;
    }
    if (!leaving) onShellChange(chosenShell());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell]);

  const chosenShell = () => (sameShell(shell, defaultShell) ? undefined : shell);

  const launchRecent = (r: RecentTerminal) =>
    launch({ shell: r.shell, cwd: r.cwd, command: r.command, typeOnly: true });
  const launchFavorite = (f: FavoriteFolder) => launch({ shell: f.shell, cwd: f.path });
  /** Recents first, then favorites: one list, walked with the arrow keys and
   * numbered in that order. */
  const rowCount = recents.length + favorites.length;
  const launchRow = (index: number) => {
    if (index < recents.length) launchRecent(recents[index]);
    else if (favorites[index - recents.length]) launchFavorite(favorites[index - recents.length]);
  };
  /** The digit that picks row `i` from an empty command line - only the
   * first nine rows have one. */
  const rowKey = (i: number) => (i < 9 ? String(i + 1) : " ");
  const rowId = (i: number) => `newtab-row-${i}`;

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Up and down on the prompt walk the shell's history, like a real
    // prompt; down past the newest entry (the user's own line) walks into
    // the list below instead, and up from its first row comes back.
    if (e.key === "ArrowUp" && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      if (selected >= 0) {
        setSelected((s) => s - 1);
      } else if (historyIndex + 1 < history.length) {
        if (historyIndex < 0) draftRef.current = command;
        showLine(history[history.length - 2 - historyIndex], historyIndex + 1);
      }
      return;
    }
    if (e.key === "ArrowDown" && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      if (historyIndex >= 0) {
        const next = historyIndex - 1;
        showLine(next < 0 ? draftRef.current : history[history.length - 1 - next], next);
      } else if (rowCount > 0) {
        setSelected((s) => Math.min(rowCount - 1, s + 1));
      }
      return;
    }
    if (e.key === "Escape" && selected >= 0) {
      e.preventDefault();
      setSelected(-1);
      return;
    }
    // An empty line plus a digit picks that row, like `[1]` on screen.
    if (!command && !e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      const index = Number(e.key) - 1;
      if (index < rowCount) {
        e.preventDefault();
        launchRow(index);
        return;
      }
    }
    if (e.altKey && /^[1-9]$/.test(e.key)) {
      const opt = chips[Number(e.key) - 1];
      if (opt) {
        e.preventDefault();
        setShell(chipShell(opt));
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (selected >= 0) {
        launchRow(selected);
        return;
      }
      const trimmed = command.trim();
      launch({ shell: chosenShell(), command: trimmed || undefined });
    }
  }

  const row = (i: number, name: string, detail: string, isPath: boolean, shellId: string | undefined, when: string, title: string, onClick: () => void) => (
    <button
      key={rowId(i)}
      id={rowId(i)}
      type="button"
      className={"newtab-row" + (i === selected ? " is-selected" : "")}
      title={title}
      tabIndex={-1}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className="newtab-row-mark" aria-hidden="true">
        {i === selected ? "▸" : ""}
      </span>
      <span className="newtab-row-key">{rowKey(i)}</span>
      <span className="newtab-row-name">{name}</span>
      <span className={"newtab-row-cmd" + (isPath ? " is-path" : "")}>{detail}</span>
      <span className="newtab-row-shell">
        <span className="newtab-shell-icon">{shellOptionIcon(shellId ?? defaultShell)}</span>
        {labelOf(shellId)}
      </span>
      <span className="newtab-row-when">{when}</span>
    </button>
  );

  const style = {
    ...paletteVars,
    "--newtab-cell": grid ? `${grid.cellHeight}px` : `${Math.round(termFontSize * 1.2)}px`,
    fontSize: termFontSize,
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className={
        "newtab" +
        (leaving ? " is-leaving" : "") +
        (phase !== "page" ? " is-overlay" : "") +
        (phase === "fading" ? " is-fading" : "")
      }
      style={style}
      hidden={hidden}
    >
      {realFrame && <canvas ref={realCanvasRef} className="newtab-catch" aria-hidden="true" />}

      {catching && catchGridNow && (
        <FrogCatch
          frame={catching}
          viewBox={{
            x: FROG_BOX.x - catchGridNow.frogAt.col * UNIT_X,
            y: FROG_BOX.y - 2 * catchGridNow.frogAt.top * UNIT_Y,
            width: catchGridNow.cols * UNIT_X,
            height: 2 * catchGridNow.rows * UNIT_Y,
          }}
          pixels={{
            width: (catchGridNow.cols * FROG_PIXELS.width) / FROG_WIDTH,
            height: (catchGridNow.rows * FROG_PIXELS.height) / FROG_HEIGHT,
          }}
          unitsPerCell={{ x: UNIT_X, y: 2 * UNIT_Y }}
          frogOpacity={realFrame ? 1 - catching.real!.amount : 1}
          style={{ width: catchGridNow.cols * catchGridNow.cellWidth, height: catchGridNow.rows * catchGridNow.cellHeight }}
        />
      )}

      {lines.length > 0 && (
        <div className="newtab-banner" aria-hidden="true">
          {lines.map((segments, i) => (
            <div key={i} className="newtab-line">
              {segments.map((s, j) => (
                <span key={j} style={s.style}>
                  {s.text}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      {frogAt && grid && !catching && (
        <canvas
          ref={frogCanvasRef}
          className="newtab-frog"
          aria-hidden="true"
          onPointerEnter={wakeFrog}
          onPointerLeave={letFrogSleep}
          style={{
            left: TERM_PADDING_LEFT + frogAt.col * grid.cellWidth,
            top: TERM_PADDING_TOP + frogAt.top * grid.cellHeight,
            width: FROG_WIDTH * grid.cellWidth,
            height: FROG_HEIGHT * grid.cellHeight,
          }}
        />
      )}

      {/* A click on the prompt leaves the list for the command line. */}
      <label ref={promptRef} className="newtab-prompt" onPointerDown={() => setSelected(-1)}>
        <span ref={psRef} className="newtab-ps">
          {flyPrompt ?? promptFor(shell, defaultLabel, startDir)}
        </span>
        <input
          ref={inputRef}
          id="newtab-command"
          className={"newtab-input" + (selected >= 0 ? " is-away" : "")}
          value={command}
          onChange={(e) => {
            setCommand(e.target.value);
            setSelected(-1);
            setHistoryIndex(-1);
          }}
          onKeyDown={onKeyDown}
          placeholder={t("newTab.placeholder")}
          autoComplete="off"
          spellCheck={false}
          aria-label={t("newTab.commandLabel")}
          aria-controls="newtab-list"
          aria-activedescendant={selected >= 0 ? rowId(selected) : undefined}
        />
      </label>

      <div className="newtab-below">

        <div id="newtab-list" className="newtab-list">
          {sections.recents && (
            <section className="newtab-section">
              <h2 className="newtab-heading">
                <span>#</span> {t("newTab.recents")}
              </h2>
              {recents.length === 0 ? (
                <p className="newtab-empty">{t("newTab.recentsEmpty")}</p>
              ) : (
                recents.map((r, i) =>
                  row(i, r.name, r.command, false, r.shell, relativeTime(r.at), r.cwd, () => launchRecent(r)),
                )
              )}
            </section>
          )}
          {sections.favorites && (
            <section className="newtab-section">
              <h2 className="newtab-heading">
                <span>#</span> {t("favorites.title")}
              </h2>
              {favorites.length === 0 ? (
                <p className="newtab-empty">{t("newTab.favoritesEmpty")}</p>
              ) : (
                favorites.map((f, i) =>
                  row(recents.length + i, f.name, shownPath(f.path), true, f.shell, "", f.path, () => launchFavorite(f)),
                )
              )}
            </section>
          )}
        </div>

        <div className="newtab-foot">
          <div className="newtab-chip-groups">
            <div className="newtab-chips" role="group" aria-label={t("newTab.shellLabel")}>
              {chips.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className="newtab-chip"
                  aria-pressed={chipShell(opt) === shell}
                  onClick={() => {
                    setShell(chipShell(opt));
                    inputRef.current?.focus();
                  }}
                >
                  <span className="newtab-shell-icon">{shellOptionIcon(opt.id)}</span>
                  {shellOptionLabel(opt)}
                </button>
              ))}
            </div>
            {/* Env vars don't reach a WSL distro: no profile there. */}
            {profiles.length > 0 && wslDistroOfShell(shell) === undefined && (
              <div className="newtab-chips" role="group" aria-label={t("agents.profile.label")}>
                <button
                  type="button"
                  className="newtab-chip"
                  aria-pressed={!profileId}
                  onClick={() => {
                    onProfileChange(null);
                    inputRef.current?.focus();
                  }}
                >
                  <span className="newtab-profile-dot is-default" />
                  {t("agents.profile.default")}
                </button>
                {profiles.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="newtab-chip"
                    aria-pressed={profileId === p.id}
                    onClick={() => {
                      onProfileChange(p.id);
                      inputRef.current?.focus();
                    }}
                  >
                    <span className="newtab-profile-dot" style={{ background: p.color }} />
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="newtab-keys">
            {selected >= 0 ? t("newTab.keysList") : t("newTab.keys", { count: Math.min(chips.length, 9) })}
          </span>
        </div>
      </div>
    </div>
  );
}
