import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBackHandler, useEscape } from "./back";
import { shortCwd } from "./common";
import { t } from "./i18n";
import { AgentLogo, CheckIcon, ChevronIcon, FolderIcon, TerminalIcon } from "./icons";
import { send, useRemoteSelector, useSupports, type ProfileCli, type ProfileInfo } from "./remote";
import { safeStorage } from "./store";
import { useUiZoom } from "./uiScale";
import { useSheetDrag } from "./useSheetDrag";

type Cli = ProfileCli;
const AGENTS: { id: Cli; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "vibe", name: "Mistral Vibe" },
  { id: "gemini", name: "Gemini CLI" },
];

/** A terminal the user created before: what the "Recenti" chips replay with one tap. */
interface Recent {
  cwd: string | null;
  cli: Cli | null;
  profile: string | null;
}

const MAX_RECENTS = 4;
const recentsKey = (host: string | undefined) => "nts.recent." + (host ?? "");
const sameRecent = (a: Recent, b: Recent) => a.cwd === b.cwd && a.cli === b.cli && a.profile === b.profile;

/** The saved recents of one desktop; anything unreadable counts as none. */
function loadRecents(key: string): Recent[] {
  try {
    const raw: unknown = JSON.parse(safeStorage.get(key) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const out: Recent[] = [];
    for (const r of raw) {
      if (typeof r !== "object" || r === null) continue;
      const { cwd, cli, profile } = r as Record<string, unknown>;
      if ((cwd !== null && typeof cwd !== "string") || (profile !== null && typeof profile !== "string")) continue;
      if (cli !== null && !AGENTS.some((a) => a.id === cli)) continue;
      out.push({ cwd, cli: cli as Cli | null, profile });
    }
    return out.slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

/** Whether `cli` is signed in under `profile`. Automatic (null) or unknown profiles can't be judged by the phone (the desktop picks), so every agent counts. */
function agentAvailable(cli: Cli, profile: string | null, profiles: ProfileInfo[] | null, defaultLoggedIn: Record<ProfileCli, boolean> | null): boolean {
  if (profile === null || !profiles) return true;
  if (profile === "") return defaultLoggedIn ? defaultLoggedIn[cli] : true;
  return profiles.find((p) => p.id === profile)?.loggedIn[cli] === true;
}

interface NtsOption<V> {
  value: V;
  label: string;
  icon: ReactNode;
  mono?: boolean;
}

/** One "select row" (icon, value, chevron) and the context menu it opens under (or above) itself. The menu is portalled to <body>: the sheet's backdrop-filter would otherwise trap `position: fixed` inside it. */
function NtsMenu<V extends string | null>({ label, icon, valueLabel, mono, options, value, hint, zoom, open, onToggle, onSelect }: { label: string; icon: ReactNode; valueLabel: string; mono?: boolean; options: NtsOption<V>[]; value: V; hint?: string; zoom: number; open: boolean; onToggle: (open: boolean) => void; onSelect: (v: V) => void }) {
  const row = useRef<HTMLButtonElement>(null);
  /** Where the menu sits, measured when it opens. Rects are in screen px while the menu's own lengths are multiplied by `zoom` (it lives under <body>, outside the zoomed sheet), so they are divided by it. */
  const [pos, setPos] = useState<{ zoom: number; left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);

  useEffect(() => {
    const el = row.current;
    if (!open || !el) return;
    const r = el.getBoundingClientRect();
    const below = innerHeight - r.bottom - 12;
    const above = r.top - 12;
    // Below by default; above only when it is cramped there and roomier up top.
    const flip = below < 220 && above > below;
    const room = flip ? above : below;
    setPos({
      zoom,
      left: r.left / zoom,
      width: r.width / zoom,
      maxHeight: Math.max(120, Math.min(innerHeight * 0.5, room)) / zoom,
      ...(flip ? { bottom: (innerHeight - r.top + 4) / zoom } : { top: (r.bottom + 4) / zoom }),
    });
  }, [open, zoom]);

  return (
    <div className="nts-field">
      <span className="nts-label">{label}</span>
      <button ref={row} type="button" className={"nts-sel" + (open ? " open" : "")} aria-haspopup="menu" aria-expanded={open} onClick={() => onToggle(!open)}>
        {icon}
        <span className={"nts-sel-value" + (mono ? " mono" : "")}>{valueLabel}</span>
        <span className="nts-sel-chev" aria-hidden="true">
          <ChevronIcon />
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <>
            <div className="nts-menu-scrim" onClick={() => onToggle(false)} />
            <div className="nts-menu" role="menu" aria-label={label} style={pos}>
              {options.map((o) => (
                <button key={o.value ?? "\0"} type="button" role="menuitemradio" aria-checked={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onSelect(o.value)}>
                  {o.icon}
                  <span className={"nts-opt-label" + (o.mono ? " mono" : "")}>{o.label}</span>
                  {o.value === value && <CheckIcon />}
                </button>
              ))}
              {hint && <p className="nts-menu-hint">{hint}</p>}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

const Dot = ({ color }: { color: string }) => <i className="dot" style={{ background: color }} />;
const agentIcon = (cli: Cli | null) => (cli ? <AgentLogo cli={cli} size={18} /> : <TerminalIcon />);
const agentName = (cli: Cli | null) => AGENTS.find((a) => a.id === cli)?.name ?? t("newTermShell");

/** "Nuovo terminale": where (a folder of the open tabs, or the desktop's start
 * folder), under which account profile and what to run (a shell, or an agent
 * straight away). The desktop opens it as a new tab; `onCreate` runs once the
 * request is sent. With an `anchor` (wide layout) it is a popover under that
 * rect instead of a bottom sheet. */
export function NewTerminalSheet({ open, folders, anchor, onClose, onCreate }: { open: boolean; folders: string[]; anchor?: DOMRect | null; onClose: () => void; onCreate: () => void }) {
  /** null = the desktop's start folder. */
  const [cwd, setCwd] = useState<string | null>(null);
  const [cli, setCli] = useState<Cli | null>(null);
  /** null = automatic (the folder's project default), "" = the default profile. */
  const [profile, setProfile] = useState<string | null>(null);
  /** The select row whose menu is open. */
  const [menu, setMenu] = useState<"cwd" | "profile" | "agent" | null>(null);
  const canPickProfile = useSupports("newTabProfile");
  const canGemini = useSupports("gemini");
  const profiles = useRemoteSelector((r) => r.profiles);
  const defaultLoggedIn = useRemoteSelector((r) => r.defaultLoggedIn);
  const hostName = useRemoteSelector((r) => r.hostName);
  const key = recentsKey(hostName);
  const [saved, setSaved] = useState(() => ({ key, list: loadRecents(key) }));
  if (saved.key !== key) setSaved({ key, list: loadRecents(key) });
  const popover = !!anchor;
  const uiZoom = useUiZoom();
  /** Only the wide popover is scaled; the phone sheet keeps its size. */
  const zoom = popover ? uiZoom : 1;
  const sheet = useRef<HTMLDivElement>(null);
  const closeMenu = () => setMenu(null);
  // The menu registers last, so Back and Escape close just it before the sheet.
  useBackHandler(open, onClose);
  useBackHandler(menu !== null, closeMenu);
  useEscape(open && menu === null, onClose);
  useEscape(menu !== null, closeMenu);
  useSheetDrag(sheet, onClose, open && !popover);

  const showProfiles = canPickProfile && !!profiles && profiles.length > 0;
  const usable = (c: Cli, p: string | null) => (c !== "gemini" || canGemini) && agentAvailable(c, p, canPickProfile ? profiles : null, defaultLoggedIn);

  const create = (v: Recent = { cwd, cli, profile }) => {
    const p = canPickProfile ? v.profile : null;
    const entry: Recent = { cwd: v.cwd, cli: v.cli, profile: p };
    const list = [entry, ...saved.list.filter((r) => !sameRecent(r, entry))].slice(0, MAX_RECENTS);
    safeStorage.set(key, JSON.stringify(list));
    setSaved({ key, list });
    send({ t: "newtab", ...(v.cwd ? { cwd: v.cwd } : {}), ...(v.cli ? { cli: v.cli } : {}), ...(p !== null ? { profile: p } : {}) });
    onCreate();
    onClose();
  };

  // Enter opens, on a hardware keyboard (wide layout); on a focused row or chip it keeps doing what that button does.
  const enter = useRef<() => void>(create);
  enter.current = create;
  useEffect(() => {
    if (!open || !popover || menu !== null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || (e.target as Element | null)?.closest?.("button")) return;
      e.preventDefault();
      enter.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, popover, menu]);

  if (!open) return null;

  /** Picking a profile drops an agent that isn't signed in under it. */
  const pickProfile = (p: string | null) => {
    setProfile(p);
    if (cli && !usable(cli, p)) setCli(null);
  };
  const profileInfo = (id: string) => profiles?.find((p) => p.id === id);
  const profileName = (p: string) => (p === "" ? t("defaultProfile") : (profileInfo(p)?.name ?? p));
  const profileColor = (p: string) => (p === "" ? "var(--muted)" : (profileInfo(p)?.color ?? "var(--muted)"));

  const recents = saved.list.filter((r) => (r.cli === null || usable(r.cli, r.profile)) && (r.profile === null || (canPickProfile && (r.profile === "" || !!profileInfo(r.profile)))));
  const agents = AGENTS.filter((a) => usable(a.id, profile));
  // The anchor rect is in screen px; `zoom` multiplies this card's own lengths (and its 360px width), so they are divided by it.
  const style = anchor ? { zoom, top: (anchor.bottom + 6) / zoom, left: Math.max(8, Math.min(anchor.left, innerWidth - 360 * zoom - 8)) / zoom, maxHeight: (innerHeight - anchor.bottom - 14) / zoom } : undefined;
  const toggle = (m: NonNullable<typeof menu>) => (o: boolean) => setMenu(o ? m : null);
  const choose =
    <V,>(set: (v: V) => void) =>
    (v: V) => {
      set(v);
      setMenu(null);
    };

  return (
    <div className={"nts-layer" + (popover ? " nts-pop" : "")}>
      <div className="nts-scrim" onClick={onClose} />
      <div ref={sheet} className="nts" role="dialog" aria-modal="true" aria-label={t("newTerminal")} style={style}>
        {!popover && <div className="nts-grab" aria-hidden="true" />}
        <h2>{t("newTerminal")}</h2>
        <div className="nts-body">
          {recents.length > 0 && (
            <div className="nts-field">
              <span className="nts-label">{t("newTermRecent")}</span>
              <div className="nts-recents">
                {recents.map((r) => (
                  <button key={`${r.cwd}|${r.cli}|${r.profile}`} type="button" className="nts-chip" onClick={() => create(r)}>
                    {agentIcon(r.cli)}
                    <span>{r.cwd ? shortCwd(r.cwd) : t("newTermStartFolder")}</span>
                    {r.profile !== null && <Dot color={profileColor(r.profile)} />}
                  </button>
                ))}
              </div>
            </div>
          )}
          <NtsMenu
            label={t("newTermFolder")}
            icon={<FolderIcon />}
            valueLabel={cwd ? shortCwd(cwd) : t("newTermStartFolder")}
            mono={!!cwd}
            value={cwd}
            options={[{ value: null, label: t("newTermStartFolder"), icon: <FolderIcon /> }, ...folders.map((f) => ({ value: f as string | null, label: shortCwd(f), icon: <FolderIcon />, mono: true }))]}
            zoom={zoom}
            open={menu === "cwd"}
            onToggle={toggle("cwd")}
            onSelect={choose(setCwd)}
          />
          {showProfiles && (
            <NtsMenu
              label={t("newTermProfile")}
              icon={profile === null ? <i className="dot" /> : <Dot color={profileColor(profile)} />}
              valueLabel={profile === null ? t("newTermProfileAuto") : profileName(profile)}
              value={profile}
              options={[
                { value: null, label: t("newTermProfileAuto"), icon: <i className="dot" /> },
                { value: "", label: t("defaultProfile"), icon: <Dot color="var(--muted)" /> },
                ...profiles.map((p) => ({ value: p.id as string | null, label: p.name, icon: <Dot color={p.color} /> })),
              ]}
              zoom={zoom}
              open={menu === "profile"}
              onToggle={toggle("profile")}
              onSelect={choose(pickProfile)}
            />
          )}
          <NtsMenu
            label={t("newTermAgent")}
            icon={agentIcon(cli)}
            valueLabel={agentName(cli)}
            value={cli}
            options={[{ value: null, label: t("newTermShell"), icon: <TerminalIcon /> }, ...agents.map((a) => ({ value: a.id as Cli | null, label: a.name, icon: <AgentLogo cli={a.id} size={18} /> }))]}
            zoom={zoom}
            hint={agents.length === 0 && profile !== null ? t("newTermNoAgent", { profile: profileName(profile) }) : undefined}
            open={menu === "agent"}
            onToggle={toggle("agent")}
            onSelect={choose(setCli)}
          />
        </div>
        <button type="button" className="btn primary big nts-go" onClick={() => create()}>
          {cli ? t("newTermOpenWith", { name: agentName(cli) }) : t("newTermOpenShell")}
        </button>
      </div>
    </div>
  );
}
