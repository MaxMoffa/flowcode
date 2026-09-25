import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import "./themes/themes.css";
import { I18nProvider } from "./i18n";

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
// state (terminal tabs, settings, plugins...) even transiently. Also opened
// this way from the actual `flowcode-installer.exe` binary (see
// src-tauri/installer/), whose own tauri.conf.json points its window straight
// at this hash - one frontend bundle, two different Tauri backends behind it.
const isInstaller = window.location.hash === "#installer";
// Each entry point is its own chunk, so neither binary loads the other's code.
const Root = isInstaller
  ? lazy(() => import("./installer/InstallerFlow").then((m) => ({ default: m.InstallerFlow })))
  : lazy(() => import("./App"));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <Suspense fallback={null}>
        <Root />
      </Suspense>
    </I18nProvider>
  </React.StrictMode>,
);
