import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror/language";
import { unifiedMergeView } from "@codemirror/merge";
import { FileTypeIcon } from "../sidebar/fileIcons";
import { languageFor } from "../editor/language";
import { cmChromeTheme, cmHighlightStyle } from "../editor/cmTheme";
import { basename } from "../lib/path";
import { useI18n } from "../i18n";
import { gitShowFile } from "./gitStatus";
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

function absolute(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + rel.split("/").join(sep);
}

/** Read-only unified diff of one file. Staged: HEAD against the index.
 * Unstaged: the index against the file on disk (a deleted file reads as
 * empty). */
export function DiffView({ root, path, staged, hidden }: DiffViewProps) {
  const { t } = useI18n();
  const [sides, setSides] = useState<Sides | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const name = basename(path);

  // Loads on mount, whenever the tab is shown again and on window focus: the
  // file keeps changing while the user works in the terminal.
  useEffect(() => {
    if (hidden) return;
    let cancelled = false;
    const load = () => {
      const read = staged
        ? Promise.all([gitShowFile(root, path, "HEAD"), gitShowFile(root, path, "INDEX")])
        : Promise.all([
            gitShowFile(root, path, "INDEX"),
            invoke<string>("read_text_file", { path: absolute(root, path) }).catch(() => ""),
          ]);
      read
        .then(([original, modified]) => {
          if (cancelled) return;
          setError(null);
          // Same text: keep the view (and its scroll position) untouched.
          setSides((prev) => (prev && prev.original === original && prev.modified === modified ? prev : { original, modified }));
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        });
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, [root, path, staged, hidden]);

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
    return () => view.destroy();
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
      ) : (
        <div className="editor-host" ref={hostRef} />
      )}
    </div>
  );
}
