import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { listShellOptions, shellOptionLabel, type ShellOption } from "../terminal/shellOptions";
import { shellOptionIcon } from "../terminal/TabStrip";
import { sameShell, wslDistroOfShell } from "../terminal/wslPath";
import { listFavorites, subscribeFavorites, type FavoriteFolder } from "../favorites/favoritesStore";
import { listRecentTerminals, subscribeRecentTerminals, type RecentTerminal } from "./recentTerminals";
import { CLI_INFO, type AgentCli } from "../agents/cliInfo";
import { useAvailableClis } from "../agents/useAvailableClis";
import { agentCliIcon } from "../plugins/icons";
import { useProfiles } from "../profiles/profiles";
import { ProfileSelect } from "../profiles/ProfileSelect";
import { useI18n } from "../i18n";
import { FolderIcon, HistoryIcon, PencilIcon, SearchIcon } from "./icons";
import { fuzzyFilter } from "./fuzzy";
import { useNewTabSettings } from "./newTabSettings";
import { useNewTabBackgroundImage } from "./newTabBackground";
import { shownPath } from "./promptText";
import { shellChips } from "./shellChips";
import type { NewTabLaunch, NewTabLayoutProps } from "./types";
import { useRelativeTime } from "./useRelativeTime";
import "./glass-newtab.css";

const RECENTS_SHOWN = 6;
const RESULTS_SHOWN = 12;

type EntryKind = "favorite" | "recent" | "agent" | "shell";

/** One thing the page can start - a tile, a row, a chip or a search result. */
interface Entry {
  id: string;
  kind: EntryKind;
  label: string;
  /** The folder, command or shell behind it. */
  detail: string;
  /** What the fuzzy search looks at. */
  texts: string[];
  icon: ReactNode;
  run: () => void;
}

/** The "Vetro" layout: one frosted-glass panel - a search field, the agents,
 * recents and favorites, the shell chips. Opened from "+" it is a dialog over
 * the current view (`dialog`); in a tab (the layout picked on an open page) it
 * sits on the theme's backdrop (or the user's picture). It starts things the
 * way the terminal layout does - through `onLaunch` - and, having no prompt to
 * hand over, lets the tab turn into the terminal right away. */
export function GlassNewTab({ hidden, defaultShell, startDir, onLaunch, onLaunchAgent, onShellChange, profileId, onProfileChange, onDone, dialog, onDismiss, onCustomize, customizing }: NewTabLayoutProps) {
  const { t } = useI18n();
  const { profiles } = useProfiles();
  const [{ sections, background, grain, blur }] = useNewTabSettings();
  const image = useNewTabBackgroundImage();
  const relativeTime = useRelativeTime();
  const [options, setOptions] = useState<ShellOption[]>([]);
  const [shell, setShell] = useState(defaultShell || "system");
  const [query, setQuery] = useState("");
  /** The entry picked with the arrow keys (-1: the search field itself). */
  const [selected, setSelected] = useState(-1);
  const [leaving, setLeaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const favorites = useSyncExternalStore(subscribeFavorites, listFavorites, listFavorites);
  const recents = useSyncExternalStore(subscribeRecentTerminals, listRecentTerminals, listRecentTerminals).slice(0, RECENTS_SHOWN);
  // The agents this tab's account is signed in to - as the Agents panel's "+" menu offers them.
  const clis = useAvailableClis(profiles.find((p) => p.id === profileId));

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
    if (!hidden) inputRef.current?.focus({ preventScroll: true });
  }, [hidden]);

  // Closing the customize panel hands the focus back to the field.
  const wasCustomizing = useRef(false);
  useEffect(() => {
    if (wasCustomizing.current && !customizing) inputRef.current?.focus({ preventScroll: true });
    wasCustomizing.current = customizing;
  }, [customizing]);

  const { chips, chipShell } = shellChips(options, defaultShell);
  const chosenShell = () => (sameShell(shell, defaultShell) ? undefined : shell);
  const labelOf = (id: string | undefined) => {
    const opt = options.find((o) => sameShell(o.id, id ?? defaultShell));
    // "Predefinita (PowerShell)" is just PowerShell to the reader: name the shell.
    if (opt?.id === "system" && opt.label) return opt.label;
    return opt ? shellOptionLabel(opt) : (id ?? "");
  };

  /** Hands the tab over to the terminal. Nothing of this page carries over,
   * so it is gone as soon as the terminal is mounting. */
  function launch(next: NewTabLaunch) {
    if (leaving) return;
    setLeaving(true);
    onLaunch(next);
    onDone();
  }

  function pickShell(id: string) {
    setShell(id);
    onShellChange(sameShell(id, defaultShell) ? undefined : id);
    inputRef.current?.focus();
  }

  const favoriteEntry = (f: FavoriteFolder): Entry => ({
    id: `favorite:${f.path}`,
    kind: "favorite",
    label: f.name,
    detail: shownPath(f.path),
    texts: [f.name, f.path],
    icon: <FolderIcon size={18} />,
    run: () => launch({ shell: f.shell, cwd: f.path }),
  });
  const recentEntry = (r: RecentTerminal): Entry => ({
    id: `recent:${r.shell ?? ""}:${r.cwd}`,
    kind: "recent",
    label: r.name,
    detail: r.command,
    texts: [r.name, r.command, r.cwd],
    icon: <HistoryIcon size={16} />,
    run: () => launch({ shell: r.shell, cwd: r.cwd, command: r.command, typeOnly: true }),
  });
  const agentEntry = (cli: AgentCli): Entry => ({
    id: `agent:${cli}`,
    kind: "agent",
    label: CLI_INFO[cli].label,
    detail: CLI_INFO[cli].name,
    texts: [CLI_INFO[cli].label, CLI_INFO[cli].name, cli],
    icon: agentCliIcon(cli),
    run: () => onLaunchAgent(cli),
  });
  const shellEntry = (opt: ShellOption): Entry => ({
    id: `shell:${opt.id}`,
    kind: "shell",
    label: shellOptionLabel(opt),
    detail: t("newTab.glass.newTerminal"),
    texts: [shellOptionLabel(opt), opt.id],
    icon: shellOptionIcon(opt.id),
    run: () => launch({ shell: sameShell(chipShell(opt), defaultShell) ? undefined : chipShell(opt) }),
  });

  const favoriteEntries = sections.favorites ? favorites.map(favoriteEntry) : [];
  const recentEntries = sections.recents ? recents.map(recentEntry) : [];
  const agentEntries = sections.agents ? clis.map(agentEntry) : [];
  const searching = query.trim() !== "";
  /** What the arrow keys walk: the page's entries top to bottom, or the search's results. */
  const entries = searching
    ? fuzzyFilter([...agentEntries, ...recentEntries, ...favoriteEntries, ...chips.map(shellEntry)], query, (e) => e.texts).slice(0, RESULTS_SHOWN)
    : [...agentEntries, ...recentEntries, ...favoriteEntries];
  const entryDomId = (e: Entry) => `glass-entry-${e.id}`;
  const active = entries[selected];

  useEffect(() => {
    if (active) document.getElementById(entryDomId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      setSelected((s) => Math.min(entries.length - 1, s + 1));
      return;
    }
    if (e.key === "ArrowUp" && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      setSelected((s) => Math.max(-1, s - 1));
      return;
    }
    if (e.key === "Escape") {
      if (selected >= 0) setSelected(-1);
      else if (query) setQuery("");
      else if (dialog) onDismiss?.();
      return;
    }
    if (e.altKey && /^[1-9]$/.test(e.key)) {
      const opt = chips[Number(e.key) - 1];
      if (opt) {
        e.preventDefault();
        pickShell(chipShell(opt));
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const command = query.trim();
      // Shift+Enter, or nothing found: what was typed is a command for the chosen shell.
      if (command && (e.shiftKey || (!active && entries.length === 0))) {
        launch({ shell: chosenShell(), command });
        return;
      }
      const run = active ?? (searching ? entries[0] : undefined);
      if (run) run.run();
      else launch({ shell: chosenShell() });
    }
  }

  const entryButton = (entry: Entry, className: string, children: ReactNode) => (
    <button
      key={entry.id}
      id={entryDomId(entry)}
      type="button"
      role="option"
      aria-selected={entry === active}
      className={className + (entry === active ? " is-selected" : "")}
      tabIndex={-1}
      onClick={entry.run}
      onMouseDown={(e) => e.preventDefault()}
    >
      {children}
    </button>
  );

  const style = {
    "--glass-newtab-grain": grain,
    "--glass-newtab-blur": `${blur}px`,
    ...(background === "image" && image ? { "--glass-newtab-image": `url("${image}")` } : {}),
  } as CSSProperties;

  const rowButton = (entry: Entry, kindLabel: string) =>
    entryButton(
      entry,
      "glass-result",
      <>
        <span className="glass-icon">{entry.icon}</span>
        <span className="glass-result-name">{entry.label}</span>
        <span className={"glass-result-detail" + (entry.kind === "favorite" ? " is-path" : "")}>{entry.detail}</span>
        <span className="glass-result-kind">{kindLabel}</span>
      </>,
    );

  return (
    <div
      className={
        "glass-newtab" +
        (dialog ? " is-dialog" : "") +
        (background === "image" && image ? " has-image" : "") +
        (background === "solid" ? " is-solid" : "")
      }
      style={style}
      hidden={hidden}
      // A press on the scrim, not on the panel: the dialog closes.
      onMouseDown={dialog ? (e) => !(e.target as Element).closest(".glass-panel") && onDismiss?.() : undefined}
    >
      {!dialog && <div className="glass-newtab-backdrop" aria-hidden="true" />}
      {!dialog && <div className="glass-newtab-grain" aria-hidden="true" />}

      <div className="glass-newtab-scroll">
        <div className="glass-newtab-inner">
          <div
            className="glass-panel"
            role={dialog ? "dialog" : undefined}
            aria-modal={dialog ? true : undefined}
            aria-label={dialog ? t("newTab.title") : undefined}
          >
            <div className="glass-search" onClick={() => inputRef.current?.focus()}>
              <SearchIcon size={18} />
              <input
                ref={inputRef}
                className="glass-search-input"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelected(-1);
                }}
                onKeyDown={onKeyDown}
                placeholder={t("newTab.glass.placeholder")}
                autoComplete="off"
                spellCheck={false}
                role="combobox"
                aria-expanded="true"
                aria-label={t("newTab.glass.placeholder")}
                aria-controls="glass-newtab-entries"
                aria-activedescendant={active ? entryDomId(active) : undefined}
              />
              <kbd className="glass-kbd">↵ {labelOf(chosenShell())}</kbd>
              <button
                type="button"
                className="glass-customize"
                title={t("newTab.customize")}
                aria-label={t("newTab.customize")}
                onClick={(e) => {
                  e.stopPropagation();
                  onCustomize();
                }}
              >
                <PencilIcon size={15} />
              </button>
            </div>

            <div id="glass-newtab-entries" role="listbox" aria-label={t("newTab.glass.placeholder")} className="glass-body">
              {searching ? (
                entries.length === 0 ? (
                  <p className="glass-empty">{t("newTab.glass.noResults", { command: query.trim() })}</p>
                ) : (
                  <div className="glass-list">{entries.map((entry) => rowButton(entry, t(`newTab.glass.kind.${entry.kind}`)))}</div>
                )
              ) : (
                <>
                  {sections.agents && agentEntries.length > 0 && (
                    <section className="glass-section">
                      <h2 className="glass-heading">{t("newTab.glass.agents")}</h2>
                      <div className="glass-agents">
                        {agentEntries.map((entry) =>
                          entryButton(
                            entry,
                            "glass-agent",
                            <>
                              <span className="glass-icon">{entry.icon}</span>
                              {entry.label}
                            </>,
                          ),
                        )}
                      </div>
                    </section>
                  )}
                  {sections.recents && (
                    <section className="glass-section">
                      <h2 className="glass-heading">{t("newTab.recents")}</h2>
                      {recents.length === 0 ? (
                        <p className="glass-empty">{t("newTab.recentsEmpty")}</p>
                      ) : (
                        <div className="glass-list">{recentEntries.map((entry, i) => rowButton(entry, relativeTime(recents[i].at)))}</div>
                      )}
                    </section>
                  )}
                  {sections.favorites && (
                    <section className="glass-section">
                      <h2 className="glass-heading">{t("favorites.title")}</h2>
                      {favorites.length === 0 ? (
                        <p className="glass-empty">{t("newTab.favoritesEmpty")}</p>
                      ) : (
                        <div className="glass-favorites">
                          {favoriteEntries.map((entry) =>
                            entryButton(
                              entry,
                              "glass-favorite",
                              <>
                                <span className="glass-icon">{entry.icon}</span>
                                {entry.label}
                              </>,
                            ),
                          )}
                        </div>
                      )}
                    </section>
                  )}
                </>
              )}
            </div>

            <div className="glass-foot">
              <div className="glass-shells" role="group" aria-label={t("newTab.shellLabel")}>
                {chips.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className="glass-shell"
                    aria-pressed={chipShell(opt) === shell}
                    onClick={() => pickShell(chipShell(opt))}
                  >
                    {shellOptionLabel(opt)}
                  </button>
                ))}
              </div>
              {/* Env vars don't reach a WSL distro: no profile there. */}
              {profiles.length > 0 && wslDistroOfShell(shell) === undefined && (
                <div className="glass-foot-profile">
                  <ProfileSelect
                    value={profileId ?? undefined}
                    onChange={(id) => {
                      onProfileChange(id ?? null);
                      inputRef.current?.focus();
                    }}
                  />
                </div>
              )}
            </div>
          </div>
          <p className="glass-keys">
            {startDir ? t("newTab.glass.startsIn", { path: shownPath(startDir) }) + " · " : ""}
            {t(dialog ? "newTab.glass.keysDialog" : "newTab.glass.keysPage", { count: Math.min(chips.length, 9) })}
          </p>
        </div>
      </div>
    </div>
  );
}
