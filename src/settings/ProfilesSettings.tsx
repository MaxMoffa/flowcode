import { useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { AGENT_CLIS, CLI_INFO, defaultCliStatus, type AgentCli } from "../agents/cliInfo";
import { agentCliIcon } from "../plugins/icons";
import {
  createProfile,
  deleteProfile,
  logoutProfile,
  refreshProfiles,
  updateProfile,
  useProfiles,
  type LoginState,
  type ProfileInfo,
} from "../profiles/profiles";
import { settingDomId } from "./SettingsControls";

/** Preset colours offered for a profile's badge; the first is the default. */
const PROFILE_COLORS = ["#4f8cff", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6", "#ec4899", "#64748b"];

function ColorPicker({ value, onChange, label }: { value: string; onChange: (color: string) => void; label: string }) {
  return (
    <div className="profiles-colors" role="radiogroup" aria-label={label}>
      {PROFILE_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          className={"profiles-color" + (value === color ? " is-active" : "")}
          style={{ background: color }}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  );
}

/** `cardError` key of the default profile's card. */
const DEFAULT_CARD = "";

/** The agents signed in under one profile (sign in again, sign out) and a
 * "+" listing the others to sign in to. */
function ProfileClis({
  loggedIn,
  onLogin,
  onLogout,
}: {
  loggedIn: LoginState | null;
  onLogin?: (cli: AgentCli) => void;
  onLogout: (cli: AgentCli) => void;
}) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  const on = AGENT_CLIS.filter((cli) => loggedIn?.[cli]);
  const off = AGENT_CLIS.filter((cli) => !loggedIn?.[cli]);
  return (
    <div className="profiles-clis">
      {on.length === 0 && <p className="profiles-clis-empty">{t("settings.profiles.noAgents")}</p>}
      {on.map((cli) => (
        <div key={cli} className="profiles-cli">
          <span className="profiles-cli-icon">{agentCliIcon(cli)}</span>
          <span className="profiles-cli-name">{CLI_INFO[cli].label}</span>
          {onLogin && (
            <button type="button" className="settings-choice" onClick={() => onLogin(cli)}>
              {t("settings.profiles.relogin")}
            </button>
          )}
          <button type="button" className="settings-choice is-danger" onClick={() => onLogout(cli)}>
            {t("settings.profiles.logout")}
          </button>
        </div>
      ))}
      {onLogin && off.length > 0 && (
        <div className="profiles-add">
          <button type="button" className="settings-choice" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
            + {t("settings.profiles.addAgent")}
          </button>
          {adding &&
            off.map((cli) => (
              <button
                key={cli}
                type="button"
                className="settings-choice profiles-add-cli"
                onClick={() => {
                  setAdding(false);
                  onLogin(cli);
                }}
              >
                <span className="profiles-cli-icon">{agentCliIcon(cli)}</span>
                {CLI_INFO[cli].label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/** The Profiles settings page: the implicit default profile and one card per
 * extra profile (each lists its signed-in agents with sign-out and a "+" to
 * add others; rename/recolour, delete) and a form to create more. `onLogin`
 * opens the CLI's login in a terminal tab under that profile; without it the
 * sign-in buttons are hidden. */
export function ProfilesSettings({ onLogin }: { onLogin?: (profileId: string | null, cli: AgentCli) => void }) {
  // A focus listener is already waiting: one refresh covers every login click.
  const loginFocusArmedRef = useRef(false);
  const { t } = useI18n();
  const confirm = useConfirmDialog();
  const { profiles, default_logged_in } = useProfiles();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(PROFILE_COLORS[0]);
  const [cardError, setCardError] = useState<{ id: string; message: string } | null>(null);

  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(PROFILE_COLORS[0]);
  const [copySettings, setCopySettings] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function startEdit(profile: ProfileInfo) {
    setEditingId(profile.id);
    setEditName(profile.name);
    setEditColor(profile.color);
    setCardError(null);
  }

  async function saveEdit(profile: ProfileInfo) {
    const name = editName.trim();
    if (!name) return;
    try {
      await updateProfile(profile.id, name, editColor);
      setEditingId(null);
      setCardError(null);
    } catch (e) {
      setCardError({ id: profile.id, message: String(e) });
    }
  }

  async function handleDelete(profile: ProfileInfo) {
    const ok = await confirm({
      title: t("settings.profiles.deleteConfirm.title"),
      message: t("settings.profiles.deleteConfirm.message", { name: profile.name }),
      confirmLabel: t("settings.profiles.delete"),
      danger: true,
    });
    if (!ok) return;
    const withFiles = await confirm({
      title: t("settings.profiles.deleteFiles.title"),
      message: t("settings.profiles.deleteFiles.message"),
      confirmLabel: t("settings.profiles.delete"),
      danger: true,
    });
    try {
      await deleteProfile(profile.id, withFiles);
      setCardError(null);
    } catch (e) {
      setCardError({ id: profile.id, message: String(e) });
    }
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      await createProfile(name, newColor, copySettings);
      setNewName("");
      setNewColor(PROFILE_COLORS[0]);
    } catch (e) {
      setCreateError(String(e));
    } finally {
      setCreating(false);
    }
  }

  /** Hands the login to the terminal, then re-reads the login state once the
   * user comes back to this window. */
  function handleLogin(profileId: string | null, cli: AgentCli) {
    onLogin?.(profileId, cli);
    if (loginFocusArmedRef.current) return;
    loginFocusArmedRef.current = true;
    window.addEventListener(
      "focus",
      () => {
        loginFocusArmedRef.current = false;
        void refreshProfiles();
        if (profileId === null) void defaultCliStatus(cli, true);
      },
      { once: true },
    );
  }

  async function handleLogout(profileId: string | null, profileName: string, cli: AgentCli) {
    const name = CLI_INFO[cli].label;
    const ok = await confirm({
      title: t("settings.profiles.logoutConfirm.title", { name }),
      message: t("settings.profiles.logoutConfirm.message", { name, profile: profileName }),
      confirmLabel: t("settings.profiles.logout"),
      danger: true,
    });
    if (!ok) return;
    try {
      await logoutProfile(profileId, cli);
      setCardError(null);
    } catch (e) {
      setCardError({ id: profileId ?? DEFAULT_CARD, message: String(e) });
    }
    // The shortcuts' cached sign-in check is the default profile's.
    if (profileId === null) void defaultCliStatus(cli, true);
  }

  return (
    <div id={settingDomId("profiles")}>
      <p className="profiles-intro">{t("settings.profiles.intro")}</p>

      <div className="profiles-list">
        <div className="settings-card profiles-card">
          <div className="profiles-head">
            <span className="profiles-swatch is-default" />
            <div className="profiles-title">
              <div className="settings-row-label">{t("settings.profiles.default")}</div>
              <p className="settings-row-desc">{t("settings.profiles.defaultHint")}</p>
            </div>
          </div>
          <ProfileClis
            loggedIn={default_logged_in}
            onLogin={onLogin && ((cli) => handleLogin(null, cli))}
            onLogout={(cli) => void handleLogout(null, t("settings.profiles.default"), cli)}
          />
          {cardError?.id === DEFAULT_CARD && <span className="settings-field-hint is-error profiles-error">{cardError.message}</span>}
        </div>

        {profiles.length === 0 && <p className="profiles-empty">{t("settings.profiles.empty")}</p>}

        {profiles.map((profile) => {
          const editing = editingId === profile.id;
          return (
            <div key={profile.id} className="settings-card profiles-card">
              <div className="profiles-head">
                <span className="profiles-swatch" style={{ background: editing ? editColor : profile.color }} />
                {editing ? (
                  <div className="profiles-edit">
                    <input
                      type="text"
                      className="settings-text-input"
                      value={editName}
                      aria-label={t("settings.profiles.name")}
                      placeholder={t("settings.profiles.name")}
                      autoFocus
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveEdit(profile);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                    />
                    <ColorPicker value={editColor} onChange={setEditColor} label={t("settings.profiles.color")} />
                    <div className="settings-choice-row">
                      <button
                        type="button"
                        className="settings-choice is-primary"
                        disabled={!editName.trim()}
                        onClick={() => void saveEdit(profile)}
                      >
                        {t("settings.profiles.save")}
                      </button>
                      <button type="button" className="settings-choice" onClick={() => setEditingId(null)}>
                        {t("settings.profiles.cancel")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="profiles-title">
                      <div className="settings-row-label">{profile.name}</div>
                      <div className="profiles-dir" title={profile.dir}>
                        <bdi>{profile.dir}</bdi>
                      </div>
                    </div>
                    <div className="settings-choice-row">
                      <button type="button" className="settings-choice" onClick={() => startEdit(profile)}>
                        {t("settings.profiles.edit")}
                      </button>
                      <button type="button" className="settings-choice is-danger" onClick={() => void handleDelete(profile)}>
                        {t("settings.profiles.delete")}
                      </button>
                    </div>
                  </>
                )}
              </div>

              <ProfileClis
                loggedIn={profile.logged_in}
                onLogin={onLogin && ((cli) => handleLogin(profile.id, cli))}
                onLogout={(cli) => void handleLogout(profile.id, profile.name, cli)}
              />
              {cardError?.id === profile.id && (
                <span className="settings-field-hint is-error profiles-error">{cardError.message}</span>
              )}
            </div>
          );
        })}
      </div>

      <section className="settings-group">
        <h3 className="settings-group-title">{t("settings.profiles.newTitle")}</h3>
        <div className="settings-card profiles-card profiles-new">
          <input
            type="text"
            className="settings-text-input"
            value={newName}
            aria-label={t("settings.profiles.name")}
            placeholder={t("settings.profiles.name")}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreate();
            }}
          />
          <ColorPicker value={newColor} onChange={setNewColor} label={t("settings.profiles.color")} />
          <label className="profiles-check">
            <input type="checkbox" checked={copySettings} onChange={(e) => setCopySettings(e.target.checked)} />
            <span>
              <span className="settings-row-label">{t("settings.profiles.copySettings")}</span>
              <span className="settings-row-desc">{t("settings.profiles.copySettingsHint")}</span>
            </span>
          </label>
          <div className="settings-choice-row">
            <button
              type="button"
              className="settings-choice is-primary"
              disabled={!newName.trim() || creating}
              onClick={() => void handleCreate()}
            >
              {t("settings.profiles.create")}
            </button>
          </div>
          {createError && <span className="settings-field-hint is-error">{createError}</span>}
        </div>
      </section>
    </div>
  );
}
