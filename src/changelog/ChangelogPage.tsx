import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { useI18n } from "../i18n";
import { ExternalLink, Markdown } from "./markdown";
import "../settings/settings-page.css";
import "../settings/settings-nav.css";
import "./changelog.css";

/** Mirrors `ReleaseNote` in src-tauri/src/updater.rs. */
interface ReleaseNote {
  version: string;
  title: string;
  notes: string;
  published_at: string;
  page_url: string;
  prerelease: boolean;
}

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; releases: ReleaseNote[] };

/** Fetched once per app run and shared by every tab opened after - releases
 * don't change while the app is open, and GitHub rate-limits anonymous API
 * calls. A failed fetch isn't kept, so a retry really asks again. */
let cached: Promise<ReleaseNote[]> | null = null;
function loadReleases(): Promise<ReleaseNote[]> {
  if (!cached) {
    cached = invoke<ReleaseNote[]>("release_notes");
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}

function useReleases() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const reload = useCallback(() => {
    setLoad({ kind: "loading" });
    loadReleases().then(
      (releases) => setLoad({ kind: "ready", releases }),
      (e) => setLoad({ kind: "error", message: String(e) }),
    );
  }, []);
  return { load, reload };
}

/** Which tab a nav/page pair belongs to - each keeps its own pick. */
export type ChangelogView = "changelog" | "whatsNew";

interface ChangelogValue {
  load: Load;
  reload: () => void;
  /** The release each view shows; `null` = its default (the latest for the
   * changelog, the version just installed for What's new). */
  selected: Record<ChangelogView, string | null>;
  select: (view: ChangelogView, version: string | null) => void;
  installed: string | null;
  /** Starts the fetch - called by the page/nav once one is shown, so the
   * provider wrapping the whole app never hits GitHub on its own. */
  activate: () => void;
}

const ChangelogCtx = createContext<ChangelogValue | null>(null);

/** Shared between the changelog page (main content) and its version list
 * (the side panel) - siblings in different slots of the layout, like the
 * settings page and SettingsNav. */
export function ChangelogProvider({ children }: { children: ReactNode }) {
  const { load, reload } = useReleases();
  const [selected, setSelected] = useState<Record<ChangelogView, string | null>>({ changelog: null, whatsNew: null });
  const select = useCallback(
    (view: ChangelogView, version: string | null) => setSelected((prev) => ({ ...prev, [view]: version })),
    [],
  );
  const [installed, setInstalled] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const activate = useCallback(() => setActive(true), []);

  useEffect(() => {
    if (!active) return;
    reload();
    getVersion().then(setInstalled, () => {});
  }, [active, reload]);

  const value = useMemo(
    () => ({ load, reload, selected, select, installed, activate }),
    [load, reload, selected, select, installed, activate],
  );
  return <ChangelogCtx.Provider value={value}>{children}</ChangelogCtx.Provider>;
}

function useChangelog(): ChangelogValue {
  const ctx = useContext(ChangelogCtx);
  if (!ctx) throw new Error("useChangelog must be used within ChangelogProvider");
  const { activate } = ctx;
  useEffect(activate, [activate]);
  return ctx;
}

/** The side panel while the changelog or What's new tab is active: every
 * release, newest first - picking one shows its notes in that tab's page.
 * `defaultVersion` is what the page shows until something is picked (the
 * latest release when omitted). */
export function ChangelogNav({ view, defaultVersion }: { view: ChangelogView; defaultVersion?: string }) {
  const { t, language } = useI18n();
  const { load, selected, select, installed } = useChangelog();
  const releases = load.kind === "ready" ? load.releases : [];
  const fallback = defaultVersion ?? releases[0]?.version;
  const current = selected[view] ?? fallback;

  return (
    <div className="settings-nav">
      <div className="settings-nav-header">{view === "whatsNew" ? t("whatsNew.title") : t("changelog.title")}</div>
      <div className="settings-nav-list changelog-nav-list">
        {load.kind === "loading" && <div className="changelog-nav-status">{t("common.loading")}</div>}
        {releases.map((r, i) => (
          <button
            key={r.version}
            type="button"
            className={"settings-nav-item changelog-nav-item" + (current === r.version ? " is-active" : "")}
            onClick={() => select(view, r.version === fallback ? null : r.version)}
            title={r.title}
          >
            <span className="changelog-nav-top">
              <span className="changelog-version">v{r.version}</span>
              {i === 0 && <span className="changelog-badge">{t("changelog.latestShort")}</span>}
              {installed === r.version && i !== 0 && <span className="changelog-badge is-muted">{t("changelog.installed")}</span>}
            </span>
            <span className="changelog-nav-sub">{formatDate(r.published_at, language) ?? r.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The "Changelog" tab: the release picked in ChangelogNav - the latest one
 * until another is picked - with its full notes. */
export function ChangelogPage() {
  const { t } = useI18n();
  const { load, reload, selected, installed } = useChangelog();

  let body;
  if (load.kind !== "ready") {
    body = <LoadStatus load={load} reload={reload} />;
  } else if (load.releases.length === 0) {
    body = <div className="changelog-status">{t("changelog.empty")}</div>;
  } else {
    const release = load.releases.find((r) => r.version === selected.changelog) ?? load.releases[0];
    const isLatest = release === load.releases[0];
    body = (
      <article className="changelog-hero">
        <div className="changelog-hero-kicker">{isLatest ? t("changelog.latest") : t("changelog.previousOne")}</div>
        <ReleaseHeader release={release} installed={installed} />
        <ReleaseNotes release={release} />
      </article>
    );
  }

  return (
    <div className="settings-page changelog-page">
      <div className="settings-page-inner">
        <h1 className="settings-title">{t("changelog.title")}</h1>
        <p className="settings-page-desc">{t("changelog.desc")}</p>
        {body}
      </div>
    </div>
  );
}

/** The "What's new" tab opened after an update: `version`'s notes, the
 * other releases one click away in ChangelogNav. */
export function WhatsNewPage({ version, onOpenChangelog }: { version: string; onOpenChangelog: () => void }) {
  const { t } = useI18n();
  const { load, reload, selected, installed } = useChangelog();
  const shown = selected.whatsNew ?? version;

  const release = load.kind === "ready" ? load.releases.find((r) => r.version === shown) : undefined;
  let body;
  if (load.kind !== "ready") {
    body = <LoadStatus load={load} reload={reload} />;
  } else if (!release) {
    body = <div className="changelog-status">{t("whatsNew.notFound")}</div>;
  } else {
    const kicker =
      release.version === version
        ? t("whatsNew.kicker", { version })
        : release === load.releases[0]
          ? t("changelog.latest")
          : t("changelog.previousOne");
    body = (
      <article className="changelog-hero">
        <div className="changelog-hero-kicker">{kicker}</div>
        <ReleaseHeader release={release} installed={installed ?? version} />
        <ReleaseNotes release={release} />
      </article>
    );
  }

  return (
    <div className="settings-page changelog-page">
      <div className="settings-page-inner">
        <h1 className="settings-title">{t("whatsNew.title")}</h1>
        {body}
        <button type="button" className="changelog-button changelog-full" onClick={onOpenChangelog}>
          {t("whatsNew.fullChangelog")} →
        </button>
      </div>
    </div>
  );
}

function LoadStatus({ load, reload }: { load: Load; reload: () => void }) {
  const { t } = useI18n();
  if (load.kind !== "error") return <div className="changelog-status">{t("common.loading")}</div>;
  return (
    <div className="changelog-status">
      <div>{t("changelog.error")}</div>
      <div className="changelog-error">{load.message}</div>
      <button type="button" className="changelog-button" onClick={reload}>
        {t("update.retry")}
      </button>
    </div>
  );
}

function formatDate(iso: string, language: string): string | null {
  const date = iso ? new Date(iso) : null;
  if (!date || isNaN(date.getTime())) return null;
  return date.toLocaleDateString(language, { day: "numeric", month: "long", year: "numeric" });
}

function ReleaseHeader({ release, installed }: { release: ReleaseNote; installed: string | null }) {
  const { t, language } = useI18n();
  const date = formatDate(release.published_at, language);
  return (
    <div className="changelog-head">
      <div className="changelog-head-title">{release.title}</div>
      <div className="changelog-head-meta">
        <span className="changelog-version">v{release.version}</span>
        {date && <span>{date}</span>}
        {installed === release.version && <span className="changelog-badge">{t("changelog.installed")}</span>}
        {release.prerelease && <span className="changelog-badge is-muted">{t("changelog.prerelease")}</span>}
      </div>
    </div>
  );
}

function ReleaseNotes({ release }: { release: ReleaseNote }) {
  const { t } = useI18n();
  return (
    <>
      {release.notes.trim() ? <Markdown source={release.notes} /> : <p className="changelog-empty-notes">{t("changelog.noNotes")}</p>}
      <div className="changelog-link">
        <ExternalLink href={release.page_url}>{t("changelog.openOnGithub")} ↗</ExternalLink>
      </div>
    </>
  );
}
