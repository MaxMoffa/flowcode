import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./ui.css";

async function boot() {
  // Dev-only browser mock; dead code in production builds.
  if (import.meta.env.DEV && location.search.includes("mock")) await import("./devMock");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
