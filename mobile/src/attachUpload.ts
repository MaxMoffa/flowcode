// Uploading a chat attachment: images are shrunk first (shared/attachPrepare),
// then the bytes go to the desktop over the link.
import { invoke } from "@tauri-apps/api/core";
import { formatBytes } from "../../shared/format";
import { prepareAttachment, toBase64 } from "../../shared/attachPrepare";
import type { ChatAttachmentRef } from "../../shared/remote-types";

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACH_BYTES = 16 * 1024 * 1024;

/** Uploads one file to the desktop for `chatId`; rejects with an error string. */
export async function uploadAttachment(chatId: string, file: File): Promise<ChatAttachmentRef> {
  const { bytes, name, mime } = await prepareAttachment(file);
  // As base64 in JSON: Android's IPC can't carry a raw body (it would arrive as
  // a JSON array of numbers, which the command refused).
  const id = await invoke<string>("upload_chat_file", { data: await toBase64(bytes) }, { headers: { "x-chat-id": chatId, "x-name": encodeURIComponent(name), "x-mime": mime } });
  return { id, name, mime };
}

export { formatBytes as formatSize };

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "FILE").slice(0, 4).toUpperCase();
}
