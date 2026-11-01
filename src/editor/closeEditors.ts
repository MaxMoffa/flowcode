import type { EditorHandle } from "./EditorView";

export interface ClosingEditor {
  id: string;
  label: string;
  handle: Pick<EditorHandle, "isDirty" | "save" | "getContent">;
}

/** Resolve each dirty buffer, then validate again immediately before destroying the window. */
export async function prepareEditorClose(
  editors: () => ClosingEditor[],
  choose: (editor: ClosingEditor) => Promise<"save" | "discard" | "cancel">,
): Promise<(() => boolean) | null> {
  const discarded = new Map<string, string>();
  for (const editor of editors()) {
    if (!editor.handle.isDirty()) continue;
    const content = editor.handle.getContent();
    const decision = await choose(editor);
    if (decision === "cancel") return null;
    if (decision === "save") {
      if (!(await editor.handle.save()) || editor.handle.isDirty()) return null;
    } else {
      // The decision concerns the text the user saw when the dialog opened.
      if (editor.handle.getContent() !== content) return null;
      discarded.set(editor.id, content);
    }
  }
  return () => editors().every((e) => !e.handle.isDirty() || discarded.get(e.id) === e.handle.getContent());
}
