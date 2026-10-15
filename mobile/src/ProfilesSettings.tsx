import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBackHandler } from "./back";
import { t } from "./i18n";
import { CloseIcon, Svg } from "./icons";
import { profileAction, showToast, useSupports, type ProfileCli, type ProfileInfo } from "./remote";
import { useSheetDrag } from "./useSheetDrag";

/** Preset badge colors, same as the desktop's profile editor. */
const COLORS = ["#4f8cff", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6", "#ec4899", "#64748b"];
const CLIS: { id: ProfileCli; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "vibe", name: "Mistral Vibe" },
  { id: "gemini", name: "Gemini CLI" },
];

type LoggedIn = Record<ProfileCli, boolean>;

/** What the open sheet is about: the new-profile form, the agents a profile can still sign in, or a sign-out to confirm. `id` "" is the default profile. */
type SheetState = { kind: "new" } | { kind: "add"; id: string; name: string; off: ProfileCli[] } | { kind: "logout"; id: string; name: string; cli: ProfileCli };

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

/** Bottom sheet, same look as the terminal's. Always mounted so it can slide; closes on Escape, Back, the scrim or a swipe down. */
function Sheet({ open, onClose, title, subtitle, children }: { open: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  useBackHandler(open, onClose);
  useSheetDrag(ref, onClose, open);

  // In the body, not the page: the page slides in with a transform, which would pin the fixed layer to it.
  return createPortal(
    <div className={"ps-layer" + (open ? " open" : "")}>
      <div className="ps-scrim" data-sheet-scrim onClick={onClose} />
      <section ref={ref} className="ps-sheet" role="dialog" aria-modal="true" aria-label={title} aria-hidden={!open}>
        <div className="ps-grabber" />
        <header className="ps-head">
          <div className="ps-titles">
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="ps-close" aria-label={t("closeViewer")} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="ps-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

function NewProfileSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [copy, setCopy] = useState(true);
  const close = () => {
    onClose();
    setName("");
    setColor(COLORS[0]);
    setCopy(true);
  };
  const create = () => {
    const n = name.trim();
    if (!n) return;
    profileAction({ op: "create", name: n, color, copySettings: copy });
    close();
  };
  return (
    <Sheet open={open} onClose={close} title={t("profileNew")}>
      <input className="set-input" value={name} maxLength={64} aria-label={t("profileName")} placeholder={t("profileName")} enterKeyHint="done" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
      <Colors value={color} onChange={setColor} />
      <Check label={t("profileCopySettings")} hint={t("profileCopySettingsHint")} on={copy} onChange={setCopy} />
      <button type="button" className="btn primary big" disabled={!name.trim()} onClick={create}>
        {t("profileCreate")}
      </button>
    </Sheet>
  );
}

/** The agents signed in under a profile, each with sign-in-again / sign-out, and the way to add one. */
function Agents({ id, name, loggedIn, onAdd, onLogout }: { id: string; name: string; loggedIn: LoggedIn; onAdd: (off: ProfileCli[]) => void; onLogout: (cli: ProfileCli) => void }) {
  // Older desktops can sign a profile in but not out, and know nothing of the default profile's agents.
  const canLogin = useSupports("profileLogin");
  const canLogout = useSupports("profileAgents");
  const canGemini = useSupports("gemini");
  if (!canLogin) return null;
  const on = CLIS.filter((c) => loggedIn[c.id] && (c.id !== "gemini" || canGemini));
  const off = CLIS.filter((c) => !loggedIn[c.id] && (c.id !== "gemini" || canGemini));
  return (
    <>
      {on.length === 0 && <div className="prof-cli prof-none">{t("profileNoAgents")}</div>}
      {on.map((c) => (
        <div key={c.id} className="prof-cli">
          <b className="prof-cli-tx">{c.name}</b>
          <button
            type="button"
            className="btn ghost prof-small"
            onClick={() => {
              profileAction({ op: "login", id, cli: c.id });
              showToast(t("profileLoginSent"));
            }}
          >
            {t("profileRelogin")}
          </button>
          {canLogout && (
            <button type="button" className="btn ghost prof-small prof-out" aria-label={`${t("profileLogout")} ${c.name} (${name})`} onClick={() => onLogout(c.id)}>
              {t("profileLogout")}
            </button>
          )}
        </div>
      ))}
      {off.length > 0 && (
        <div className="prof-cli">
          <button type="button" className="btn ghost prof-add" onClick={() => onAdd(off.map((c) => c.id))}>
            + {t("profileAddAgent")}
          </button>
        </div>
      )}
    </>
  );
}

function ProfileCard({ p, onAdd, onLogout }: { p: ProfileInfo; onAdd: (off: ProfileCli[]) => void; onLogout: (cli: ProfileCli) => void }) {
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

      {mode !== "delete" && <Agents id={p.id} name={p.name} loggedIn={p.loggedIn} onAdd={onAdd} onLogout={onLogout} />}
    </div>
  );
}

/** The Profili page: the desktop's account profiles, mirrored. Every change is a request to the desktop; the list updates when it answers. `defaultLoggedIn` is null for a desktop that doesn't send it. */
export function ProfilesPage({ profiles, defaultLoggedIn }: { profiles: ProfileInfo[] | null; defaultLoggedIn: LoggedIn | null }) {
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [open, setOpen] = useState(false);
  const canAgents = useSupports("profileAgents");
  const canGemini = useSupports("gemini");
  const show = (s: SheetState) => {
    setSheet(s);
    setOpen(true);
  };
  const close = () => setOpen(false);
  // The state outlives the closing, so the sheet's content stays put while it slides out.
  const add = sheet?.kind === "add" ? sheet : null;
  const out = sheet?.kind === "logout" ? sheet : null;
  const outName = CLIS.find((c) => c.id === out?.cli)?.name ?? "";

  if (profiles === null) return <div className="empty">{t("profilesWaiting")}</div>;
  const defaultName = t("defaultProfile");
  return (
    <>
      <button type="button" className="btn primary big prof-new" onClick={() => show({ kind: "new" })}>
        + {t("profileNew")}
      </button>

      <div className="card set-card prof-card">
        <div className="prof-head">
          <i className="prof-dot default" />
          {defaultLoggedIn ? (
            <b className="prof-name">{defaultName}</b>
          ) : (
            <span className="set-label">
              <b>{defaultName}</b>
              <small className="set-hint">{t("profileDefaultHint")}</small>
            </span>
          )}
        </div>
        {defaultLoggedIn && canAgents && (
          <Agents
            id=""
            name={defaultName}
            loggedIn={defaultLoggedIn}
            onAdd={(off) => show({ kind: "add", id: "", name: defaultName, off })}
            onLogout={(cli) => show({ kind: "logout", id: "", name: defaultName, cli })}
          />
        )}
      </div>
      {profiles.map((p) => (
        <ProfileCard key={p.id} p={p} onAdd={(off) => show({ kind: "add", id: p.id, name: p.name, off })} onLogout={(cli) => show({ kind: "logout", id: p.id, name: p.name, cli })} />
      ))}

      <NewProfileSheet open={open && sheet?.kind === "new"} onClose={close} />
      <Sheet open={open && sheet?.kind === "add"} onClose={close} title={t("profileAddAgent")} subtitle={add?.name}>
        {CLIS.filter((c) => add?.off.includes(c.id) && (c.id !== "gemini" || canGemini)).map((c) => (
          <button
            key={c.id}
            type="button"
            className="ps-row"
            onClick={() => {
              if (add) profileAction({ op: "login", id: add.id, cli: c.id });
              showToast(t("profileLoginSent"));
              close();
            }}
          >
            {c.name}
          </button>
        ))}
      </Sheet>
      <Sheet open={open && sheet?.kind === "logout"} onClose={close} title={t("profileLogoutTitle", { name: outName })}>
        <p className="prof-note">{t("profileLogoutHint", { name: outName, profile: out?.name ?? "" })}</p>
        <button
          type="button"
          className="btn big prof-danger-fill"
          onClick={() => {
            if (out) profileAction({ op: "logout", id: out.id, cli: out.cli });
            close();
          }}
        >
          {t("profileLogout")}
        </button>
        <button type="button" className="btn ghost big" onClick={close}>
          {t("profileCancel")}
        </button>
      </Sheet>
    </>
  );
}
