import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { InstallerFlow } from "./installer/InstallerFlow";
import "./themes/themes.css";

// WebKitGTK (Tauri's WebView on Linux) accepts the `backdrop-filter` CSS
// property but never actually renders it, on any GPU/compositing mode -
// unlike WKWebView (macOS) and WebView2 (Windows), which do. Without this,
// low-alpha "glass" panels are see-through with no blur, i.e. unreadable.
// So: real glass (low alpha + blur) where the engine supports it, an opaque
// fallback where it doesn't.
function detectPlatform(): "linux" | "macos" | "windows" | "other" {
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) return "windows";
  if (ua.includes("Macintosh") || ua.includes("Mac OS")) return "macos";
  if (ua.includes("Linux")) return "linux";
  return "other";
}
document.documentElement.dataset.platform = detectPlatform();

// A separate root, not a route inside <App/>: the installer boots before
// Flowcode itself is set up, so it must never mount the main shell's own
// state (terminal tabs, settings, plugins...) even transiently. Standalone
// today (open with `#installer` in the URL); the intended long-term shape is
// its own small executable pointed straight at this same built frontend
// with that hash baked into its window URL, sharing this bundle and the
// Tauri commands it calls instead of a second frontend to maintain.
const isInstaller = window.location.hash === "#installer";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isInstaller ? <InstallerFlow /> : <App />}</React.StrictMode>,
);
