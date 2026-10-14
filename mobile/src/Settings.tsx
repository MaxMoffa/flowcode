import { useEffect, useState } from "react";
import "./settings.css";
import { useBackHandler } from "./back";
import { t } from "./i18n";
import { setLockEnabled, useLock, verify } from "./applock";
import { effectivePhone, phoneTheme, setPhoneTheme } from "./theme";
import {
  DEFAULT_BACKGROUND,
  backgroundSettings,
  setSetting,
  unpair,
  useRemoteSelector,
  type BackgroundSettings,
  type MirroredSettings,
  type ProfileInfo,
} from "./remote";
import { Svg } from "./icons";
import { ProfilesPage } from "./ProfilesSettings";
import { BackgroundPage } from "./BackgroundSettings";
import { Diagnostics } from "./SettingsDiagnostics";
import { Group, MessageField, PaletteGrid, Segmented, Slider, Stepper, Toggle } from "./SettingsControls";
import { ICONS, type SectionId } from "./settingsIcons";

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

function summaries(s: MirroredSettings | null, profiles: ProfileInfo[] | null, lock: ReturnType<typeof useLock>, local: ReturnType<typeof phoneTheme.get>, bg: BackgroundSettings, hostName?: string): Record<SectionId, string> {
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
    background: !bg.enabled ? t("sumBgOff") : bg.capMinutes ? t("sumBgOn", { n: bg.capMinutes / 60 }) : t("sumBgOnNever"),
    phone: t("sumPhone", { host: hostName ?? "..." }),
  };
}

export function SettingsScreen({ hostName, settings: s }: { hostName?: string; settings: MirroredSettings | null }) {
  const profiles = useRemoteSelector((r) => r.profiles);
  const lock = useLock();
  const [section, setSection] = useState<SectionId | null>(null);
  useBackHandler(section !== null, () => setSection(null));

  const local = phoneTheme.use();
  const [bg, setBg] = useState<BackgroundSettings>(DEFAULT_BACKGROUND);
  useEffect(() => {
    void backgroundSettings().then(setBg);
  }, []);
  const sum = summaries(s, profiles, lock, local, bg, hostName);
  const mirrored: SectionId[] = s ? ["appearance", "terminal", "agents", "resume", "profiles", "language"] : [];
  const phoneOnly: SectionId[] = lock.available ? ["security", "background", "phone"] : ["background", "phone"];
  const titles: Record<SectionId, string> = {
    appearance: t("appearance"),
    terminal: t("terminalGroup"),
    agents: t("secAgents"),
    resume: t("autoResume"),
    profiles: t("secProfiles"),
    language: t("language"),
    security: t("secSecurity"),
    background: t("secBackground"),
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
    background: t("introBackground"),
    phone: t("introPhone"),
  };

  return (
    <div className="sec-view" key={section}>
      <header className="sec-head">
        <button type="button" className="sec-back" aria-label={t("back")} onClick={() => setSection(null)}>
          <Svg size={22} strokeWidth={2}>
            <path d="M15 6l-6 6 6 6" />
          </Svg>
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

      {section === "background" && <BackgroundPage bg={bg} onChange={setBg} />}

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
