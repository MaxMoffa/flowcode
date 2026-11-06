/** Use the reading layout in a short window or a narrow tablet split, not on a portrait phone. */
export function compactChatViewport(width: number, height: number, screenWidth: number, screenHeight: number): boolean {
  return height <= 540 || height < screenHeight * 0.8 || (width < 760 && Math.min(screenWidth, screenHeight) >= 600);
}
