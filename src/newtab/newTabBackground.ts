import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

/** The longest side of the stored picture, in px - a screen's worth. */
const MAX_SIDE = 1920;
const JPEG_QUALITY = 0.85;
/** What the backend takes (newtab_background.rs). */
const MAX_BYTES = 2 * 1024 * 1024;

const listeners = new Set<() => void>();
/** The stored picture as a data: URL; undefined until it was asked for. */
let image: string | null | undefined;

function change(next: string | null) {
  image = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (image === undefined) {
    image = null;
    void invoke<string | null>("newtab_background_get")
      .then(change)
      .catch(() => {});
  }
  return () => {
    listeners.delete(listener);
  };
}

/** The user's own backdrop picture, null while there is none. */
export function useNewTabBackgroundImage(): string | null {
  return useSyncExternalStore(subscribe, () => image ?? null);
}

/** `file` scaled down to fit `MAX_SIDE` and encoded as a JPEG, as base64. */
async function downscale(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const url = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  return url.slice(url.indexOf(",") + 1);
}

/** Stores `file` as the backdrop picture. Rejects when it can't be read as an
 * image or is still too big once scaled. */
export async function setNewTabBackgroundImage(file: File) {
  const data = await downscale(file);
  // base64 is 4 bytes for every 3.
  if (data.length * 0.75 > MAX_BYTES) throw new Error("too large");
  await invoke("newtab_background_set", { dataBase64: data });
  change(`data:image/jpeg;base64,${data}`);
}

export async function clearNewTabBackgroundImage() {
  await invoke("newtab_background_clear");
  change(null);
}
