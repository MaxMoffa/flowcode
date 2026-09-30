import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { listShellOptions, shellOptionLabel, type ShellOption } from "../terminal/shellOptions";
import { shellOptionIcon } from "../terminal/TabStrip";
import type { PromptAnchor } from "../terminal/Terminal";
import { sameShell, toWslPath, wslDistroOfPath, wslDistroOfShell } from "../terminal/wslPath";
import { listFavorites, subscribeFavorites, type FavoriteFolder } from "../favorites/favoritesStore";
import { listRecentTerminals, subscribeRecentTerminals, type RecentTerminal } from "./recentTerminals";
import { isWindowsPlatform } from "../lib/path";
import { flushSync } from "react-dom";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { gib, rememberBannerInfo, type BannerSystemInfo } from "../terminal/asciiBanner";
import { useI18n } from "../i18n";
import { FrogLogo } from "./FrogLogo";
import "./newtab.css";

/** What the page hands back once the user picks something: the shell to
 * start (`undefined` = the configured default), where (`undefined` = that
 * shell's start folder), and a command to run - or, with `typeOnly`, to
 * leave typed on the prompt. */
export interface NewTabLaunch {
  shell?: string;
  cwd?: string;
  command?: string;
  typeOnly?: boolean;
}

interface NewTabPageProps {
  hidden: boolean;
  /** The configured default shell id (Impostazioni > Shell predefinita). */
  defaultShell: string;
  /** The folder a default-shell terminal would start in - shown on the
   * prompt; empty while it's still being looked up. */
  startDir: string;
  /** Font size of the terminal this page turns into, so the first line
   * lands at the size the shell will print it. */
  termFontSize: number;
  /** Fired as the flight starts: mount the terminal now, so its shell spins
   * up underneath while the prompt is still in the air. The page stays on
   * top (see `is-overlay`) until it has faded out and calls `onDone`. */
  onLaunch: (launch: NewTabLaunch) => void;
  /** Where the terminal underneath will draw its first prompt, once its
   * banner (if any) is on screen - the flight's destination. */
  anchor?: PromptAnchor;
  /** The terminal's shell has drawn its first prompt (`null`: it never
   * will - the shell failed to start). */
  promptShown?: PromptAnchor | null;
  /** The chosen shell changed (`undefined` = the configured default) - the
   * tab's folder follows to that shell's start folder. */
  onShellChange: (shell: string | undefined) => void;
  onDone: () => void;
}

/** The prompt flight and the command box growing into the terminal run
 * together, and start as soon as the user hits Enter. */
const FLIGHT_MS = 340;
const HAND_OFF_EASING = "cubic-bezier(.16,1,.3,1)";
/** Fly to the first row if the terminal hasn't reported where its prompt
 * will be by now. */
const ANCHOR_WAIT_MS = 80;
/** The flown prompt slides to the real one when the shell printed lines of
 * its own first (a profile's greeting). */
const NUDGE_MS = 120;
/** Fade anyway if the terminal never reports in. */
const READY_TIMEOUT_MS = 1800;
const OVERLAY_FADE_MS = 90;

const RECENTS_SHOWN = 6;

/** The prompt the chosen shell would print - only its shape (PowerShell's
 * `PS C:\...>`, cmd's `C:\...>`, a POSIX `$`), so the page's first line
 * reads as that shell's first line. */
function promptFor(shell: string, defaultLabel: string, dir: string): string {
  if (wslDistroOfShell(shell) !== undefined) {
    const posix = dir ? toWslPath(wslDistroOfPath(dir) ?? "", dir) : null;
    return `${posix ?? "~"} $ `;
  }
  const where = dir || "~";
  if (shell === "cmd") return `${where}>`;
  const powershell =
    shell === "powershell" || shell === "pwsh" || (shell === "system" && /powershell/i.test(defaultLabel));
  if (powershell || (shell === "system" && isWindowsPlatform())) return `PS ${where}> `;
  return `${where} $ `;
}

function useRelativeTime() {
  const { language } = useI18n();
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  return (at: number) => {
    const minutes = Math.round((at - Date.now()) / 60000);
    if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return format.format(hours, "hour");
    return format.format(Math.round(hours / 24), "day");
  };
}

export function NewTabPage({ hidden, defaultShell, startDir, termFontSize, onLaunch, anchor, promptShown, onShellChange, onDone }: NewTabPageProps) {
  const { t } = useI18n();
  const relativeTime = useRelativeTime();
  const [options, setOptions] = useState<ShellOption[]>([]);
  const [shell, setShell] = useState(defaultShell || "system");
  const [command, setCommand] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [flyPrompt, setFlyPrompt] = useState<string | null>(null);
  const [phase, setPhase] = useState<"page" | "overlay" | "fading">("page");
  const favorites = useSyncExternalStore(subscribeFavorites, listFavorites, listFavorites);
  const recents = useSyncExternalStore(subscribeRecentTerminals, listRecentTerminals, listRecentTerminals).slice(
    0,
    RECENTS_SHOWN,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLLabelElement>(null);
  const psRef = useRef<HTMLSpanElement>(null);
  const boxBgRef = useRef<HTMLDivElement>(null);
  /** Uncovers the terminal's content from the top (see startFlight). */
  const uncoverRef = useRef<Animation | null>(null);
  /** The measurements the flight needs, taken when it was launched - it
   * only starts once the terminal says where to land. */
  const flightRef = useRef<{
    box: DOMRect;
    text: DOMRect;
    to: DOMRect;
    dx: number;
    dy: number;
    scale: number;
    started: boolean;
    landedTop: number;
  } | null>(null);
  const finishingRef = useRef(false);
  const timersRef = useRef<number[]>([]);
  const [version, setVersion] = useState("");
  const [system, setSystem] = useState<BannerSystemInfo | null>(null);
  const [flightDone, setFlightDone] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (!hidden) inputRef.current?.focus({ preventScroll: true });
  }, [hidden]);

  // "Default (X)" is just X: drop it when a chip for X exists and let that
  // chip stand for the default instead of listing the shell twice.
  const systemLabel = options.find((o) => o.id === "system")?.label;
  const twin = systemLabel ? options.find((o) => o.id !== "system" && o.label === systemLabel) : undefined;
  const chipShell = (opt: ShellOption) => (opt === twin && sameShell(defaultShell, "system") ? "system" : opt.id);
  // The configured default always comes first.
  const shown = twin ? options.filter((o) => o.id !== "system") : options;
  const isDefaultChip = (opt: ShellOption) => sameShell(chipShell(opt), defaultShell);
  const chips = [...shown.filter(isDefaultChip), ...shown.filter((o) => !isDefaultChip(o))];
  const defaultLabel = options.find((o) => o.id === "system")?.label ?? "";
  const labelOf = (id: string | undefined) => {
    const opt = options.find((o) => sameShell(o.id, id ?? defaultShell));
    // "Predefinita (PowerShell)" is just PowerShell to the reader: name the shell.
    if (opt?.id === "system" && opt.label) return opt.label;
    return opt ? shellOptionLabel(opt) : (id ?? "");
  };

  /** Plays the hand-off - the command box grows to fill the page while the
   * first line flies to where the terminal's own first line will be and
   * everything else clears away - then launches. */
  function launch(next: NewTabLaunch) {
    if (leaving) return;
    // The prompt that flies is the one the terminal will print: for a recent
    // or favorite that is its own folder and shell, not the ones shown now.
    // Rendered before measuring, since it changes the prompt's width.
    flushSync(() => {
      setLeaving(true);
      if (next.cwd !== undefined || next.shell !== undefined) {
        setFlyPrompt(promptFor(next.shell ?? defaultShell, defaultLabel, next.cwd ?? startDir));
      }
    });
    const root = rootRef.current;
    const prompt = promptRef.current;
    const ps = psRef.current;
    const boxBg = boxBgRef.current;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!root || !prompt || !ps || !boxBg || reduceMotion) {
      onLaunch(next);
      onDone();
      return;
    }
    const box = prompt.getBoundingClientRect();
    const text = ps.getBoundingClientRect();
    const to = root.getBoundingClientRect();
    const scale = termFontSize / parseFloat(getComputedStyle(prompt).fontSize);
    // The prompt scales around its own corner, so the text - not the padded
    // label - is what gets aimed at the terminal's prompt row.
    flightRef.current = { box, text, to, dx: text.left - box.left, dy: text.top - box.top, scale, started: false, landedTop: 0 };
    const bg = boxBg.getBoundingClientRect();
    setPhase("overlay");
    onLaunch(next);
    timersRef.current.push(window.setTimeout(() => setTimedOut(true), READY_TIMEOUT_MS));
    // Where the terminal's prompt lands depends on its banner, which it
    // reports as soon as it is written; the first row is the fallback.
    timersRef.current.push(
      window.setTimeout(
        () =>
          startFlight({
            left: to.left + 14,
            top: to.top + 14,
            cellHeight: termFontSize * 1.2,
          }),
        ANCHOR_WAIT_MS,
      ),
    );
    // The box's surface grows from its own corner to the page's, dissolving
    // into the terminal's background as it goes.
    boxBg.animate(
      [
        { transform: "none" },
        {
          transform: `translate(${to.left - bg.left}px, ${to.top - bg.top}px) scale(${to.width / bg.width}, ${to.height / bg.height})`,
          backgroundColor: "transparent",
          borderColor: "transparent",
        },
      ],
      { duration: FLIGHT_MS, easing: HAND_OFF_EASING, fill: "forwards" },
    );
  }

  /** Flies the first line to the terminal's prompt row while the terminal's
   * content, hidden until now (see terminal.css), is uncovered from the top
   * down to that row - so the banner above it appears as the prompt passes,
   * not all at once at the end. Only the content is clipped, never the
   * terminal's own surface, so nothing changes shade underneath. */
  function startFlight(a: PromptAnchor) {
    const f = flightRef.current;
    const prompt = promptRef.current;
    if (!f || f.started || !prompt) return;
    f.started = true;
    f.landedTop = a.top;
    const targetY = a.top + a.cellHeight / 2 - (f.text.height * f.scale) / 2;
    // A longer way takes a little longer, so it doesn't read as rushed.
    const duration = FLIGHT_MS + Math.min(60, Math.abs(targetY - f.box.top) / 10);
    const options = { duration, easing: HAND_OFF_EASING, fill: "forwards" as const };
    const animation = prompt.animate(
      [
        { transform: "translate(0, 0) scale(1)" },
        {
          transform: `translate(${a.left - f.box.left - f.dx * f.scale}px, ${targetY - f.box.top - f.dy * f.scale}px) scale(${f.scale})`,
        },
      ],
      options,
    );
    const terminal = rootRef.current?.previousElementSibling;
    const content = terminal?.matches(".terminal-container") ? terminal.querySelector<HTMLElement>(".xterm") : null;
    if (content) {
      const { height, bottom } = content.getBoundingClientRect();
      uncoverRef.current = content.animate(
        [{ clipPath: `inset(0px 0 ${height}px 0)` }, { clipPath: `inset(0px 0 ${Math.max(0, bottom - a.top)}px 0)` }],
        options,
      );
    }
    animation.onfinish = () => setFlightDone(true);
  }

  useEffect(() => {
    if (anchor) startFlight(anchor);
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
      uncoverRef.current?.cancel();
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

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
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
      const trimmed = command.trim();
      launch({ shell: chosenShell(), command: trimmed || undefined });
    }
  }

  const shellTag = (id: string | undefined) => (
    <span className="newtab-shell-tag">
      <span className="newtab-shell-icon">{shellOptionIcon(id ?? defaultShell)}</span>
      {labelOf(id)}
    </span>
  );

  return (
    <div ref={rootRef} className={
        "newtab" +
        (leaving ? " is-leaving" : "") +
        (phase !== "page" ? " is-overlay" : "") +
        (phase === "fading" ? " is-fading" : "")
      } hidden={hidden}>
      <div className="newtab-inner">
        <div className="newtab-brand">
          <FrogLogo className="newtab-frog" />
          <span className="newtab-brand-text">
            flowcode
            {version && <small className="newtab-version">v{version}</small>}
          </span>
        </div>

        <div className="newtab-box">
          <div ref={boxBgRef} className="newtab-box-bg" aria-hidden="true" />
          <label ref={promptRef} className="newtab-prompt">
            <span ref={psRef} className="newtab-ps">{flyPrompt ?? promptFor(shell, defaultLabel, startDir)}</span>
            <input
              ref={inputRef}
              id="newtab-command"
              className="newtab-input"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t("newTab.placeholder")}
              autoComplete="off"
              spellCheck={false}
              aria-label={t("newTab.commandLabel")}
            />
          </label>
          <div className="newtab-box-foot">
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
            <span className="newtab-keys">{t("newTab.keys", { count: Math.min(chips.length, 9) })}</span>
          </div>
        </div>

        <div className="newtab-cols">
          <section>
            <h2 className="newtab-heading">{t("newTab.recents")}</h2>
            {recents.length === 0 ? (
              <div className="newtab-empty">
                <svg className="newtab-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="8.5" />
                  <path d="M12 7.5V12l3 2" />
                </svg>
                <p>{t("newTab.recentsEmpty")}</p>
              </div>
            ) : (
              <div className="newtab-recents">
                {recents.map((r: RecentTerminal) => (
                  <button
                    key={`${r.cwd}|${r.shell ?? ""}`}
                    type="button"
                    className="newtab-recent"
                    title={r.cwd}
                    onClick={() => launch({ shell: r.shell, cwd: r.cwd, command: r.command, typeOnly: true })}
                  >
                    <span className="newtab-recent-top">
                      <span className="newtab-recent-name">{r.name}</span>
                      <span className="newtab-recent-when">{relativeTime(r.at)}</span>
                    </span>
                    <span className="newtab-recent-cmd">{r.command}</span>
                    <span className="newtab-recent-bottom">
                      {shellTag(r.shell)}
                      <span className="newtab-recent-resume">{t("newTab.resume")}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
          <section>
            <h2 className="newtab-heading">{t("favorites.title")}</h2>
            {favorites.length === 0 ? (
              <div className="newtab-empty">
                <svg className="newtab-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m12 3.5 2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.65l5.9-.85z" />
                </svg>
                <p>{t("newTab.favoritesEmpty")}</p>
              </div>
            ) : (
              <div className="newtab-favorites">
                {favorites.map((f: FavoriteFolder) => (
                  <button
                    key={f.path}
                    type="button"
                    className="newtab-favorite"
                    title={f.path}
                    onClick={() => launch({ shell: f.shell, cwd: f.path })}
                  >
                    <span className="newtab-favorite-star">★</span>
                    <span className="newtab-favorite-text">
                      <span className="newtab-favorite-name">{f.name}</span>
                      <span className="newtab-favorite-path">{f.path}</span>
                    </span>
                    {shellTag(f.shell)}
                  </button>
                ))}
              </div>
            )}
          </section>
          {system && (
            <section className="newtab-system">
              <h2 className="newtab-heading">{t("newTab.system")}</h2>
              <div className="newtab-sys-card">
                {system.os_name && (
                  <div className="newtab-sys-tile">
                    <span className="newtab-sys-label">{t("banner.system")}</span>
                    <span className="newtab-sys-value">{system.os_name}</span>
                    <span className="newtab-sys-sub">{system.arch}</span>
                  </div>
                )}
                {meterTile(t("newTab.memory"), system.memory_available, system.memory_total)}
                {system.disk && meterTile(t("newTab.disk"), system.disk.available, system.disk.total)}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );

  /** A "free of total" tile with a bar showing how much is in use. */
  function meterTile(label: string, free: number, total: number) {
    const used = total > 0 ? Math.min(1, Math.max(0, (total - free) / total)) : 0;
    return (
      <div className="newtab-sys-tile">
        <span className="newtab-sys-label">{label}</span>
        <span className="newtab-sys-value">
          {t("newTab.freeOf", { free: gib(free), total: gib(total) })}
        </span>
        <span
          className={"newtab-sys-meter" + (used > 0.9 ? " is-high" : "")}
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(used * 100)}
        >
          <span style={{ width: `${used * 100}%` }} />
        </span>
      </div>
    );
  }
}
