import { useCallback, useRef, useState } from "react";

export type ModKey = "ctrl" | "alt" | "shift";
/** once = disarms after the next key; lock = stays armed until tapped again. */
export type ModState = "off" | "once" | "lock";
export type Mods = Record<ModKey, ModState>;
export const NO_MODS: Mods = { ctrl: "off", alt: "off", shift: "off" };

export type Active = { ctrl: boolean; alt: boolean; shift: boolean };

/** Armed modifiers: tap arms for one key, long-press locks. */
export function useModifiers() {
  const [mods, setState] = useState<Mods>(NO_MODS);
  const ref = useRef<Mods>(NO_MODS);
  const set = (m: Mods) => {
    ref.current = m;
    setState(m);
  };
  /** Tap: off -> once; once or lock -> off. */
  const tap = useCallback((k: ModKey) => set({ ...ref.current, [k]: ref.current[k] === "off" ? "once" : "off" }), []);
  const lock = useCallback((k: ModKey) => set({ ...ref.current, [k]: "lock" }), []);
  /** What is armed right now; disarms the one-shot ones. */
  const consume = useCallback((): Active => {
    const m = ref.current;
    const active = { ctrl: m.ctrl !== "off", alt: m.alt !== "off", shift: m.shift !== "off" };
    if (m.ctrl === "once" || m.alt === "once" || m.shift === "once") {
      set({ ctrl: m.ctrl === "once" ? "off" : m.ctrl, alt: m.alt === "once" ? "off" : m.alt, shift: m.shift === "once" ? "off" : m.shift });
    }
    return active;
  }, []);
  /** What is armed right now, without disarming anything. */
  const peek = useCallback((): Active => {
    const m = ref.current;
    return { ctrl: m.ctrl !== "off", alt: m.alt !== "off", shift: m.shift !== "off" };
  }, []);
  return { mods, tap, lock, consume, peek };
}

export type NamedKey = "up" | "down" | "right" | "left" | "tab" | "esc";

const ARROW_FINAL: Record<string, string> = { up: "A", down: "B", right: "C", left: "D" };

/**
 * Escape sequence of a non-text key with the armed modifiers (xterm's 1+bits scheme:
 * shift 1, alt 2, ctrl 4). Arrows are `ESC O x` in application-cursor mode.
 *
 *   up                    -> ESC [ A        (app cursor: ESC O A)
 *   ctrl+up               -> ESC [ 1 ; 5 A
 *   shift+tab             -> ESC [ Z
 *   alt+esc               -> ESC ESC
 */
export function encodeKey(key: NamedKey, a: Active, appCursor: boolean): string {
  const bits = (a.shift ? 1 : 0) + (a.alt ? 2 : 0) + (a.ctrl ? 4 : 0);
  if (key === "tab") return a.shift ? "\x1b[Z" : a.alt ? "\x1b\t" : "\t";
  if (key === "esc") return a.alt ? "\x1b\x1b" : "\x1b";
  const f = ARROW_FINAL[key];
  if (bits) return `\x1b[1;${bits + 1}${f}`;
  return (appCursor ? "\x1bO" : "\x1b[") + f;
}

/** Applies armed modifiers to typed text (one character) or a key-bar symbol. */
export function encodeText(data: string, a: Active): string {
  if (a.ctrl || a.alt || a.shift) {
    if (data.length === 1) {
      if (a.shift && /[a-z]/.test(data)) data = data.toUpperCase();
      if (a.ctrl && /[a-zA-Z@[\\\]^_]/.test(data)) data = String.fromCharCode(data.charCodeAt(0) & 0x1f);
      else if (a.ctrl && data === " ") data = "\x00";
    }
    if (a.alt) data = "\x1b" + data;
  }
  return data;
}
