import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPreviewableFile } from "../browser/browserStore";
import { getBrowserSettings } from "../browser/browserSettings";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useContextMenu, type ContextMenuItem } from "../context-menu/ContextMenuContext";
import { iconSvg, MenuIcons } from "../context-menu/menuIcons";
import { t } from "../i18n";
import { toWindowsPath } from "../terminal/wslPath";
import { isExecutablePath, type ParsedPath } from "./filePaths";
import { basename } from "./path";

/** What a path link points at, as the backend's `path_kind` reports it. */
export interface PathTarget {
  /** Absolute and normalized. */
  path: string;
  kind: "file" | "dir";
  /** A file the built-in editor can open (UTF-8 text, at most 20 MB). */
  text: boolean;
}

/** What the app can do with a path link beyond the OS (see App.tsx). */
export interface FileLinkActions {
  /** Opens a text file in an editor tab, at `line` (1-based) when given. */
  openInEditor: (path: string, line?: number) => void;
  /** Shows a folder in the explorer panel. */
  browseFolder: (path: string) => void;
  /** Shows a file (html, svg, pdf, image...) in the Browser panel. */
  openInPreview: (path: string) => void;
}

export const FileLinkActionsContext = createContext<FileLinkActions | null>(null);

/** The folder relative paths in a chat resolve against. `null` (the
 * default) = this chat's paths are not on this PC (a remote one's): no links. */
export const FileLinkCwdContext = createContext<string | null>(null);

/** The WSL distro a chat's agent runs in: its Linux paths are mapped to Windows ones before they're checked or opened. `null` = a Windows chat. */
export const FileLinkWslContext = createContext<string | null>(null);

/** How long an answer is trusted: a file can be created or deleted meanwhile. */
const CHECK_TTL_MS = 5000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; value: Promise<PathTarget | null> }>();

/** What `path` (relative ones against `cwd`) points at on disk, or null when
 * nothing is there. Answers are cached for a few seconds, so a terminal
 * hovered line by line or a chat redrawn while streaming asks only once. */
export function checkPath(path: string, cwd?: string | null): Promise<PathTarget | null> {
  if (!path || path.includes("\0")) return Promise.resolve(null);
  const key = `${cwd ?? ""}\0${path}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CHECK_TTL_MS) return hit.value;
  if (cache.size >= CACHE_MAX) {
    for (const [k, v] of cache) if (now - v.at >= CHECK_TTL_MS) cache.delete(k);
    if (cache.size >= CACHE_MAX) cache.clear();
  }
  const value = invoke<PathTarget | null>("path_kind", { path, cwd: cwd || null }).catch(() => null);
  cache.set(key, { at: now, value });
  return value;
}

export const PathIcons = {
  file: iconSvg(
    <>
      <path d="M6.5 3.5h7l4 4v12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" />
      <path d="M13.5 3.5v4h4" />
    </>,
  ),
  folder: iconSvg(<path d="M3.5 6.5a1 1 0 0 1 1-1H9l2 2h8.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />),
  edit: iconSvg(<path d="M16.5 3.5 20.5 7.5 8 20 3.5 20.5 4 16z" />),
  explorer: iconSvg(
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.6" />
      <path d="M9 4.5v15" />
    </>,
  ),
  copy: iconSvg(
    <>
      <rect x="7" y="3.5" width="9" height="4" rx="1" />
      <path d="M15.5 5.5H18a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V7A1.5 1.5 0 0 1 6 5.5h2.5" />
    </>,
  ),
};

/** The menu a click on an existing path shows. Never runs anything: a
 * program or script (by extension) gets no "open with the default app" -
 * text an agent or a program printed is not something to launch. */
function pathMenuItems(target: PathTarget, actions: FileLinkActions | null, line?: number): ContextMenuItem[] {
  const isFile = target.kind === "file";
  const items: ContextMenuItem[] = [
    {
      label: basename(target.path.replace(/[\\/]+$/, "")) || target.path,
      icon: isFile ? PathIcons.file : PathIcons.folder,
      disabled: true,
    },
    { label: "path-separator", separator: true },
  ];
  if (isFile && actions && isPreviewableFile(target.path)) {
    items.push({ label: t("pathLink.openInPreview"), icon: MenuIcons.globe, onSelect: () => actions.openInPreview(target.path) });
  }
  if (isFile && target.text && actions) {
    items.push({ label: t("pathLink.openFile"), icon: PathIcons.edit, onSelect: () => actions.openInEditor(target.path, line) });
  }
  if (isFile && !isExecutablePath(target.path)) {
    items.push({
      label: t("pathLink.openDefault"),
      icon: MenuIcons.openExternal,
      onSelect: () => {
        invoke("open_with_default_app", { path: target.path }).catch(() => {});
      },
    });
  }
  if (!isFile) {
    items.push({
      label: t("pathLink.openFolder"),
      icon: MenuIcons.openExternal,
      onSelect: () => {
        invoke("open_with_default_app", { path: target.path }).catch(() => {});
      },
    });
  }
  if (!isFile && actions) {
    items.push({ label: t("pathLink.openInExplorer"), icon: PathIcons.explorer, onSelect: () => actions.browseFolder(target.path) });
  }
  items.push({
    label: t("pathLink.reveal"),
    icon: PathIcons.folder,
    onSelect: () => {
      revealItemInDir(target.path).catch(() => {});
    },
  });
  items.push({
    label: t("pathLink.copy"),
    icon: PathIcons.copy,
    onSelect: () => {
      navigator.clipboard.writeText(target.path).catch(() => {});
    },
  });
  return items;
}

/** Shows the path menu at a click. */
export function useOpenPath(): (event: { clientX: number; clientY: number }, target: PathTarget, line?: number) => void {
  const { show } = useContextMenu();
  const actions = useContext(FileLinkActionsContext);
  return useCallback(
    (event, target, line) => {
      // Read at click time: a menu-less open needs no subscription.
      if (target.kind === "file" && actions && isPreviewableFile(target.path)) {
        const { artifacts } = getBrowserSettings();
        if (artifacts === "app") {
          actions.openInPreview(target.path);
          return;
        }
        if (artifacts === "system") {
          invoke("open_with_default_app", { path: target.path }).catch(() => {});
          return;
        }
      }
      show(event.clientX, event.clientY, pathMenuItems(target, actions, line));
    },
    [actions, show],
  );
}

/** A path written in the chat, as a link once the disk says it exists - plain
 * text until then (and for good when it doesn't, or the chat is a remote PC's). */
export function ChatPathLink({ parsed, children }: { parsed: ParsedPath; children: ReactNode }) {
  const cwd = useContext(FileLinkCwdContext);
  const distro = useContext(FileLinkWslContext);
  const open = useOpenPath();
  // A WSL agent writes Linux paths (`/mnt/c/...`): map them to the Windows ones the disk check and the opener need.
  const path = distro && parsed.path.startsWith("/") ? toWindowsPath(distro, parsed.path) : parsed.path;
  const [target, setTarget] = useState<PathTarget | null>(null);
  useEffect(() => {
    setTarget(null);
    if (cwd === null) return;
    let live = true;
    void checkPath(path, cwd).then((found) => {
      if (live) setTarget(found);
    });
    return () => {
      live = false;
    };
  }, [path, cwd]);
  if (!target) return <>{children}</>;
  // A span, not a <button>: a long path must wrap with the text around it.
  return (
    <span
      role="button"
      tabIndex={0}
      className="chat-path-link"
      title={target.path}
      onClick={(e) => {
        // Inside a tool step's <summary>: the click is the link's, not a toggle.
        e.preventDefault();
        e.stopPropagation();
        open(e, target, parsed.line);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        const box = e.currentTarget.getBoundingClientRect();
        open({ clientX: box.left, clientY: box.bottom }, target, parsed.line);
      }}
    >
      {children}
    </span>
  );
}
