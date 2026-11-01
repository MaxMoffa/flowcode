import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorView as CMEditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, indentUnit } from "@codemirror/language";
import { lintGutter } from "@codemirror/lint";
import { basicSetup } from "codemirror";
import { FileTypeIcon } from "../sidebar/fileIcons";
import { languageFor } from "./language";
import { buildLinter } from "./lint";
import { cmChromeTheme, cmHighlightStyle } from "./cmTheme";
import { basename } from "../lib/path";
import { useI18n } from "../i18n";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import "./editor.css";

/** Moves the cursor to (and centers the view on) a 1-indexed line, clamped to the document. */
function goToLine(view: CMEditorView, line: number) {
  const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
  const pos = view.state.doc.line(clamped).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: CMEditorView.scrollIntoView(pos, { y: "center" }),
  });
  view.focus();
}

export interface EditorHandle {
  isDirty: () => boolean;
  /** Resolves true only when the current buffer is clean after saving. */
  save: () => Promise<boolean>;
  /** Current buffer text, for building the "jump to symbol" sidebar outline. */
  getContent: () => string;
  /** Moves the cursor to (and centers the view on) a 1-indexed line. */
  scrollToLine: (line: number) => void;
}

interface EditorViewProps {
  path: string;
  hidden?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onRenamed?: (newPath: string) => void;
  /** Unsaved text carried over from another window (a tab moved there with
   * pending edits) - shown instead of what's on disk, still marked unsaved.
   * Only read once, at mount. */
  initialContent?: string;
}

export const EditorView = forwardRef<EditorHandle, EditorViewProps>(({ path, hidden, onDirtyChange, onRenamed, initialContent }, ref) => {
  const { t } = useI18n();
  const confirm = useConfirmDialog();
  // The save closure is captured once by the CodeMirror keymap: read the
  // latest translator/dialog through a ref instead of re-creating the editor.
  const promptRef = useRef({ t, confirm });
  promptRef.current = { t, confirm };
  const [content, setContent] = useState<string | null>(null);
  // Split so a failed save never unmounts the editor (the unsaved text would
  // become unreachable); only a failed load replaces it.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(initialContent !== undefined);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");

  const hostRef = useRef<HTMLDivElement>(null);
  const cmViewRef = useRef<CMEditorView | null>(null);
  const languageCompartment = useRef<Compartment | null>(null);
  const lintCompartment = useRef<Compartment | null>(null);
  const originalRef = useRef("");
  const pathRef = useRef(path);
  // A moved buffer already belongs to the user while its disk baseline is
  // loading. Window-close checks must not treat it as a clean empty editor.
  const dirtyRef = useRef(initialContent !== undefined);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  const renameInFlightRef = useRef(false);
  const initialPathRef = useRef(path);
  const initialContentRef = useRef(initialContent);
  const renameInputRef = useRef<HTMLInputElement>(null);
  // A `scrollToLine` asked before the text was loaded.
  const pendingLineRef = useRef<number | null>(null);
  // Enter commits and the blur that follows must not commit a second time.
  const renameDoneRef = useRef(false);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  pathRef.current = path;

  useEffect(() => {
    let active = true;
    invoke<string>("read_text_file", { path: initialPathRef.current })
      .then((text) => {
        if (!active) return;
        originalRef.current = text;
        setContent(initialContentRef.current ?? text);
      })
      .catch((e) => {
        if (active) setLoadError(String(e));
      });
    // StrictMode replays this effect. Its first, slower read must not reset
    // the live editor after the second read has loaded and editing began.
    return () => {
      active = false;
    };
  }, []);

  const performSave = useCallback((): Promise<boolean> => {
    if (saveInFlightRef.current) return saveInFlightRef.current;
    const view = cmViewRef.current;
    if (!view || renameInFlightRef.current) return Promise.resolve(false);
    const text = view.state.doc.toString();
    const original = originalRef.current;
    const targetPath = pathRef.current;
    if (text === original) return Promise.resolve(true);
    const isCurrent = () => cmViewRef.current === view && pathRef.current === targetPath && !renameInFlightRef.current;
    const save = async (): Promise<boolean> => {
      setSaving(true);
      try {
        // Keep one snapshot throughout the read, confirmation and write. A
        // rename must never redirect this save to a different path.
        const onDisk = await invoke<string>("read_text_file", { path: targetPath }).catch(() => null);
        if (!isCurrent() || originalRef.current !== original) return false;
        if (onDisk !== null && onDisk !== original) {
          const { t: tr, confirm: ask } = promptRef.current;
          const overwrite = await ask({
            title: tr("editor.changedOnDisk.title"),
            message: tr("editor.changedOnDisk.body"),
            confirmLabel: tr("editor.changedOnDisk.overwrite"),
            danger: true,
          });
          if (!overwrite || !isCurrent() || originalRef.current !== original) return false;
        }
        await invoke("write_text_file", { path: targetPath, contents: text });
        if (!isCurrent()) return false;
        originalRef.current = text;
        setSaveError(null);
        // Typing during the write keeps the new edits dirty. A window close
        // waiting on save must not treat that older snapshot as all saved.
        const stillDirty = view.state.doc.toString() !== text;
        if (stillDirty !== dirtyRef.current) {
          dirtyRef.current = stillDirty;
          setDirty(stillDirty);
          onDirtyChangeRef.current?.(stillDirty);
        }
        return !stillDirty;
      } catch (e) {
        if (isCurrent()) setSaveError(String(e));
        return false;
      } finally {
        setSaving(false);
      }
    };
    const pending = save();
    saveInFlightRef.current = pending;
    const clear = () => {
      if (saveInFlightRef.current === pending) saveInFlightRef.current = null;
    };
    void pending.then(clear, clear);
    return pending;
  }, []);

  // A clean buffer follows the file when it changes on disk (an agent edited
  // it): checked whenever the window regains focus. A hidden (display:none)
  // editor skips the check and catches up when it is shown again.
  const hiddenRef = useRef(!!hidden);
  hiddenRef.current = !!hidden;
  const syncFromDiskRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let checking = false;
    const syncFromDisk = async () => {
      const view = cmViewRef.current;
      if (checking || !view || dirtyRef.current || hiddenRef.current || saveInFlightRef.current || renameInFlightRef.current) return;
      checking = true;
      const readPath = pathRef.current;
      try {
        const onDisk = await invoke<string>("read_text_file", { path: readPath });
        // Typing while the read was in flight makes the buffer dirty: keep it.
        if (onDisk === originalRef.current || dirtyRef.current || cmViewRef.current !== view || pathRef.current !== readPath || saveInFlightRef.current || renameInFlightRef.current) return;
        // originalRef first: the update listener then sees a clean buffer.
        originalRef.current = onDisk;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: onDisk } });
      } catch {
        /* file gone or unreadable: leave the buffer as it is */
      } finally {
        checking = false;
      }
    };
    syncFromDiskRef.current = syncFromDisk;
    window.addEventListener("focus", syncFromDisk);
    return () => window.removeEventListener("focus", syncFromDisk);
  }, []);

  // Shown again: pick up what changed on disk meanwhile. The first run is
  // skipped - mounting already loads the file.
  const shownOnceRef = useRef(false);
  useEffect(() => {
    if (!shownOnceRef.current) {
      shownOnceRef.current = true;
      return;
    }
    if (!hidden) void syncFromDiskRef.current();
  }, [hidden]);

  useImperativeHandle(
    ref,
    () => ({
      isDirty: () => dirtyRef.current,
      save: performSave,
      getContent: () => cmViewRef.current?.state.doc.toString() ?? content ?? initialContentRef.current ?? "",
      scrollToLine: (line: number) => {
        const view = cmViewRef.current;
        // Still loading the file: moved there once it is shown.
        if (!view) pendingLineRef.current = line;
        else goToLine(view, line);
      },
    }),
    [performSave, content],
  );

  // Mount the CodeMirror instance once the file content has loaded.
  useEffect(() => {
    if (content === null || !hostRef.current || cmViewRef.current) return;

    const langComp = new Compartment();
    const lintComp = new Compartment();
    languageCompartment.current = langComp;
    lintCompartment.current = lintComp;

    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        keymap.of([
          indentWithTab,
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              performSave();
              return true;
            },
          },
        ]),
        langComp.of([]),
        lintComp.of(buildLinter(basename(pathRef.current))),
        lintGutter(),
        syntaxHighlighting(cmHighlightStyle),
        indentUnit.of("  "),
        cmChromeTheme,
        // Toggles the gutter's opaque-background state (see cmChromeTheme)
        // based on horizontal scroll position.
        CMEditorView.domEventHandlers({
          scroll: (_event, view) => {
            view.dom.classList.toggle("cm-h-scrolled", view.scrollDOM.scrollLeft > 0);
          },
        }),
        CMEditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          // Length first: most edits change it, which settles "dirty" without
          // serializing the whole document on every keystroke.
          const doc = update.state.doc;
          const isDirty = doc.length !== originalRef.current.length || doc.toString() !== originalRef.current;
          if (isDirty === dirtyRef.current) return;
          dirtyRef.current = isDirty;
          setDirty(isDirty);
          onDirtyChangeRef.current?.(isDirty);
        }),
      ],
    });

    const view = new CMEditorView({ state, parent: hostRef.current });
    cmViewRef.current = view;
    if (pendingLineRef.current !== null) {
      goToLine(view, pendingLineRef.current);
      pendingLineRef.current = null;
    }
    const initiallyDirty = content !== originalRef.current;
    dirtyRef.current = initiallyDirty;
    setDirty(initiallyDirty);
    onDirtyChangeRef.current?.(initiallyDirty);

    return () => {
      view.destroy();
      cmViewRef.current = null;
    };
  }, [content, performSave]);

  // Renaming changes the language/lint config live, without touching the doc.
  useEffect(() => {
    const view = cmViewRef.current;
    const langComp = languageCompartment.current;
    const lintComp = lintCompartment.current;
    if (!view || !langComp || !lintComp) return;
    let active = true;
    view.dispatch({
      effects: [
        langComp.reconfigure([]),
        lintComp.reconfigure(buildLinter(basename(path))),
      ],
    });
    void languageFor(basename(path)).then((language) => {
      if (active && cmViewRef.current === view) view.dispatch({ effects: langComp.reconfigure(language ?? []) });
    }).catch(() => {});
    return () => { active = false; };
  }, [path, content]);

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming]);

  function startRename() {
    renameDoneRef.current = false;
    setRenameDraft(basename(path));
    setRenaming(true);
  }

  function cancelRename() {
    renameDoneRef.current = true;
    setRenaming(false);
  }

  async function commitRename() {
    if (renameDoneRef.current) return;
    renameDoneRef.current = true;
    const trimmed = renameDraft.trim();
    setRenaming(false);
    if (!trimmed || trimmed === basename(path)) return;
    // A rename waits for the current save. New saves cannot recreate the old
    // name while rename_entry is in flight.
    if (saveInFlightRef.current) await saveInFlightRef.current;
    if (pathRef.current !== path) return;
    renameInFlightRef.current = true;
    // Invalid names (separators, "..") are rejected by rename_entry itself.
    try {
      const entry = await invoke<{ name: string; path: string; is_dir: boolean }>("rename_entry", {
        path,
        newName: trimmed,
      });
      pathRef.current = entry.path;
      onRenamed?.(entry.path);
    } catch (e) {
      window.alert(t("files.error.rename", { error: String(e) }));
    } finally {
      renameInFlightRef.current = false;
    }
  }

  return (
    <div className="editor-view" style={{ display: hidden ? "none" : "flex" }}>
      <div className="editor-toolbar">
        <FileTypeIcon name={basename(path)} />
        {renaming ? (
          <input
            ref={renameInputRef}
            className="editor-name-input"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") cancelRename();
            }}
          />
        ) : (
          <span className="editor-name" title={path} onDoubleClick={startRename}>
            {basename(path)}
          </span>
        )}
        <span className="editor-status" title={saveError ?? undefined}>{saveError ? t("editor.error") : saving ? t("editor.saving") : dirty ? t("editor.modified") : t("editor.saved")}</span>
        <button type="button" className="editor-save-btn" disabled={!dirty || saving} onClick={performSave}>
          {t("editor.save")}
        </button>
      </div>
      {loadError ? (
        <div className="editor-error">{t("editor.openFailed", { error: loadError })}</div>
      ) : content === null ? (
        <div className="editor-loading">{t("common.loading")}</div>
      ) : (
        <div className="editor-host" ref={hostRef} />
      )}
    </div>
  );
});

EditorView.displayName = "EditorView";
