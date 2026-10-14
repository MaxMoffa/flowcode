import { useState } from "react";
import { t } from "./i18n";
import { Svg } from "./icons";
import { profileAction, showToast, type ProfileCli, type ProfileInfo } from "./remote";

/** Preset badge colors, same as the desktop's profile editor. */
const COLORS = ["#4f8cff", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6", "#ec4899", "#64748b"];
const CLIS: { id: ProfileCli; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "vibe", name: "Mistral Vibe" },
];

function Colors({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="prof-colors" role="radiogroup" aria-label={t("profileColor")}>
      {COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} className={"prof-color" + (value === c ? " on" : "")} style={{ background: c }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

function Check({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} className="prof-check" onClick={() => onChange(!on)}>
      <span className={"prof-box" + (on ? " on" : "")} aria-hidden="true">
        {on && (
          <Svg size={14} strokeWidth={3}>
            <path d="M5 12l5 5 9-10" />
          </Svg>
        )}
      </span>
      <span className="set-label">
        {label}
        <small className="set-hint">{hint}</small>
      </span>
    </button>
  );
}

function ProfileCard({ p }: { p: ProfileInfo }) {
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const [name, setName] = useState(p.name);
  const [color, setColor] = useState(p.color);
  const [withFiles, setWithFiles] = useState(false);

  const save = () => {
    const n = name.trim();
    if (!n) return;
    profileAction({ op: "update", id: p.id, name: n, color });
    setMode("view");
  };

  return (
    <div className="card set-card prof-card">
      <div className="prof-head">
        <i className="prof-dot" style={{ background: mode === "edit" ? color : p.color }} />
        <b className="prof-name">{p.name}</b>
        {mode === "view" && (
          <button
            type="button"
            className="btn ghost prof-small"
            onClick={() => {
              setName(p.name);
              setColor(p.color);
              setMode("edit");
            }}
          >
            {t("profileEdit")}
          </button>
        )}
      </div>

      {mode === "edit" && (
        <div className="prof-form">
          <input className="set-input" value={name} maxLength={64} aria-label={t("profileName")} placeholder={t("profileName")} enterKeyHint="done" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
          <Colors value={color} onChange={setColor} />
          <div className="prof-actions">
            <button type="button" className="btn primary" disabled={!name.trim()} onClick={save}>
              {t("profileSave")}
            </button>
            <button type="button" className="btn ghost" onClick={() => setMode("view")}>
              {t("profileCancel")}
            </button>
            <button
              type="button"
              className="btn ghost prof-danger"
              onClick={() => {
                setWithFiles(false);
                setMode("delete");
              }}
            >
              {t("profileDelete")}
            </button>
          </div>
        </div>
      )}

      {mode === "delete" && (
        <div className="prof-form">
          <b>{t("profileDeleteTitle", { name: p.name })}</b>
          <p className="prof-note">{t("profileDeleteHint")}</p>
          <Check label={t("profileDeleteFiles")} hint={t("profileDeleteFilesHint")} on={withFiles} onChange={setWithFiles} />
          <div className="prof-actions">
            <button type="button" className="btn prof-danger-fill" onClick={() => profileAction({ op: "delete", id: p.id, deleteFiles: withFiles })}>
              {t("profileDelete")}
            </button>
            <button type="button" className="btn ghost" onClick={() => setMode("edit")}>
              {t("profileCancel")}
            </button>
          </div>
        </div>
      )}

      {mode !== "delete" &&
        CLIS.map((c) => {
          const on = p.loggedIn[c.id];
          return (
            <div key={c.id} className="prof-cli">
              <span className="prof-cli-tx">
                <b>{c.name}</b>
                <small className={"prof-state" + (on ? " on" : "")}>{on ? t("profileSignedIn") : t("profileSignedOut")}</small>
              </span>
              <button
                type="button"
                className="btn ghost prof-small"
                onClick={() => {
                  profileAction({ op: "login", id: p.id, cli: c.id });
                  showToast(t("profileLoginSent"));
                }}
              >
                {on ? t("profileRelogin") : t("profileLogin")}
              </button>
            </div>
          );
        })}
    </div>
  );
}

function NewProfile() {
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [copy, setCopy] = useState(true);
  const create = () => {
    const n = name.trim();
    if (!n) return;
    profileAction({ op: "create", name: n, color, copySettings: copy });
    setName("");
    setColor(COLORS[0]);
  };
  return (
    <section>
      <h2 className="group">{t("profileNew")}</h2>
      <div className="card set-card prof-card">
        <div className="prof-form">
          <input className="set-input" value={name} maxLength={64} aria-label={t("profileName")} placeholder={t("profileName")} enterKeyHint="done" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
          <Colors value={color} onChange={setColor} />
          <Check label={t("profileCopySettings")} hint={t("profileCopySettingsHint")} on={copy} onChange={setCopy} />
          <button type="button" className="btn primary" disabled={!name.trim()} onClick={create}>
            {t("profileCreate")}
          </button>
        </div>
      </div>
    </section>
  );
}

/** The Profili page: the desktop's account profiles, mirrored. Every change is a request to the desktop; the list updates when it answers. */
export function ProfilesPage({ profiles }: { profiles: ProfileInfo[] | null }) {
  if (profiles === null) return <div className="empty">{t("profilesWaiting")}</div>;
  return (
    <>
      <div className="card set-card prof-card">
        <div className="prof-head">
          <i className="prof-dot default" />
          <span className="set-label">
            <b>{t("defaultProfile")}</b>
            <small className="set-hint">{t("profileDefaultHint")}</small>
          </span>
        </div>
      </div>
      {profiles.map((p) => (
        <ProfileCard key={p.id} p={p} />
      ))}
      <NewProfile />
    </>
  );
}
