import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { t } from "./i18n";
import { setSetting, unpair, type MirroredSettings } from "./remote";

type Palette = MirroredSettings["palettes"][number];

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="group">{title}</h2>
      <div className="card set-card">{children}</div>
    </section>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="set-row">
      <span className="set-label">{label}</span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className={"switch" + (on ? " on" : "")} onClick={() => onChange(!on)}>
        <i />
      </button>
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; name: string }[]; onChange: (v: T) => void }) {
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

function PaletteGrid({ label, palettes, value, onChange }: { label: string; palettes: Palette[]; value: string; onChange: (id: string) => void }) {
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
function Slider({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
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
        onTouchEnd={(e) => commit(e.currentTarget)}
        onKeyUp={(e) => commit(e.currentTarget)}
      />
    </div>
  );
}

function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="set-row">
      <span className="set-label">{label}</span>
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

function MessageField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
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

export function SettingsScreen({ hostName, settings: s }: { hostName?: string; settings: MirroredSettings | null }) {
  return (
    <>
      <header className="top">
        <h1>{t("settings")}</h1>
      </header>
      <div className="mirror">
        <b>{t("mirrorOf", { host: hostName ?? "..." })}</b>
        <span>{t("mirrorHint")}</span>
      </div>
      {!s && <div className="empty">{t("noSettings")}</div>}
      {s && (
        <>
          <Group title={t("appearance")}>
            <Segmented
              label={t("theme")}
              value={s.theme}
              options={[
                { id: "auto", name: t("themeAuto") },
                { id: "light", name: t("themeLight") },
                { id: "dark", name: t("themeDark") },
              ]}
              onChange={(v) => setSetting("theme", v)}
            />
            <PaletteGrid label={t("palette")} palettes={s.palettes} value={s.palette} onChange={(id) => setSetting("palette", id)} />
            <Toggle label={t("separateTerminalPalette")} on={s.terminalPalette !== null} onChange={(on) => setSetting("terminalPalette", on ? s.palette : null)} />
            {s.terminalPalette !== null && (
              <PaletteGrid label={t("terminalPalette")} palettes={s.palettes} value={s.terminalPalette} onChange={(id) => setSetting("terminalPalette", id)} />
            )}
            <Slider label={t("contrast")} value={s.contrast} onCommit={(v) => setSetting("contrast", v)} />
            <Slider label={t("glassOpacity")} value={s.glassOpacity} onCommit={(v) => setSetting("glassOpacity", v)} />
          </Group>

          <Group title={t("language")}>
            <Segmented
              label={t("language")}
              value={s.language}
              options={[{ id: "system", name: t("langSystem") }, ...s.languages]}
              onChange={(v) => setSetting("language", v)}
            />
          </Group>

          <Group title={t("terminalGroup")}>
            <Stepper label={t("fontSize")} value={s.terminalFontSize} min={9} max={28} onChange={(v) => setSetting("terminalFontSize", v)} />
            <Toggle label={t("banner")} on={s.bannerEnabled} onChange={(v) => setSetting("bannerEnabled", v)} />
            <Toggle label={t("confirmLinks")} on={s.confirmLinkOpen} onChange={(v) => setSetting("confirmLinkOpen", v)} />
            <Toggle label={t("newTabPage")} on={s.newTabPage} onChange={(v) => setSetting("newTabPage", v)} />
            <Toggle label={t("restoreSession")} on={s.restoreSession} onChange={(v) => setSetting("restoreSession", v)} />
          </Group>

          <Group title={t("agentsGroup")}>
            <Toggle label={t("notifyDone")} on={s.notify.done} onChange={(v) => setSetting("notify.done", v)} />
            <Toggle label={t("notifyInput")} on={s.notify.input} onChange={(v) => setSetting("notify.input", v)} />
            <Toggle label={t("notifyLimit")} on={s.notify.limitReset} onChange={(v) => setSetting("notify.limitReset", v)} />
            <Toggle label={t("notifyExited")} on={s.notify.exited} onChange={(v) => setSetting("notify.exited", v)} />
            <Toggle label={t("autoResume")} on={s.autoResume.enabled} onChange={(v) => setSetting("autoResume.enabled", v)} />
            <MessageField value={s.autoResume.message} onCommit={(v) => setSetting("autoResume.message", v)} />
          </Group>
        </>
      )}

      <Group title={t("thisPhone")}>
        <button
          type="button"
          className="set-row danger"
          onClick={() => {
            if (window.confirm(t("unpairConfirm"))) void unpair();
          }}
        >
          <span className="set-label">{t("unpairFromComputer")}</span>
        </button>
      </Group>
    </>
  );
}
