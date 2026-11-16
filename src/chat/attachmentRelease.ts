import { invoke } from "@tauri-apps/api/core";
import type { ChatAttachment } from "./chatTypes";

/** Frees the object URL behind an attachment's tile (the staged file stays). */
export function releasePreview(a: ChatAttachment): void {
  if (a.preview) URL.revokeObjectURL(a.preview);
}

/** Drops an attachment nobody will send: its preview, and the file staged in the backend. */
export function discardAttachment(a: ChatAttachment): void {
  releasePreview(a);
  if (a.upload) invoke("chat_unstage_attachment", { upload: a.upload }).catch(() => {});
}
