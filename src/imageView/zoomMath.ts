export type ImageTransform = { fit: boolean; scale: number; tx: number; ty: number };

/** Keep the complete image visible without enlarging small originals. */
export function fitScale(width: number, height: number, imageWidth: number, imageHeight: number): number {
  if (imageWidth <= 0 || imageHeight <= 0) return 1;
  return Math.max(0, Math.min(Math.max(0, width - 32) / imageWidth, Math.max(0, height - 32) / imageHeight, 1));
}

/** Preserve the image point beneath the cursor as its scale changes. */
export function zoomAt(transform: ImageTransform, scale: number, x = 0, y = 0): ImageTransform {
  const next = Math.max(0.05, Math.min(8, scale));
  const ratio = next / (transform.scale || 1);
  return { fit: false, scale: next, tx: x - (x - transform.tx) * ratio, ty: y - (y - transform.ty) * ratio };
}
