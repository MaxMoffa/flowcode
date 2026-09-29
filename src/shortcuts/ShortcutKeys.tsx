import { comboKeys } from "./shortcuts";
import "./shortcuts.css";

/** A combo drawn as keycaps ("Ctrl" "Shift" "T"). Nothing when unassigned,
 * so the caller decides what to show instead. */
export function ShortcutKeys({ combo }: { combo: string | undefined }) {
  const keys = comboKeys(combo);
  if (keys.length === 0) return null;
  return (
    <span className="shortcut-keys">
      {keys.map((k, i) => (
        <kbd key={i} className="shortcut-key">
          {k}
        </kbd>
      ))}
    </span>
  );
}
