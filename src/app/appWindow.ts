import { getCurrentWindow } from "@tauri-apps/api/window";

export const appWindow = getCurrentWindow();
/** The window Flowcode starts with - the one that restores the saved session
 * and checks for updates. Every other window was opened from it (a tab
 * dragged out, or a restored extra window). */
export const isMainWindow = appWindow.label === "main";
