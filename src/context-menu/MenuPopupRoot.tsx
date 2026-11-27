// The page of the context menu popup window (src-tauri/src/menu_popup.rs): a
// transparent, borderless window that draws one menu with the same markup and
// CSS as the DOM menu, so it can sit above a native browser view.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { PopupItem, PopupShow, PopupTheme } from "./menuPopupClient";
import "./context-menu.css";
import "./menu-popup.css";

/** Room around the menu for its box-shadow (CSS px); the Rust side sizes the window with it. */
const PAD = 16;
const ROOT_CLASS = "menu-popup-root";

function applyTheme(theme: PopupTheme) {
  const root = document.documentElement;
  for (const a of Array.from(root.attributes)) root.removeAttribute(a.name);
  for (const [k, v] of Object.entries(theme.htmlAttrs)) root.setAttribute(k, v);
  root.classList.add(ROOT_CLASS);
  document.body.className = theme.bodyClass;
}

interface Shown {
  show: PopupShow;
  /** False while it is laid out invisibly to measure it, before the window is placed. */
  placed: boolean;
}

export function MenuPopupRoot() {
  const win = getCurrentWebviewWindow();
  const owner = win.label.replace(/^menu-popup-/, "");
  const [shown, setShown] = useState<Shown | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.classList.add(ROOT_CLASS);
  }, []);

  /** `report`: tell the owner (false when the owner asked for the close or a row was picked).
   * `refocus`: the owner takes the focus back (Escape); not after a blur, where the
   * user clicked somewhere else - maybe another app, which must keep it. */
  const close = useCallback(
    async (report: boolean, refocus = false) => {
      const id = idRef.current;
      if (id === null) return;
      idRef.current = null;
      if (report) void emitTo(owner, "menu-popup:closed", { id, refocus }).catch(() => {});
      // Emptied and painted before hiding, so the next show doesn't flash this menu.
      setShown(null);
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      await invoke("menu_popup_hide").catch(() => {});
    },
    [owner],
  );

  useEffect(() => {
    const offs: Promise<() => void>[] = [
      win.listen<PopupShow>("menu-popup:show", (e) => {
        applyTheme(e.payload.theme);
        idRef.current = e.payload.id;
        setShown({ show: e.payload, placed: false });
      }),
      win.listen<{ id?: number }>("menu-popup:hide", (e) => {
        if (e.payload?.id === undefined || e.payload.id === idRef.current) void close(false);
      }),
      win.listen("menu-popup:ping", () => void emitTo(owner, "menu-popup:ready").catch(() => {})),
    ];
    void emitTo(owner, "menu-popup:ready").catch(() => {});
    return () => offs.forEach((p) => void p.then((off) => off()));
  }, [win, owner, close]);

  // Measure the menu while invisible, place the window around it, then reveal it.
  useLayoutEffect(() => {
    if (!shown || shown.placed) return;
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const id = shown.show.id;
    invoke("menu_popup_open", { x: shown.show.x, y: shown.show.y, width, height, pad: PAD })
      .then(() => setShown((s) => (s && s.show.id === id ? { ...s, placed: true } : s)))
      .catch(() => void close(true));
  }, [shown, close]);

  // Clicking elsewhere takes the focus away from the popup.
  useEffect(() => {
    const onBlur = () => void close(true);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [close]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void close(true, true);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const list = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(".context-menu-item:not(:disabled)") ?? []);
      const at = list.indexOf(document.activeElement as HTMLElement);
      list[e.key === "ArrowDown" ? Math.min(at + 1, list.length - 1) : at - 1]?.focus();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [close]);

  // Same default as the app: the browser's own menu never shows.
  useEffect(() => {
    const off = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", off);
    return () => document.removeEventListener("contextmenu", off);
  }, []);

  if (!shown) return null;
  const { show, placed } = shown;
  const pick = (index: number) => {
    void emitTo(owner, "menu-popup:select", { id: show.id, index }).catch(() => {});
    void close(false);
  };

  return (
    <div className="menu-popup-wrap" style={{ padding: PAD }}>
      <div
        // Re-keyed once placed so the entrance animation plays when it becomes visible.
        key={placed ? "placed" : "measuring"}
        className="context-menu"
        ref={menuRef}
        role="menu"
        style={placed ? undefined : { visibility: "hidden", animation: "none" }}
        onMouseDown={(e) => e.preventDefault()}
      >
        {show.items.map((item, i) => renderItem(item, i, pick))}
      </div>
    </div>
  );
}

function renderItem(item: PopupItem, i: number, pick: (index: number) => void) {
  if (item.separator) return <div className="context-menu-separator" key={`sep-${i}`} />;
  return (
    <button
      key={item.label}
      type="button"
      role="menuitem"
      className={"context-menu-item" + (item.danger ? " is-danger" : "")}
      disabled={item.disabled}
      onClick={() => pick(i)}
    >
      {item.iconHtml && <span className="context-menu-icon" dangerouslySetInnerHTML={{ __html: item.iconHtml }} />}
      <span className="context-menu-label">{item.label}</span>
      {item.checked && (
        <svg className="context-menu-check" viewBox="0 0 24 24" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill="none">
          <polyline points="5 12.5 10 17.5 19 7" />
        </svg>
      )}
    </button>
  );
}
