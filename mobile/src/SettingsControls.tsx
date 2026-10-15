import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { t } from "./i18n";
import type { MirroredSettings } from "./remote";

type Palette = MirroredSettings["palettes"][number];

/* Building blocks of the settings pages. */

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="group">{title}</h2>
      <div className="card set-card">{children}</div>
    </section>
  );
}

export function Toggle({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="set-row">
      <span className="set-label">
        {label}
        {hint && <small className="set-hint">{hint}</small>}
      </span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className={"switch" + (on ? " on" : "")} onClick={() => onChange(!on)}>
        <i />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; name: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="set-block">
      <span className="set-label">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export function PaletteGrid({ label, palettes, value, onChange }: { label: string; palettes: Palette[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="set-block">
      <span className="set-label">{label}</span>
      <div className="palettes" role="radiogroup" aria-label={label}>
        {palettes.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={value === p.id} className={"palette" + (value === p.id ? " on" : "")} onClick={() => onChange(p.id)}>
            <span className="swatch" style={{ background: p.bg }}>
              <i style={{ background: p.accent }} />
              <i style={{ background: p.accent2 }} />
            </span>
            <span className="palette-name">{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Follows the dragged value locally and only tells the desktop once the finger lifts. */
export function Slider({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(value);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setV(value);
  }, [value]);
  const commit = (el: HTMLInputElement) => {
    dragging.current = false;
    onCommit(Number(el.value));
  };
  return (
    <div className="set-block">
      <div className="set-head">
        <span className="set-label">{label}</span>
        <span className="set-value">{Math.round(v * 100)}%</span>
      </div>
      <input
        type="range"
        className="range"
        min={0}
        max={1}
        step={0.01}
        value={v}
        aria-label={label}
        style={{ "--fill": `${v * 100}%` } as CSSProperties}
        onPointerDown={() => (dragging.current = true)}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={(e) => commit(e.currentTarget)}
        onPointerCancel={(e) => commit(e.currentTarget)}
        onBlur={(e) => dragging.current && commit(e.currentTarget)}
        onKeyUp={(e) => commit(e.currentTarget)}
      />
    </div>
  );
}

export function Stepper({ label, hint, value, min, max, onChange }: { label: string; hint?: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="set-row">
      <span className="set-label">
        {label}
        {hint && <small className="set-hint">{hint}</small>}
      </span>
      <div className="stepper">
        <button type="button" aria-label={t("decrease")} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
          −
        </button>
        <b>{value}</b>
        <button type="button" aria-label={t("increase")} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
          +
        </button>
      </div>
    </div>
  );
}

export function MessageField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setV(value);
  }, [value]);
  return (
    <label className="set-block">
      <span className="set-label">{t("autoResumeMessage")}</span>
      <input
        className="set-input"
        value={v}
        placeholder={t("autoResumePlaceholder")}
        enterKeyHint="done"
        onFocus={() => (focused.current = true)}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          focused.current = false;
          if (v !== value) onCommit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}
