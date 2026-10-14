import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { relativeCommitTime } from "../lib/time";
import { gitBranches, gitSwitchBranch, type GitBranch, type GitBranches } from "./gitStatus";
import { useOutsideClose } from "../hooks/useOutsideClose";

interface BranchMenuProps {
  root: string;
  /** What the button shows: the branch, or the detached HEAD. */
  label: string;
  icon: ReactNode;
  /** Called after git switched, to refresh the panel. */
  onSwitched: () => void;
}

/** A branch of the list; `remote` ones are created as local tracking branches. */
interface Item {
  branch: GitBranch;
  remote: boolean;
  current: boolean;
}

const MENU_WIDTH = 260;
const MENU_MARGIN = 8;

/** Fixed-position coordinates of the menu: `top` below the button, or `bottom` above it. */
interface MenuPos {
  left: number;
  top?: number;
  bottom?: number;
}

/** Where to show the menu under (or, when there is little room below, above) the button. */
function placeMenu(button: HTMLElement): MenuPos {
  const rect = button.getBoundingClientRect();
  const left = Math.max(MENU_MARGIN, Math.min(rect.left - 4, window.innerWidth - MENU_WIDTH - MENU_MARGIN));
  const roomBelow = window.innerHeight - rect.bottom;
  if (roomBelow < 240 && rect.top > roomBelow) {
    return { left, bottom: window.innerHeight - rect.top + 4 };
  }
  return { left, top: rect.bottom + 4 };
}

/** The Git panel's branch name as a button; opens a filterable list of local
 * and remote branches to switch to. The list is fetched each time it opens. */
export function BranchMenu({ root, label, icon, onSwitched }: BranchMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<GitBranches | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useOutsideClose(open, [rootRef, menuRef], () => setOpen(false));

  // The menu is fixed to the viewport: follow the button on resize, close on blur
  // or when any ancestor scrolls (scrolls inside the menu's own list are kept).
  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      if (buttonRef.current) setPos(placeMenu(buttonRef.current));
    };
    const onBlur = () => setOpen(false);
    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onBlur);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // Fresh list on every open; a failure to list is shown above the (empty) list.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setData(null);
    gitBranches(root)
      .then((next) => {
        if (!stale) setData(next);
      })
      .catch((e) => {
        if (!stale) setError(t("git.branch.listError", { error: String(e) }));
      });
    return () => {
      stale = true;
    };
  }, [open, root]);

  const needle = query.trim().toLowerCase();
  const { locals, remotes } = useMemo(() => {
    const match = (b: GitBranch) => !needle || b.name.toLowerCase().includes(needle);
    return {
      locals: (data?.local ?? []).filter(match).map((branch): Item => ({ branch, remote: false, current: branch.name === data?.current })),
      remotes: (data?.remote ?? []).filter(match).map((branch): Item => ({ branch, remote: true, current: false })),
    };
  }, [data, needle]);
  // What arrows and Enter walk through: the current branch is only shown.
  const selectable = useMemo(() => [...locals, ...remotes].filter((i) => !i.current), [locals, remotes]);

  useEffect(() => setActive(0), [needle]);
  useEffect(() => {
    listRef.current?.querySelector(".git-branch-option.is-active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setQuery("");
    setActive(0);
    setError(null);
    if (buttonRef.current) setPos(placeMenu(buttonRef.current));
    setOpen(true);
  }

  async function pick(item: Item | undefined) {
    if (!item || item.current || switching) return;
    setSwitching(true);
    setError(null);
    try {
      await gitSwitchBranch(root, item.branch.name, item.remote);
      setOpen(false);
      onSwitched();
    } catch (e) {
      setError(t("git.branch.error", { error: String(e) }));
    } finally {
      setSwitching(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) return;
    // Stop handled keys here: the menu is a portal, so its events also bubble
    // through this wrapper in the React tree and must not be handled twice.
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (selectable.length > 0) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : selectable.length - 1)) % selectable.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void pick(selectable[active]);
    }
  }

  function renderItem(item: Item) {
    const index = selectable.indexOf(item);
    const time = item.branch.last_commit_unix;
    return (
      <div
        key={(item.remote ? "r:" : "l:") + item.branch.name}
        id={index >= 0 ? `${listId}-${index}` : undefined}
        role="option"
        aria-selected={item.current}
        aria-disabled={item.current || switching}
        className={"git-branch-option" + (index === active ? " is-active" : "") + (item.current ? " is-current" : "")}
        title={item.current ? t("git.branch.current") : item.branch.name}
        onMouseEnter={() => index >= 0 && setActive(index)}
        onClick={() => void pick(item)}
      >
        <span className="git-branch-option-check" aria-hidden>
          {item.current && (
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12 5 5 9-10" />
            </svg>
          )}
        </span>
        <span className="git-branch-option-name">{item.branch.name}</span>
        {time != null && <span className="git-branch-option-time">{relativeCommitTime(time)}</span>}
      </div>
    );
  }

  const empty = data != null && locals.length === 0 && remotes.length === 0;

  return (
    <div className="git-branch" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        className="git-branch-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={`${t("git.branch.switch")}: ${label}`}
        onClick={toggle}
      >
        {icon}
        <span className="git-branch-name">{label}</span>
        <svg className="git-branch-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} className="git-branch-menu" style={{ left: pos.left, top: pos.top, bottom: pos.bottom }} onKeyDown={onKeyDown} aria-busy={switching}>
          <input
            className="git-branch-filter"
            autoFocus
            value={query}
            placeholder={t("git.branch.filter")}
            aria-label={t("git.branch.filter")}
            spellCheck={false}
            disabled={switching}
            onChange={(e) => setQuery(e.target.value)}
          />
          {error && <div className="git-error">{error}</div>}
          <div className={"git-branch-list" + (switching ? " is-busy" : "")} id={listId} role="listbox" ref={listRef} aria-activedescendant={selectable.length > 0 ? `${listId}-${active}` : undefined}>
            {data == null && !error && <div className="git-branch-note">{t("common.loading")}</div>}
            {empty && <div className="git-branch-note">{t("git.branch.none")}</div>}
            {locals.length > 0 && <div className="git-branch-section">{t("git.branch.local")}</div>}
            {locals.map(renderItem)}
            {remotes.length > 0 && <div className="git-branch-section">{t("git.branch.remote")}</div>}
            {remotes.map(renderItem)}
          </div>
          {switching && <div className="git-branch-note">{t("git.branch.switching")}</div>}
        </div>,
        document.body,
      )}
    </div>
  );
}
