// Preparing and uploading a chat attachment: images are shrunk first (a phone
// photo is several MB), then the bytes go to the desktop over the link.
import { invoke } from "@tauri-apps/api/core";
import type { ChatAttachmentRef } from "../../shared/remote-types";

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
const MAX_SIDE = 2048;
const KEEP_BYTES = 1.5 * 1024 * 1024;
const SHRINKABLE = ["image/jpeg", "image/png", "image/webp"];

export interface Prepared {
  bytes: Uint8Array;
  name: string;
  mime: string;
}

function swapExt(name: string, ext: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name) + ext;
}

async function encode(bitmap: ImageBitmap, w: number, h: number, mime: string, quality?: number): Promise<Blob> {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
    return canvas.convertToBlob({ type: mime, quality });
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), mime, quality));
}

/** The file's bytes, shrunk when it is a big jpeg/png/webp; any failure falls back to the original. */
export async function prepareAttachment(file: File): Promise<Prepared> {
  const original = async (): Promise<Prepared> => ({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name, mime: file.type || "application/octet-stream" });
  if (!SHRINKABLE.includes(file.type)) return original();
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      if (scale === 1 && file.size <= KEEP_BYTES) return original();
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const png = file.type === "image/png";
      const want = png ? "image/png" : "image/jpeg";
      const blob = await encode(bitmap, w, h, want, png ? undefined : 0.85);
      if (blob.type !== want || (scale === 1 && blob.size >= file.size)) return original();
      return { bytes: new Uint8Array(await blob.arrayBuffer()), name: png ? file.name : swapExt(file.name, ".jpg"), mime: want };
    } finally {
      bitmap.close();
    }
  } catch {
    return original();
  }
}

/** Uploads one file to the desktop for `chatId`; rejects with an error string. */
export async function uploadAttachment(chatId: string, file: File): Promise<ChatAttachmentRef> {
  const { bytes, name, mime } = await prepareAttachment(file);
  const id = await invoke<string>("upload_chat_file", bytes, { headers: { "x-chat-id": chatId, "x-name": encodeURIComponent(name), "x-mime": mime } });
  return { id, name, mime };
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "FILE").slice(0, 4).toUpperCase();
}
