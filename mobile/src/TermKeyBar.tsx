import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { lockFeedback } from "./haptics";
import { t } from "./i18n";
import { TermCursorPad } from "./TermCursorPad";
import type { Active, ModKey, Mods, NamedKey } from "./termModifiers";

const LONG_PRESS_MS = 420;

type Item =
  | { kind: "key"; key: NamedKey; label: string; aria?: string }
  | { kind: "mod"; key: ModKey; label: string }
  | { kind: "text"; text: string }
  | { kind: "sep" };

const ITEMS: Item[] = [
  { kind: "key", key: "esc", label: "esc" },
  { kind: "key", key: "tab", label: "tab" },
  { kind: "mod", key: "ctrl", label: "ctrl" },
  { kind: "mod", key: "alt", label: "alt" },
  { kind: "sep" },
  { kind: "key", key: "left", label: "←", aria: "keyLeft" },
  { kind: "key", key: "up", label: "↑", aria: "keyUp" },
  { kind: "key", key: "down", label: "↓", aria: "keyDown" },
  { kind: "key", key: "right", label: "→", aria: "keyRight" },
  { kind: "sep" },
  { kind: "text", text: "~" },
  { kind: "text", text: "/" },
  { kind: "text", text: "|" },
  { kind: "text", text: "-" },
];

/** Keeps the keyboard open (and xterm focused) while a bar button is tapped. */
const keepFocus = {
  onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
  onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
};

/** Modifier button: tap arms for one key, long-press locks until tapped again. */
function ModButton({ label, state, onTap, onLock }: { label: string; state: Mods[ModKey]; onTap: () => void; onLock: () => void }) {
  const timer = useRef(0);
  const fired = useRef(false);
  const cancel = () => window.clearTimeout(timer.current);
  useEffect(() => cancel, []);
  return (
    <button
      type="button"
      className={"tm-k tm-mod" + (state !== "off" ? " on" : "") + (state === "lock" ? " locked" : "")}
      aria-pressed={state !== "off"}
      onPointerDown={(e) => {
        e.preventDefault();
        fired.current = false;
        cancel();
        timer.current = window.setTimeout(() => {
          fired.current = true;
          lockFeedback();
          onLock();
        }, LONG_PRESS_MS);
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onMouseDown={keepFocus.onMouseDown}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (fired.current) fired.current = false;
        else onTap();
      }}
    >
      {label}
      {state === "lock" && <i className="tm-lock-dot" />}
    </button>
  );
}

/**
 * The keyboard-open key row plus the cursor swipe strip. Renders nothing (but
 * keeps its wrapper, which `useKeybarHeight` measures) while the keyboard is closed.
 */
export function TermKeyBar(props: {
  barRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  mods: Mods;
  onTap: (k: ModKey) => void;
  onLock: (k: ModKey) => void;
  onKey: (k: NamedKey) => void;
  onText: (s: string) => void;
  peek: () => Active;
  onPadKey: (k: NamedKey, mods: Active) => void;
  onPadDone: () => void;
  /** Keys pinned at the end of the row (the wide layout's interrupt and keyboard buttons). */
  trailing?: ReactNode;
}) {
  const { mods, onTap, onLock, onKey, onText, trailing } = props;
  const row = (
    <div className="tm-row" role="toolbar" aria-label={t("termKeys")}>
      {ITEMS.map((it, i) => {
        if (it.kind === "sep") return <i key={i} className="tm-sep" />;
        if (it.kind === "mod") return <ModButton key={it.key} label={it.label} state={mods[it.key]} onTap={() => onTap(it.key)} onLock={() => onLock(it.key)} />;
        if (it.kind === "text")
          return (
            <button key={it.text} type="button" {...keepFocus} className="tm-k" onClick={() => onText(it.text)}>
              {it.text}
            </button>
          );
        return (
          <button key={it.key} type="button" {...keepFocus} className="tm-k" aria-label={it.aria ? t(it.aria as "keyUp") : undefined} onClick={() => onKey(it.key)}>
            {it.label}
          </button>
        );
      })}
    </div>
  );
  return (
    <div className="tm-keys" ref={props.barRef}>
      {props.open && (
        <>
          {trailing ? (
            <div className="tm-line">
              {row}
              {trailing}
            </div>
          ) : (
            row
          )}
          <TermCursorPad peek={props.peek} onKey={props.onPadKey} onDone={props.onPadDone} />
        </>
      )}
    </div>
  );
}
