import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../i18n";
import { shellOptionLabel, type ShellOption } from "../terminal/shellOptions";
import { shellStartKey, useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { SettingRow } from "./SettingsControls";
import { resolveWslStartDir, wslDistroOfShell } from "../terminal/wslPath";

/** Whether `path` is a folder a tab of this shell could start in - for WSL
 * that includes POSIX paths (`~/src`, `/opt/x`), checked in the default
 * distro, the same way App.tsx's `resolveStartDir` will resolve them. */
async function isValidStartDir(isWsl: boolean, path: string): Promise<boolean> {
  if (isWsl) return (await resolveWslStartDir(null, path)) !== null;
  return invoke<boolean>("is_directory", { path }).catch(() => false);
}

/** One shell's row: "use the default" (the general start folder, or the
 * distro's home for WSL) or a folder of its own. Same draft/verify/commit
 * flow as the general "Cartella di avvio" field - only a verified path ever
 * reaches the setting. */
function ShellStartDirRow({ option }: { option: ShellOption }) {
  const { t } = useI18n();
  const { shellStartPaths, setShellStartPath } = useTerminalSettings();
  const key = shellStartKey(option.id);
  const isWsl = wslDistroOfShell(option.id) !== undefined;
  const saved = shellStartPaths[key] ?? "";
  const [customMode, setCustomMode] = useState(saved !== "");
  const [draft, setDraft] = useState(saved);
  const [valid, setValid] = useState<boolean | null>(null);

  // Cleared from outside the row - "Ripristina impostazioni" on this page.
  useEffect(() => {
    if (saved !== "") return;
    setCustomMode(false);
    setDraft("");
  }, [saved]);

  useEffect(() => {
    setValid(null);
    if (!customMode || !draft) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void isValidStartDir(isWsl, draft).then((ok) => {
        if (!cancelled) setValid(ok);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [customMode, draft, isWsl]);

  useEffect(() => {
    if (!customMode) {
      if (saved !== "") setShellStartPath(key, "");
      return;
    }
    if (valid === true && draft && draft !== saved) setShellStartPath(key, draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customMode, draft, valid]);

  return (
    <div className="settings-shell-start">
      <span className="settings-shell-start-name">{shellOptionLabel(option)}</span>
      <div className="settings-choice-row">
        <button
          type="button"
          className={"settings-choice" + (!customMode ? " is-active" : "")}
          onClick={() => setCustomMode(false)}
        >
          {isWsl ? t("settings.shellStartDir.wslHome") : t("settings.shellStartDir.default")}
        </button>
        <button
          type="button"
          className={"settings-choice" + (customMode ? " is-active" : "")}
          onClick={() => setCustomMode(true)}
        >
          {t("settings.startDir.custom")}
        </button>
      </div>
      {customMode && (
        <>
          <input
            type="text"
            className="settings-text-input"
            value={draft}
            placeholder={isWsl ? t("settings.shellStartDir.wslPlaceholder") : t("settings.startDir.placeholder")}
            onChange={(e) => setDraft(e.target.value)}
          />
          {valid === false && <span className="settings-field-hint is-error">{t("settings.startDir.notFound")}</span>}
          {valid === true && <span className="settings-field-hint is-success">{t("settings.startDir.valid")}</span>}
        </>
      )}
    </div>
  );
}

/** "Cartella di avvio per shell": a start folder for each shell offered on
 * this machine, overriding the general one (see `shellStartPaths` in
 * TerminalSettingsContext). */
export function ShellStartDirs({ options }: { options: ShellOption[] }) {
  const { t } = useI18n();
  if (options.length === 0) return null;
  return (
    <SettingRow id="shellStartDir" stacked label={t("settings.shellStartDir.label")} desc={t("settings.shellStartDir.desc")}>
      <div className="settings-shell-start-list">
        {options.map((opt) => (
          <ShellStartDirRow key={opt.id} option={opt} />
        ))}
      </div>
    </SettingRow>
  );
}
