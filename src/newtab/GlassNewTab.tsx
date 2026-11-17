import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listShellOptions, shellOptionLabel, type ShellOption } from "../terminal/shellOptions";
import { ChevronIcon, shellOptionIcon, useRowOverflow } from "../terminal/TabStrip";
import { sameShell, wslDistroOfShell } from "../terminal/wslPath";
import { listFavorites, subscribeFavorites, type FavoriteFolder } from "../favorites/favoritesStore";
import { listRecentTerminals, subscribeRecentTerminals, type RecentTerminal } from "./recentTerminals";
import { CLI_INFO, type AgentCli } from "../agents/cliInfo";
import { useAvailableClis } from "../agents/useAvailableClis";
import { agentCliIcon } from "../plugins/icons";
import { useProfiles } from "../profiles/profiles";
import { ProfileSelect } from "../profiles/ProfileSelect";
import { useI18n } from "../i18n";
import { CheckIcon, FolderIcon, HistoryIcon, PencilIcon, SearchIcon } from "./icons";
import { fuzzyFilter } from "./fuzzy";
import { useNewTabSettings } from "./newTabSettings";
import { useNewTabBackgroundImage } from "./newTabBackground";
import { shownPath } from "./promptText";
import { isWindowsPlatform, trimTrailingSeparators } from "../lib/path";
import {
  KIND_ORDER,
  completePath,
  groupByKind,
  kindsShown,
  matchingSubfolders,
  mergeFolders,
  nextFilter,
  parsePathQuery,
  rootsLabel,
  searchRoots,
  splitMatch,
  typedFolder,
  type ResultKind,
  type SearchFilter,
} from "./glassSearch";
import { shellChips } from "./shellChips";
import type { NewTabLaunch, NewTabLayoutProps } from "./types";
import { useRelativeTime } from "./useRelativeTime";
import { createPortal } from "react-dom";
import "./glass-newtab.css";

const RECENTS_SHOWN = 6;
const RESULTS_SHOWN = 12;
const FOLDERS_SHOWN = 12;
const PATH_SHOWN = 50;
/** How long the typing has to pause before the folders are searched. */
const FOLDER_SEARCH_DELAY = 200;
/** How many folder levels the search reads below each root. */
const FOLDER_SEARCH_DEPTH = 5;
/** The folder search's own generation counter, apart from the file tree's
 * (see `channel` in fs.rs's `search_dir`): a newer search stops the older walk. */
let folderSearchGeneration = 0;

interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** One thing the page can start - a tile, a row, a chip or a search result. */
interface Entry {
  id: string;
  kind: ResultKind;
  label: string;
  /** The folder, command or shell behind it. */
  detail: string;
  /** The folder it opens, for the ones that are folders - what the folder search leaves out. */
  path?: string;
  /** What Tab types into the field, for a folder listed while a path is typed. */
  completion?: string;
  /** What the fuzzy search looks at. */
  texts: string[];
  icon: ReactNode;
  run: () => void;
}

/** The agent chips in one row that scrolls sideways with no scrollbar: the
 * edges fade under arrows that show only where there is more, the way the tab
 * strip does (see TabStrip and tabstrip.css). A component of its own so the
 * row's listeners attach when it mounts - it comes and goes with the search. */
function AgentStrip({ count, children }: { count: number; children: ReactNode }) {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  const { canScrollLeft, canScrollRight } = useRowOverflow(viewportRef, count);

  // A vertical wheel scrolls the row sideways (a horizontal one already does).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * el.clientWidth : e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const scrollByPage = (direction: -1 | 1) => viewportRef.current?.scrollBy({ left: direction * viewportRef.current.clientWidth * 0.8, behavior: "smooth" });
  // The search field keeps the focus: a press on an arrow doesn't take it.
  const arrow = (direction: -1 | 1, can: boolean) => (
    <div className={"term-tab-fade " + (direction < 0 ? "is-left" : "is-right") + (can ? " is-visible" : "")} aria-hidden={!can}>
      <button
        type="button"
        className="term-tab-scroll"
        tabIndex={-1}
        aria-label={t(direction < 0 ? "newTab.glass.agentsPrev" : "newTab.glass.agentsNext")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => scrollByPage(direction)}
      >
        <ChevronIcon direction={direction < 0 ? "left" : "right"} />
      </button>
    </div>
  );

  return (
    <div className="glass-agents-wrap">
      <div ref={viewportRef} className={"glass-agents" + (canScrollLeft ? " fade-left" : "") + (canScrollRight ? " fade-right" : "")}>
        {children}
      </div>
      {arrow(-1, canScrollLeft)}
      {arrow(1, canScrollRight)}
    </div>
  );
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
  /** The agent ticked: the next folder picked starts it there, instead of a plain terminal. */
  const [agent, setAgent] = useState<AgentCli | null>(null);
  /** The pill picked under the search field (while a query is typed). */
  const [filter, setFilter] = useState<SearchFilter>("all");
  const [home, setHome] = useState<string | null>(null);
  /** What the backend found for `query`, folder by folder under each root. */
  const [folderHits, setFolderHits] = useState<{ query: string; lists: FsEntry[][] } | null>(null);
  /** The folder a typed path points into, as `read_dir` listed it (null: it couldn't). */
  const [listing, setListing] = useState<{ key: string; entries: FsEntry[] | null } | null>(null);
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
    // An agent is ticked and no command was typed: the agent starts where the pick points.
    if (agent && !next.command) {
      onLaunchAgent(agent, next.cwd, next.shell);
      return;
    }
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
    path: f.path,
    texts: [f.name, f.path],
    icon: <FolderIcon size={18} />,
    run: () => launch({ shell: f.shell, cwd: f.path }),
  });
  const recentEntry = (r: RecentTerminal): Entry => ({
    id: `recent:${r.shell ?? ""}:${r.cwd}`,
    kind: "recent",
    label: r.name,
    detail: r.command,
    path: r.cwd,
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
    run: () => setAgent((current) => (current === cli ? null : cli)),
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

  /** A folder found on disk (or listed in a typed path): opens a terminal there, or starts the ticked agent. */
  const folderEntry = (path: string, name: string): Entry => ({
    id: `folder:${path}`,
    kind: "folder",
    label: name,
    detail: shownPath(path),
    path,
    texts: [name],
    icon: <FolderIcon size={16} />,
    run: () => launch({ cwd: path }),
  });
  const favoriteEntries = sections.favorites ? favorites.map(favoriteEntry) : [];
  const recentEntries = sections.recents ? recents.map(recentEntry) : [];
  const agentEntries = sections.agents ? clis.map(agentEntry) : [];
  const searching = query.trim() !== "";
  const q = query.trim();
  const kinds = kindsShown(filter);

  // A path typed: the folders in it, to complete or open.
  const pathQuery = searching ? parsePathQuery(query, { home, base: startDir || null, windows: isWindowsPlatform() }) : null;
  const wantHidden = !!pathQuery?.segment.startsWith(".");
  const listingKey = pathQuery ? `${pathQuery.readPath}|${wantHidden}` : null;
  const listed = listing && listing.key === listingKey ? listing.entries : undefined;
  // A relative one only counts once its folder is known to exist.
  const pathMode = !!pathQuery && (pathQuery.explicit || !!listed);
  const pathEntries: Entry[] =
    pathMode && pathQuery
      ? matchingSubfolders(listed ?? [], pathQuery.segment)
          .slice(0, PATH_SHOWN)
          .map((dir) => ({ ...folderEntry(pathQuery.readPath + dir.name, dir.name), completion: completePath(pathQuery, dir.name) }))
      : [];

  // Everything else: the entries that match, then the folders found on disk.
  const roots = useMemo(() => searchRoots(favorites.map((f) => f.path), home), [favorites, home]);
  const rootsKey = roots.map((r) => r.path).join("\n");
  const folderSection = searching && !pathMode && kinds.has("folder");
  const wantFolders = folderSection && roots.length > 0;
  const folderPending = wantFolders && folderHits?.query !== q;
  const localMatches =
    searching && !pathMode
      ? fuzzyFilter([...agentEntries, ...recentEntries, ...favoriteEntries, ...chips.map(shellEntry)].filter((e) => kinds.has(e.kind)), query, (e) => e.texts).slice(0, RESULTS_SHOWN)
      : [];
  const folderEntries =
    wantFolders && folderHits?.query === q
      ? mergeFolders(folderHits.lists, q, localMatches.flatMap((e) => (e.path ? [e.path] : [])), FOLDERS_SHOWN).map((f) => folderEntry(f.path, f.name))
      : [];
  /** What the arrow keys walk: the page's entries top to bottom, or the search's results as listed. */
  const entries = pathMode ? pathEntries : searching ? groupByKind([...localMatches, ...folderEntries]) : [...agentEntries, ...recentEntries, ...favoriteEntries];
  const entryDomId = (e: Entry) => `glass-entry-${e.id}`;
  const active = entries[selected];

  useEffect(() => {
    if (active) document.getElementById(entryDomId(active))?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  useEffect(() => {
    if (!searching) setFilter("all");
  }, [searching]);

  useEffect(() => {
    let cancelled = false;
    void invoke<string>("home_dir").then(
      (dir) => !cancelled && setHome(dir),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // The folders in the typed path - the listing only depends on the folder, so typing its name doesn't reload it.
  useEffect(() => {
    if (!pathQuery || !listingKey) return;
    let cancelled = false;
    void invoke<FsEntry[]>("read_dir", { path: pathQuery.readPath, showHidden: wantHidden }).then(
      (found) => !cancelled && setListing({ key: listingKey, entries: found }),
      () => !cancelled && setListing({ key: listingKey, entries: null }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingKey]);

  // The folder search, once the typing pauses: only folders, a few levels deep, under each root.
  useEffect(() => {
    if (!wantFolders) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const generation = ++folderSearchGeneration;
      void Promise.all(
        roots.map((root) =>
          invoke<FsEntry[]>("search_dir", { path: root.path, query: q, showHidden: false, generation, dirsOnly: true, maxDepth: FOLDER_SEARCH_DEPTH, channel: "newtab" }).catch(() => [] as FsEntry[]),
        ),
      ).then((lists) => !cancelled && setFolderHits({ query: q, lists }));
    }, FOLDER_SEARCH_DELAY);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantFolders, q, rootsKey]);

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
    if (e.key === "Tab" && searching && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // A path is typed: Tab completes the folder picked. Otherwise it cycles the pills.
      if (pathMode) {
        const target = active ?? entries[0];
        if (!e.shiftKey && target?.completion) {
          e.preventDefault();
          setQuery(target.completion);
          setSelected(-1);
        }
        return;
      }
      e.preventDefault();
      setFilter((f) => nextFilter(f, e.shiftKey ? -1 : 1));
      setSelected(-1);
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
      if (command && e.shiftKey) {
        launch({ shell: chosenShell(), command });
        return;
      }
      // A path typed and no folder picked: the folder typed so far, if it exists, else the first one listed.
      if (pathMode && pathQuery && !active) {
        const typed = trimTrailingSeparators(typedFolder(pathQuery));
        const fallback = () => (entries[0] ? entries[0].run() : launch({ shell: chosenShell(), command }));
        void invoke<boolean>("is_directory", { path: typed }).then((isDir) => (isDir ? launch({ cwd: typed }) : fallback()), fallback);
        return;
      }
      if (command && !active && entries.length === 0) {
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
      aria-pressed={entry.kind === "agent" ? agent === entry.id.slice("agent:".length) : undefined}
      className={className + (entry === active ? " is-selected" : "") + (entry.kind === "agent" && agent === entry.id.slice("agent:".length) ? " is-picked" : "")}
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

  /** `highlight`: the part of the name the search matched, shown in the accent. */
  const rowButton = (entry: Entry, kindLabel?: string, highlight?: string) =>
    entryButton(
      entry,
      "glass-result",
      <>
        <span className="glass-icon">{entry.icon}</span>
        <span className="glass-result-name">{highlighted(entry.label, highlight)}</span>
        <span className={"glass-result-detail" + (entry.kind === "favorite" || entry.kind === "folder" ? " is-path" : "")}>{entry.detail}</span>
        {kindLabel && <span className="glass-result-kind">{kindLabel}</span>}
        {entry.kind === "agent" && (
          <span className="glass-agent-check" aria-hidden="true">
            <CheckIcon size={14} />
          </span>
        )}
      </>,
    );

  const highlighted = (text: string, term?: string): ReactNode => {
    const parts = term ? splitMatch(text, term) : null;
    return parts ? (
      <>
        {parts.before}
        <mark>{parts.match}</mark>
        {parts.after}
      </>
    ) : (
      text
    );
  };
  const sectionTitle: Record<ResultKind, string> = {
    agent: t("newTab.glass.agents"),
    recent: t("newTab.recents"),
    favorite: t("favorites.title"),
    folder: t("newTab.glass.folders"),
    shell: t("newTab.glass.kind.shell"),
  };

  const page = (
    <div
      className={
        "glass-newtab" +
        (dialog ? " is-dialog" : "") +
        (background === "image" && image ? " has-image" : "") +
        (background === "solid" ? " is-solid" : "")
      }
      style={style}
      hidden={hidden}
      // A press on the scrim, not on the panel: the dialog closes. The profile
      // menu is portaled out of the panel, but React still bubbles its presses
      // here - they are not outside clicks.
      onMouseDown={dialog ? (e) => !(e.target as Element).closest(".glass-panel, [data-profile-select-menu]") && onDismiss?.() : undefined}
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

            {searching && !pathMode && (
              <div className="glass-filters" role="group" aria-label={t("newTab.glass.filters")}>
                {(["all", "folders", "agents", "recents"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="glass-filter"
                    aria-pressed={filter === f}
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setFilter(f);
                      setSelected(-1);
                    }}
                  >
                    {t(`newTab.glass.filter.${f}`)}
                  </button>
                ))}
              </div>
            )}

            <div id="glass-newtab-entries" role="listbox" aria-label={t("newTab.glass.placeholder")} className="glass-body">
              {searching && pathMode && pathQuery ? (
                <section className="glass-section">
                  <p className="glass-pathline">
                    {t("newTab.glass.path", { dir: shownPath(pathQuery.dir) })}
                    <span> · {t("newTab.glass.pathKeys")}</span>
                  </p>
                  {pathEntries.length === 0 ? (
                    <p className="glass-empty">{t("newTab.glass.pathEmpty")}</p>
                  ) : (
                    <div className="glass-list">{pathEntries.map((entry) => rowButton(entry, undefined, pathQuery.segment))}</div>
                  )}
                </section>
              ) : searching ? (
                entries.length === 0 && !folderPending ? (
                  <p className="glass-empty">{t("newTab.glass.noResults", { command: query.trim() })}</p>
                ) : (
                  KIND_ORDER.map((kind) => {
                    const rows = entries.filter((e) => e.kind === kind);
                    const folders = kind === "folder";
                    if (folders ? !wantFolders || (rows.length === 0 && !folderPending && entries.length === 0) : rows.length === 0) return null;
                    return (
                      <section key={kind} className="glass-section">
                        <h2 className="glass-heading">
                          {sectionTitle[kind]}
                          {folders && <span className="glass-scope">{t("newTab.glass.foldersIn", { roots: rootsLabel(roots, t("newTab.glass.home")) })}</span>}
                        </h2>
                        {folders && folderPending ? (
                          <div className="glass-loading">
                            <span className="glass-spinner" aria-hidden="true" />
                            {t("newTab.glass.searchingFolders")}
                          </div>
                        ) : rows.length === 0 ? (
                          <p className="glass-empty">{t("newTab.glass.noFolders", { query: q })}</p>
                        ) : (
                          <div className="glass-list">{rows.map((entry) => rowButton(entry, undefined, folders ? q : undefined))}</div>
                        )}
                      </section>
                    );
                  })
                )
              ) : (
                <>
                  {sections.agents && agentEntries.length > 0 && (
                    <section className="glass-section">
                      <h2 className="glass-heading">{t("newTab.glass.agents")}</h2>
                      <AgentStrip count={agentEntries.length}>
                        {agentEntries.map((entry) =>
                          entryButton(
                            entry,
                            "glass-agent",
                            <>
                              <span className="glass-icon">{entry.icon}</span>
                              {entry.label}
                              <span className="glass-agent-check" aria-hidden="true">
                                <CheckIcon size={14} />
                              </span>
                            </>,
                          ),
                        )}
                      </AgentStrip>
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
  // As a dialog it covers the whole window, not the tab's content area.
  return dialog ? createPortal(page, document.body) : page;
}
