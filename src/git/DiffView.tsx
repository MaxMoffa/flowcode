import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror/language";
import { unifiedMergeView } from "@codemirror/merge";
import { FileTypeIcon } from "../sidebar/fileIcons";
import { languageFor } from "../editor/language";
import { cmChromeTheme, cmHighlightStyle } from "../editor/cmTheme";
import { basename, normalizeDir } from "../lib/path";
import { useI18n } from "../i18n";
import { gitShowFile, joinRepoPath } from "./gitStatus";
import "../editor/editor.css";
import "./diff-view.css";

interface DiffViewProps {
  root: string;
  /** Repo-relative, forward slashes. */
  path: string;
  staged: boolean;
  hidden?: boolean;
}

interface Sides {
  original: string;
  modified: string;
}

const POLL_MS = 4000;

/** Read-only unified diff of one file. Staged: HEAD against the index.
 * Unstaged: the index against the file on disk (a deleted file reads as
 * empty). */
export function DiffView({ root, path, staged, hidden }: DiffViewProps) {
  const { t } = useI18n();
  const [sides, setSides] = useState<Sides | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const name = basename(path);

  // A different file/side starts from scratch: the old text must not show
  // under the new name while it loads.
  useEffect(() => {
    setSides(null);
    setError(null);
  }, [root, path, staged]);

  // Latest request wins: an older, slower read must not land last.
  const requestRef = useRef(0);

  // Loads on mount, whenever the tab is shown again, on window focus, when the
  // file's folder changes and on a slow poll: the file keeps changing while
  // the user works in the terminal.
  useEffect(() => {
    if (hidden) return;
    let cancelled = false;
    const load = () => {
      const id = ++requestRef.current;
      const read = staged
        ? Promise.all([gitShowFile(root, path, "HEAD"), gitShowFile(root, path, "INDEX")])
        : Promise.all([
            gitShowFile(root, path, "INDEX"),
            invoke<string>("read_text_file", { path: joinRepoPath(root, path) }).catch(() => ""),
          ]);
      read
        .then(([original, modified]) => {
          if (cancelled || id !== requestRef.current) return;
          setError(null);
          // Same text: keep the view (and its scroll position) untouched.
          setSides((prev) => (prev && prev.original === original && prev.modified === modified ? prev : { original, modified }));
        })
        .catch((e) => {
          if (!cancelled && id === requestRef.current) setError(String(e));
        });
    };
    load();
    window.addEventListener("focus", load);
    const poll = setInterval(() => {
      if (document.visibilityState === "visible" && document.hasFocus()) load();
    }, POLL_MS);
    // The explorer's watcher reports the folder it is on (non-recursive).
    const fileDir = normalizeDir(joinRepoPath(root, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""));
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unlisten = listen<string>("fs-changed", (event) => {
      if (normalizeDir(event.payload) !== fileDir) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(load, 300);
    });
    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      clearInterval(poll);
      window.removeEventListener("focus", load);
      unlisten.then((fn) => fn());
    };
  }, [root, path, staged, hidden]);

  // The view is rebuilt whenever the text changes (a poll that found an edit):
  // carry the scroll position over, but start at the top for another file.
  const scrollTopRef = useRef(0);
  useEffect(() => {
    scrollTopRef.current = 0;
  }, [root, path, staged]);

  useEffect(() => {
    if (!sides || !hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: sides.modified,
        extensions: [
          lineNumbers(),
          EditorState.readOnly.of(true),
          languageFor(name) ?? [],
          syntaxHighlighting(cmHighlightStyle),
          cmChromeTheme,
          unifiedMergeView({ original: sides.original, mergeControls: false }),
        ],
      }),
    });
    view.scrollDOM.scrollTop = scrollTopRef.current;
    return () => {
      // A hidden (display:none) view reports 0 - keep the last real position.
      if (view.scrollDOM.clientHeight > 0) scrollTopRef.current = view.scrollDOM.scrollTop;
      view.destroy();
    };
  }, [sides, name]);

  return (
    <div className="editor-view diff-view" style={{ display: hidden ? "none" : "flex" }}>
      <div className="editor-toolbar">
        <FileTypeIcon name={name} />
        <span className="editor-name" title={path}>
          {name}
        </span>
        <span className="editor-status">{staged ? t("git.group.staged") : t("git.group.changes")}</span>
      </div>
      {error ? (
        <div className="editor-error">{t("git.diffFailed", { error })}</div>
      ) : sides === null ? (
        <div className="editor-loading">{t("common.loading")}</div>
      ) : null}
      {/* Always mounted: swapping it for the error div would orphan the
          CodeMirror view and a later success would mount into an empty host. */}
      <div className="editor-host" ref={hostRef} style={error || sides === null ? { display: "none" } : undefined} />
    </div>
  );
}
