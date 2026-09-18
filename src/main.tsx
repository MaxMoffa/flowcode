import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
