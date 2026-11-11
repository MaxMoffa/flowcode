import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LsEntry } from "../../shared/remote-types";
import { t } from "./i18n";
import { ChevronIcon, CopyIcon, FileIcon, FolderIcon, RefreshIcon, TerminalIcon } from "./icons";
import { fullPath, folderName, requestFs } from "./explorerRemote";
import { isHidden, setShowHidden, useShowHidden } from "./hiddenFiles";
import { showToast } from "./remote";

interface Listing {
  entries: LsEntry[];
  error?: string;
}

interface MenuState {
  path: string;
  dir: boolean;
  left: number;
  top: number;
}

interface Props {
  /** Absolute folder the tree is rooted at. */
  root: string;
  activeFile: string | null;
  onOpenFile: (absPath: string) => void;
  onOpenTerminal: (absPath: string) => void;
}

const parentOf = (p: string) => p.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "") || p;

/** The explorer of the wide sidebar: a lazy tree under `root`, with a long-press menu per row (the desktop's FileTree). */
export function WideTree({ root, activeFile, onOpenFile, onOpenTerminal }: Props) {
  const showHidden = useShowHidden();
  const [cache, setCache] = useState<Record<string, Listing>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set([root]));
  const [menu, setMenu] = useState<MenuState | null>(null);
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const rootRef = useRef(root);

  const load = useCallback(async (path: string) => {
    const forRoot = rootRef.current;
    try {
      const r = await requestFs({ op: "list", path });
      if (r.kind !== "list") throw new Error(t("fileError"));
      const entries = [...r.entries].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      if (rootRef.current === forRoot) setCache((c) => ({ ...c, [path]: { entries } }));
    } catch (e) {
      if (rootRef.current === forRoot) setCache((c) => ({ ...c, [path]: { entries: c[path]?.entries ?? [], error: e instanceof Error ? e.message : String(e) } }));
    }
  }, []);

  // A new root starts from scratch.
  useEffect(() => {
    rootRef.current = root;
    setCache({});
    setOpen(new Set([root]));
    setMenu(null);
    void load(root);
  }, [root, load]);

  const toggle = (path: string) => {
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else {
      next.add(path);
      if (!cacheRef.current[path]) void load(path);
    }
    setOpen(next);
  };
  const refresh = () => {
    for (const p of open) void load(p);
  };

  // Long press (or right click) opens the row's menu; the click that follows is swallowed.
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  const swallow = useRef(false);
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  const openMenu = (path: string, dir: boolean, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ path, dir, left: Math.max(4, Math.min(r.left + 20, window.innerWidth - 194)), top: Math.max(4, Math.min(r.bottom + 2, window.innerHeight - 250)) });
  };
  const pressProps = (path: string, dir: boolean) => ({
    onPointerDown: (ev: React.PointerEvent<HTMLElement>) => {
      cancelPress();
      swallow.current = false;
      if (ev.pointerType === "mouse" && ev.button !== 0) return;
      const el = ev.currentTarget;
      const timer = window.setTimeout(() => {
        press.current = null;
        swallow.current = true;
        openMenu(path, dir, el);
      }, 450);
      press.current = { x: ev.clientX, y: ev.clientY, timer };
    },
    onPointerMove: (ev: React.PointerEvent<HTMLElement>) => {
      if (press.current && Math.hypot(ev.clientX - press.current.x, ev.clientY - press.current.y) > 8) cancelPress();
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onContextMenu: (ev: React.MouseEvent<HTMLElement>) => {
      ev.preventDefault();
      cancelPress();
      swallow.current = false;
      openMenu(path, dir, ev.currentTarget);
    },
    onClickCapture: (ev: React.MouseEvent<HTMLElement>) => {
      if (!swallow.current) return;
      swallow.current = false;
      ev.stopPropagation();
      ev.preventDefault();
    },
  });

  const fail = (e: unknown) => showToast(e instanceof Error ? e.message : String(e));
  const reloadDir = (dir: string) => {
    void load(dir);
    setOpen((o) => (o.has(dir) ? o : new Set(o).add(dir)));
  };
  const create = async (dir: string, isDir: boolean) => {
    const name = window.prompt(isDir ? t("filesNewFolder") : t("filesNewFile"))?.trim();
    if (!name) return;
    try {
      await requestFs({ op: "create", path: dir, name, dir: isDir });
      reloadDir(dir);
    } catch (e) {
      fail(e);
    }
  };
  const rename = async (path: string) => {
    const name = window.prompt(t("rename"), folderName(path))?.trim();
    if (!name || name === folderName(path)) return;
    try {
      await requestFs({ op: "rename", path, name });
      reloadDir(parentOf(path));
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (path: string) => {
    if (!window.confirm(t("filesDeleteConfirm", { name: folderName(path) }))) return;
    try {
      await requestFs({ op: "delete", path });
      reloadDir(parentOf(path));
    } catch (e) {
      fail(e);
    }
  };
  const copyPath = (path: string) =>
    navigator.clipboard
      .writeText(path)
      .then(() => showToast(t("copied")))
      .catch(() => {});

  const rows = (dir: string, depth: number): React.ReactNode => {
    const l = cache[dir];
    if (!l) return <div className="wt-note" style={{ paddingLeft: 12 + depth * 14 }}>{t("loading")}</div>;
    const list = l.entries.filter((e) => showHidden || !isHidden(e));
    return (
      <>
        {l.error && <div className="wt-note err" style={{ paddingLeft: 12 + depth * 14 }}>{l.error}</div>}
        {list.map((e) => {
          const path = fullPath(dir, e.name);
          const isOpen = e.dir && open.has(path);
          return (
            <div key={e.name}>
              <button
                type="button"
                className={"wt-row" + (e.dir ? " dir" : "") + (!e.dir && path === activeFile ? " on" : "")}
                style={{ paddingLeft: 6 + depth * 14 }}
                onClick={() => (e.dir ? toggle(path) : onOpenFile(path))}
                {...pressProps(path, e.dir)}
              >
                <span className={"wt-caret" + (isOpen ? " open" : "")}>{e.dir && <ChevronIcon />}</span>
                <span className="wf-ico">{e.dir ? <FolderIcon /> : <FileIcon />}</span>
                <span className="wf-name">{e.name}</span>
              </button>
              {isOpen && rows(path, depth + 1)}
            </div>
          );
        })}
        {!l.error && list.length === 0 && depth === 0 && <div className="wt-note">{t("noEntries")}</div>}
      </>
    );
  };

  const menuClose = () => setMenu(null);
  const item = (label: string, fn: () => void, danger = false, icon?: React.ReactNode) => (
    <div className="w-menu-entry">
      <button
        type="button"
        role="menuitem"
        className={danger ? "danger" : undefined}
        onClick={() => {
          menuClose();
          fn();
        }}
      >
        {icon}
        {label}
      </button>
    </div>
  );

  // The menu lives in the unzoomed `.wide` root (as the tab menu does), so viewport coordinates apply as measured.
  const host = typeof document === "undefined" ? null : (document.querySelector<HTMLElement>(".wide") ?? document.body);

  return (
    <>
      <div className="w-ph wt-head">
        <span className="wf-path" title={root}>
          <bdi>{folderName(root)}</bdi>
        </span>
        <button type="button" className={"w-ib sm" + (showHidden ? " on" : "")} aria-label={showHidden ? t("wsHideHidden") : t("wsShowHidden")} title={showHidden ? t("wsHideHidden") : t("wsShowHidden")} aria-pressed={showHidden} onClick={() => setShowHidden(!showHidden)}>
          <span className="wt-eye">.*</span>
        </button>
        <button type="button" className="w-ib sm" aria-label={t("wsRefresh")} title={t("wsRefresh")} onClick={refresh}>
          <RefreshIcon />
        </button>
      </div>
      <div className="wf-list wt-list">{rows(root, 0)}</div>
      {menu &&
        host &&
        createPortal(
          <>
            <div
              className="w-menu-scrim"
              onClick={menuClose}
              onContextMenu={(ev) => {
                ev.preventDefault();
                menuClose();
              }}
            />
            <div className="w-menu w-tab-menu" role="menu" style={{ left: menu.left, top: menu.top }}>
              {menu.dir && item(t("filesNewFile"), () => void create(menu.path, false))}
              {menu.dir && item(t("filesNewFolder"), () => void create(menu.path, true))}
              {item(t("rename"), () => void rename(menu.path))}
              {item(t("filesDelete"), () => void remove(menu.path), true)}
              {menu.dir && item(t("wsOpenTerminalHere"), () => onOpenTerminal(menu.path), false, <TerminalIcon />)}
              {item(t("copyPath"), () => copyPath(menu.path), false, <CopyIcon />)}
            </div>
          </>,
          host,
        )}
    </>
  );
}
