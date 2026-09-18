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
import "./editor.css";

export interface EditorHandle {
  isDirty: () => boolean;
  save: () => void;
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
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

export const EditorView = forwardRef<EditorHandle, EditorViewProps>(({ path, hidden, onDirtyChange, onRenamed }, ref) => {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");

  const hostRef = useRef<HTMLDivElement>(null);
  const cmViewRef = useRef<CMEditorView | null>(null);
  const languageCompartment = useRef<Compartment | null>(null);
  const lintCompartment = useRef<Compartment | null>(null);
  const originalRef = useRef("");
  const pathRef = useRef(path);
  const dirtyRef = useRef(false);
  const initialPathRef = useRef(path);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  pathRef.current = path;

  useEffect(() => {
    invoke<string>("read_text_file", { path: initialPathRef.current })
      .then((text) => {
        originalRef.current = text;
        setContent(text);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const performSave = useCallback(async () => {
    const view = cmViewRef.current;
    if (!view) return;
    const text = view.state.doc.toString();
    if (text === originalRef.current) return;
    setSaving(true);
    try {
      await invoke("write_text_file", { path: pathRef.current, contents: text });
      originalRef.current = text;
      setDirty(false);
      dirtyRef.current = false;
      onDirtyChangeRef.current?.(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      isDirty: () => dirtyRef.current,
      save: performSave,
      getContent: () => cmViewRef.current?.state.doc.toString() ?? content ?? "",
      scrollToLine: (line: number) => {
        const view = cmViewRef.current;
        if (!view) return;
        const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
        const pos = view.state.doc.line(clamped).from;
        view.dispatch({
          selection: { anchor: pos },
          effects: CMEditorView.scrollIntoView(pos, { y: "center" }),
        });
        view.focus();
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
        langComp.of(languageFor(pathRef.current) ?? []),
        lintComp.of(buildLinter(pathRef.current)),
        lintGutter(),
        syntaxHighlighting(cmHighlightStyle),
        indentUnit.of("  "),
        cmChromeTheme,
        CMEditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const isDirty = update.state.doc.toString() !== originalRef.current;
          dirtyRef.current = isDirty;
          setDirty(isDirty);
          onDirtyChangeRef.current?.(isDirty);
        }),
      ],
    });

    const view = new CMEditorView({ state, parent: hostRef.current });
    cmViewRef.current = view;

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
    view.dispatch({
      effects: [langComp.reconfigure(languageFor(path) ?? []), lintComp.reconfigure(buildLinter(path))],
    });
  }, [path]);

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming]);

  function startRename() {
    setRenameDraft(basename(path));
    setRenaming(true);
  }

  async function commitRename() {
    const trimmed = renameDraft.trim();
    setRenaming(false);
    if (!trimmed || trimmed === basename(path)) return;
    if (trimmed.includes("/")) {
      window.alert('Il nome non può contenere "/"');
      return;
    }
    try {
      const entry = await invoke<{ name: string; path: string; is_dir: boolean }>("rename_entry", {
        path,
        newName: trimmed,
      });
      onRenamed?.(entry.path);
    } catch (e) {
      window.alert(`Impossibile rinominare: ${e}`);
    }
  }

  return (
    <div className="editor-view" style={{ display: hidden ? "none" : "flex" }}>
      <div className="editor-toolbar">
        <FileTypeIcon name={path} />
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
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <span className="editor-name" title={path} onDoubleClick={startRename}>
            {basename(path)}
          </span>
        )}
        <span className="editor-status">{error ? "Errore" : saving ? "Salvataggio…" : dirty ? "Modificato" : "Salvato"}</span>
        <button type="button" className="editor-save-btn" disabled={!dirty || saving} onClick={performSave}>
          Salva
        </button>
      </div>
      {error ? (
        <div className="editor-error">Impossibile aprire il file: {error}</div>
      ) : content === null ? (
        <div className="editor-loading">Caricamento…</div>
      ) : (
        <div className="editor-host" ref={hostRef} />
      )}
    </div>
  );
});

EditorView.displayName = "EditorView";
