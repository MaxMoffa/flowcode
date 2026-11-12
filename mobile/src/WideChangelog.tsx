import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { Markdown } from "../../src/changelog/markdown";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { useBackHandler, useEscape } from "./back";
import { t } from "./i18n";
import { CloseIcon } from "./icons";
import { openLink } from "./TermLink";

/** Mirrors `ReleaseNote` in mobile/src-tauri/src/updater.rs (and the desktop's). */
interface ReleaseNote {
  version: string;
  title: string;
  notes: string;
  published_at: string;
  page_url: string;
  prerelease: boolean;
}

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; releases: ReleaseNote[] };

/** Fetched once per app run - releases don't change meanwhile and GitHub
 * rate-limits anonymous calls. A failed fetch isn't kept, so a retry asks again. */
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

function formatDate(iso: string): string | null {
  const date = iso ? new Date(iso) : null;
  if (!date || isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

/** "What's new" of the tablet layout: every release on the left, the picked one's notes on the right. */
export function WideChangelog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [installed, setInstalled] = useState<string | null>(null);
  /** The release picked by the user; null = the default (installed version, else the latest). */
  const [picked, setPicked] = useState<string | null>(null);
  useBackHandler(open, onClose);
  useEscape(open, onClose);

  const reload = useCallback(() => {
    setLoad({ kind: "loading" });
    loadReleases().then(
      (releases) => setLoad({ kind: "ready", releases }),
      (e) => setLoad({ kind: "error", message: String(e) }),
    );
  }, []);
  useEffect(() => {
    if (!open) return;
    reload();
    getVersion().then(setInstalled, () => {});
  }, [open, reload]);

  const releases = load.kind === "ready" ? load.releases : [];
  const current = releases.find((r) => r.version === picked) ?? releases.find((r) => r.version === installed) ?? releases[0];

  let body;
  if (load.kind === "loading") body = <div className="wcl-status">{t("wcLoading")}</div>;
  else if (load.kind === "error")
    body = (
      <div className="wcl-status" role="alert">
        <div>{t("wcError")}</div>
        <div className="wcl-error">{load.message}</div>
        <button type="button" className="btn" onClick={reload}>
          {t("updRetry")}
        </button>
      </div>
    );
  else if (!current) body = <div className="wcl-status">{t("wcEmpty")}</div>;
  else {
    const date = formatDate(current.published_at);
    body = (
      <div className="wcl-main">
        <div className="wcl-nav" role="listbox" aria-label={t("wcTitle")}>
          {releases.map((r, i) => (
            <button key={r.version} type="button" role="option" aria-selected={r === current} className={"wcl-item" + (r === current ? " on" : "")} onClick={() => setPicked(r.version)}>
              <span className="wcl-item-top">
                <b>v{r.version}</b>
                {i === 0 && <span className="wcl-badge">{t("wcLatest")}</span>}
                {installed === r.version && <span className="wcl-badge muted">{t("wcInstalled")}</span>}
                {r.prerelease && <span className="wcl-badge muted">{t("wcPrerelease")}</span>}
              </span>
              {r.title && r.title !== r.version && r.title !== "v" + r.version && <span className="wcl-item-title">{r.title}</span>}
              {formatDate(r.published_at) && <span className="wcl-item-sub">{formatDate(r.published_at)}</span>}
            </button>
          ))}
        </div>
        <article className="wcl-notes">
          <h3>{current.title}</h3>
          <div className="wcl-meta">
            <b>v{current.version}</b>
            {date && <span>{date}</span>}
            {installed === current.version && <span className="wcl-badge">{t("wcInstalled")}</span>}
            {current.prerelease && <span className="wcl-badge muted">{t("wcPrerelease")}</span>}
          </div>
          {current.notes.trim() ? (
            <div className="upd-notes wcl-md">
              <Markdown source={current.notes.trim()} />
            </div>
          ) : (
            <p className="prof-note">{t("wcNoNotes")}</p>
          )}
          <button type="button" className="btn ghost wcl-link" onClick={() => void openLink(current.page_url)}>
            {t("wcOpenGithub")} ↗
          </button>
        </article>
      </div>
    );
  }

  return (
    <AdaptiveSheet open={open} family="nts" variant="dialog" onClose={onClose} panelClass="wcl" label={t("wcTitle")}>
      <header className="wcl-head">
        <h2>{t("wcTitle")}</h2>
        <button type="button" className="tm-btn" aria-label={t("closeViewer")} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {body}
    </AdaptiveSheet>
  );
}
