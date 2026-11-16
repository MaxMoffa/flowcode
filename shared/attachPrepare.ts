// Shrinking a chat attachment before it is sent: a phone photo is several MB,
// more than an agent needs (and past what some providers accept). Shared by the
// desktop composer and the phone.

const MAX_SIDE = 2048;
const KEEP_BYTES = 1.5 * 1024 * 1024;
const SHRINKABLE = ["image/jpeg", "image/png", "image/webp"];

export interface Prepared {
  bytes: Uint8Array<ArrayBuffer>;
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


/** The bytes as base64 (no `data:` prefix), encoded natively by the webview. */
export function toBase64(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read"));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(new Blob([bytes]));
  });
}
