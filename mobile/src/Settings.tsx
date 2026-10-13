import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import "./settings.css";
import { useBackHandler } from "./back";
import { t } from "./i18n";
import { setLockEnabled, useLock, verify } from "./applock";
import { effectivePhone, phoneTheme, setPhoneTheme } from "./theme";
import { connectionLog, setSetting, unpair, type MirroredSettings, type ProfileInfo } from "./remote";
import { ProfilesPage } from "./ProfilesSettings";

type Palette = MirroredSettings["palettes"][number];

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

function formatEvent(e: { at: number; text: string }): string {
  const d = new Date(e.at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} ${e.text}`;
}

/** Collapsible list of the core's recent connection events, with a copy button to paste into a bug report. */
function Diagnostics() {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const refresh = () => void connectionLog().then((events) => setLines(events.map(formatEvent)));

  useEffect(() => {
    if (!open) return;
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (no permission): the list is still selectable.
    }
  };

  return (
    <>
      <button type="button" className="set-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="set-label">{t("connDiag")}</span>
        <span className="set-value">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="set-block">
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn ghost" onClick={() => void copy()}>
              {copied ? t("connDiagCopied") : t("connDiagCopy")}
            </button>
            <button type="button" className="btn ghost" onClick={refresh}>
              {t("connDiagRefresh")}
            </button>
          </div>
          <pre style={{ margin: 0, maxHeight: 260, overflow: "auto", fontSize: 11, lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "text" }}>
            {lines.length ? lines.join("\n") : t("connDiagEmpty")}
          </pre>
        </div>
      )}
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="group">{title}</h2>
      <div className="card set-card">{children}</div>
    </section>
  );
}

function Toggle({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void }) {
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
        onPointerCancel={(e) => commit(e.currentTarget)}
        onBlur={(e) => dragging.current && commit(e.currentTarget)}
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

type SectionId = "appearance" | "terminal" | "agents" | "resume" | "profiles" | "language" | "security" | "phone";

const svg = (children: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const ICONS: Record<SectionId, { tone: string; icon: ReactNode }> = {
  appearance: {
    tone: "violet",
    icon: svg(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" />
      </>,
    ),
  },
  terminal: {
    tone: "blue",
    icon: svg(
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M7 9l3 3-3 3M12 15h5" />
      </>,
    ),
  },
  agents: {
    tone: "amber",
    icon: svg(
      <>
        <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" />
        <path d="M10 21h4" />
      </>,
    ),
  },
  profiles: {
    tone: "blue",
    icon: svg(
      <>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.3c2 .8 3.5 2.6 3.5 5.7" />
      </>,
    ),
  },
  resume: { tone: "green", icon: svg(<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5" />) },
  language: {
    tone: "plain",
    icon: svg(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
      </>,
    ),
  },
  security: {
    tone: "green",
    icon: svg(
      <>
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </>,
    ),
  },
  phone: {
    tone: "plain",
    icon: svg(
      <>
        <rect x="7" y="2" width="10" height="20" rx="2" />
        <path d="M11 18h2" />
      </>,
    ),
  },
};

function SectionRow({ id, title, summary, onOpen }: { id: SectionId; title: string; summary: string; onOpen: () => void }) {
  const { tone, icon } = ICONS[id];
  return (
    <button type="button" className="sec-row" onClick={onOpen}>
      <span className={"sec-ic " + tone}>{icon}</span>
      <span className="sec-tx">
        <b>{title}</b>
        <span>{summary}</span>
      </span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );
}

const onOff = (v: boolean) => (v ? t("stateOn") : t("stateOff"));

function summaries(s: MirroredSettings | null, profiles: ProfileInfo[] | null, lock: ReturnType<typeof useLock>, local: ReturnType<typeof phoneTheme.get>, hostName?: string): Record<SectionId, string> {
  const eff = s ? effectivePhone(s, local) : null;
  const paletteName = s && eff ? (s.palettes.find((p) => p.id === eff.palette)?.name ?? eff.palette) : "";
  const themeName = eff ? { auto: t("themeAuto"), light: t("themeLight"), dark: t("themeDark") }[eff.theme] : "";
  const notifyCount = s ? [s.notify.done, s.notify.input, s.notify.exited, s.notify.limitReset].filter(Boolean).length : 0;
  const langName = !s ? "" : s.language === "system" ? t("langSystem") : (s.languages.find((l) => l.id === s.language)?.name ?? s.language);
  return {
    appearance: s ? (eff?.local ? t("sumPhoneOnly", { name: paletteName }) : `${paletteName} · ${themeName}`) : "",
    terminal: s ? t("sumTerminal", { size: s.terminalFontSize, banner: onOff(s.bannerEnabled) }) : "",
    agents: s ? (notifyCount ? t("sumAgents", { n: notifyCount }) : t("sumAgentsNone")) : "",
    profiles: profiles === null ? "" : profiles.length ? t("sumProfiles", { n: profiles.length }) : t("sumProfilesNone"),
    resume: s ? (s.autoResume.enabled ? t("sumResumeOn", { msg: s.autoResume.message || t("autoResumePlaceholder") }) : t("sumResumeOff")) : "",
    language: langName,
    security: lock.enabled ? t("sumLockOn") : t("sumLockOff"),
    phone: t("sumPhone", { host: hostName ?? "..." }),
  };
}

export function SettingsScreen({ hostName, settings: s, profiles }: { hostName?: string; settings: MirroredSettings | null; profiles: ProfileInfo[] | null }) {
  const lock = useLock();
  const [section, setSection] = useState<SectionId | null>(null);
  useBackHandler(section !== null, () => setSection(null));

  const local = phoneTheme.use();
  const sum = summaries(s, profiles, lock, local, hostName);
  const mirrored: SectionId[] = s ? ["appearance", "terminal", "agents", "resume", "profiles", "language"] : [];
  const phoneOnly: SectionId[] = lock.available ? ["security", "phone"] : ["phone"];
  const titles: Record<SectionId, string> = {
    appearance: t("appearance"),
    terminal: t("terminalGroup"),
    agents: t("secAgents"),
    resume: t("autoResume"),
    profiles: t("secProfiles"),
    language: t("language"),
    security: t("secSecurity"),
    phone: t("thisPhone"),
  };

  if (section === null) {
    return (
      <div className="sec-view" key="list">
        <header className="top">
          <h1>{t("settings")}</h1>
        </header>
        <div className="sec-lists">
          {!s && <div className="empty">{t("noSettings")}</div>}
          {mirrored.length > 0 && (
            <section>
              <h2 className="group">{t("groupShared")}</h2>
              <div className="card set-card">
                {mirrored.map((id) => (
                  <SectionRow key={id} id={id} title={titles[id]} summary={sum[id]} onOpen={() => setSection(id)} />
                ))}
              </div>
            </section>
          )}
          <section>
            <h2 className="group">{t("groupPhoneOnly")}</h2>
            <div className="card set-card">
              {phoneOnly.map((id) => (
                <SectionRow key={id} id={id} title={titles[id]} summary={sum[id]} onOpen={() => setSection(id)} />
              ))}
            </div>
          </section>
        </div>
      </div>
    );
  }

  const intro: Record<SectionId, string> = {
    appearance: t("introShared"),
    terminal: t("introShared"),
    agents: t("introAgents"),
    resume: t("introResume"),
    profiles: t("introProfiles"),
    language: t("introShared"),
    security: t("introSecurity"),
    phone: t("introPhone"),
  };

  return (
    <div className="sec-view" key={section}>
      <header className="sec-head">
        <button type="button" className="sec-back" aria-label={t("back")} onClick={() => setSection(null)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <h1>{titles[section]}</h1>
      </header>
      <p className="sec-intro">{intro[section]}</p>

      {section === "appearance" && s && (
        <>
        <Group title={t("scopeShared")}>
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
        <Group title={t("scopePhone")}>
          <Toggle label={t("phoneThemeSwitch")} hint={t("phoneThemeHint")} on={local.enabled} onChange={(on) => setPhoneTheme({ enabled: on }, s)} />
          {local.enabled && (
            <>
              <Segmented
                label={t("theme")}
                value={effectivePhone(s, local).theme}
                options={[
                  { id: "auto", name: t("themeAuto") },
                  { id: "light", name: t("themeLight") },
                  { id: "dark", name: t("themeDark") },
                ]}
                onChange={(v) => setPhoneTheme({ theme: v })}
              />
              <PaletteGrid label={t("palette")} palettes={s.palettes} value={effectivePhone(s, local).palette} onChange={(id) => setPhoneTheme({ palette: id })} />
            </>
          )}
        </Group>
        </>
      )}

      {section === "language" && s && (
        <Group title={t("language")}>
          <Segmented
            label={t("language")}
            value={s.language}
            options={[{ id: "system", name: t("langSystem") }, ...s.languages]}
            onChange={(v) => setSetting("language", v)}
          />
        </Group>
      )}

      {section === "terminal" && s && (
        <Group title={t("terminalGroup")}>
          <Stepper label={t("fontSize")} value={s.terminalFontSize} min={9} max={28} onChange={(v) => setSetting("terminalFontSize", v)} />
          <Toggle label={t("banner")} on={s.bannerEnabled} onChange={(v) => setSetting("bannerEnabled", v)} />
          <Toggle label={t("confirmLinks")} on={s.confirmLinkOpen} onChange={(v) => setSetting("confirmLinkOpen", v)} />
          <Toggle label={t("newTabPage")} on={s.newTabPage} onChange={(v) => setSetting("newTabPage", v)} />
          <Toggle label={t("restoreSession")} on={s.restoreSession} onChange={(v) => setSetting("restoreSession", v)} />
        </Group>
      )}

      {section === "agents" && s && (
        <>
          <Group title={t("notifyAgentGroup")}>
            <Toggle label={t("notifyDone")} hint={t("notifyDoneHint")} on={s.notify.done} onChange={(v) => setSetting("notify.done", v)} />
            <Toggle label={t("notifyInput")} hint={t("notifyInputHint")} on={s.notify.input} onChange={(v) => setSetting("notify.input", v)} />
            <Toggle label={t("notifyExited")} hint={t("notifyExitedHint")} on={s.notify.exited} onChange={(v) => setSetting("notify.exited", v)} />
          </Group>
          <Group title={t("notifyLimitGroup")}>
            <Toggle label={t("notifyLimit")} hint={t("notifyLimitHint")} on={s.notify.limitReset} onChange={(v) => setSetting("notify.limitReset", v)} />
          </Group>
        </>
      )}

      {section === "resume" && s && (
        <Group title={t("autoResume")}>
          <Toggle label={t("autoResume")} hint={t("autoResumeHint")} on={s.autoResume.enabled} onChange={(v) => setSetting("autoResume.enabled", v)} />
          <MessageField value={s.autoResume.message} onCommit={(v) => setSetting("autoResume.message", v)} />
        </Group>
      )}

      {section === "profiles" && <ProfilesPage profiles={profiles} />}

      {section === "security" && (
        <Group title={t("secSecurity")}>
          <Toggle
            label={t("lockSetting")}
            hint={t("lockHint")}
            on={lock.enabled}
            // Turning it off needs a successful unlock, so a borrowed unlocked phone can't drop the lock.
            onChange={(v) => void (v ? Promise.resolve(true) : verify()).then((ok) => ok && setLockEnabled(v))}
          />
        </Group>
      )}

      {section === "phone" && (
        <Group title={t("thisPhone")}>
          <Diagnostics />
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
      )}
    </div>
  );
}
