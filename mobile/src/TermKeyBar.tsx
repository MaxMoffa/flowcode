import { lockFeedback } from "./haptics";
import { useRef, type ReactNode, type RefObject } from "react";
import { t } from "./i18n";
import type { ModKey, Mods, NamedKey } from "./termModifiers";
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, KeyboardIcon } from "./termIcons";

const LONG_PRESS_MS = 420;

const MOD_KEYS: { key: ModKey; label: string }[] = [
  { key: "ctrl", label: "Ctrl" },
  { key: "alt", label: "Alt" },
  { key: "shift", label: "⇧" },
];
const NAMED_KEYS: { key: NamedKey; label: string }[] = [
  { key: "esc", label: "Esc" },
  { key: "tab", label: "Tab" },
];
/** The cross: grid areas, up over down between left and right. */
const ARROWS: { key: NamedKey; area: string; label: string; icon: ReactNode }[] = [
  { key: "up", area: "u", label: "keyUp", icon: <ArrowUpIcon /> },
  { key: "left", area: "l", label: "keyLeft", icon: <ArrowLeftIcon /> },
  { key: "down", area: "d", label: "keyDown", icon: <ArrowDownIcon /> },
  { key: "right", area: "r", label: "keyRight", icon: <ArrowRightIcon /> },
];
/**
 * Control chips: sent as-is, deliberately NOT affected by armed modifiers
 * (^C with Alt armed would be a different key than the one labelled).
 */
const CTRL_CHIPS = [
  { label: "^C", seq: "\x03", danger: true },
  { label: "^D", seq: "\x04" },
  { label: "^L", seq: "\x0c" },
  { label: "^R", seq: "\x12" },
];
const SYMBOLS = ["|", "~", "/", "-", "_", ">", "&&", "$", "*", "`", "'", '"'];

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
  return (
    <button
      type="button"
      className={"tm-key tm-mod" + (state !== "off" ? " on" : "") + (state === "lock" ? " locked" : "")}
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

export function TermKeyBar(props: {
  barRef: RefObject<HTMLDivElement | null>;
  mods: Mods;
  onTap: (k: ModKey) => void;
  onLock: (k: ModKey) => void;
  onKey: (k: NamedKey) => void;
  onText: (s: string) => void;
  onRaw: (seq: string) => void;
  kbOpen: boolean;
  onToggleKeyboard: () => void;
}) {
  const { mods, onTap, onLock, onKey, onText, onRaw } = props;
  return (
    <div className="tm-keys" ref={props.barRef}>
      <div className="tm-row">
        {MOD_KEYS.map((m) => (
          <ModButton key={m.key} label={m.label} state={mods[m.key]} onTap={() => onTap(m.key)} onLock={() => onLock(m.key)} />
        ))}
        {NAMED_KEYS.map((k) => (
          <button key={k.key} type="button" {...keepFocus} className="tm-key" onClick={() => onKey(k.key)}>
            {k.label}
          </button>
        ))}
      </div>
      <div className="tm-row2">
        <div className="tm-chips">
          {CTRL_CHIPS.map((c) => (
            <button key={c.label} type="button" {...keepFocus} className={"tm-chip" + (c.danger ? " danger" : "")} onClick={() => onRaw(c.seq)}>
              {c.label}
            </button>
          ))}
          <i className="tm-divider" />
          {SYMBOLS.map((s) => (
            <button key={s} type="button" {...keepFocus} className="tm-chip" onClick={() => onText(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>
      <div className="tm-side">
        <div className="tm-arrows" role="group">
          {ARROWS.map((a) => (
            <button key={a.key} type="button" {...keepFocus} style={{ gridArea: a.area }} aria-label={t(a.label as "keyUp")} onClick={() => onKey(a.key)}>
              {a.icon}
            </button>
          ))}
        </div>
        <button type="button" {...keepFocus} className="tm-key tm-kbd" aria-label={props.kbOpen ? t("hideKeyboard") : t("showKeyboard")} onClick={props.onToggleKeyboard}>
          <KeyboardIcon />
        </button>
      </div>
    </div>
  );
}
