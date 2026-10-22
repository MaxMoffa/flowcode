import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ViewPluginManifest } from "../../shared/agentViewBridge";
import type { NewTabPluginManifest } from "../../shared/newTabBridge";
import { loadPluginViews } from "../agentViews/pluginViews";
import { loadPluginNewTabs } from "../newtab/pluginLayouts";
import { useI18n, type MessageKey } from "../i18n";
import "./funzionalita-page.css";

/** The rejection `view_plugin_install` answers when the id is taken. */
const EXISTS_PREFIX = "exists:";
const READ_CHUNK = 0x8000;

/** A file's bytes as base64 - in chunks, a spread of a big file overflows the stack. */
async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += READ_CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + READ_CHUNK));
  return btoa(binary);
}

/** An installed plugin of either kind, as `view_plugins_list` answers. */
type InstalledPlugin = ViewPluginManifest | NewTabPluginManifest;

/** The fields of a picked folder's manifest the confirmation shows; the
 * backend validates the rest. */
function readManifest(text: string): Partial<InstalledPlugin> | null {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") return null;
  const m = parsed as Partial<InstalledPlugin>;
  return typeof m.id === "string" && typeof m.label === "string" ? m : null;
}

/** "Viste e pagine" in Settings > Funzionalita: the installed agent view and
 * new tab page plugins, and installing one from a folder (see PLUGINS.md). */
export function AgentViewsSection() {
  const { t, language } = useI18n();
  const [views, setViews] = useState<InstalledPlugin[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setViews(await invoke<InstalledPlugin[]>("view_plugins_list"));
    } catch (err) {
      setError(t("features.views.readFailed", { error: String(err) }));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** The registries follow the folder: views and layouts are (un)registered right away. */
  async function reload(reinstalled?: string) {
    await Promise.all([loadPluginViews(reinstalled), loadPluginNewTabs(reinstalled)]).catch(() => {});
    await refresh();
  }

  async function handleInstall(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (picked.length === 0) return;
    setError(null);
    try {
      // Paths relative to the picked folder, which is the first segment of each.
      const entries = picked.map((file) => ({ file, path: file.webkitRelativePath.split("/").slice(1).join("/") }));
      const folder = picked[0].webkitRelativePath.split("/")[0];
      const manifestEntry = entries.find((entry) => entry.path === "manifest.json");
      const manifest = manifestEntry && readManifest(await manifestEntry.file.text());
      if (!manifest) {
        setError(t("features.views.invalid", { name: folder }));
        return;
      }
      const permissions = (manifest.permissions ?? []).map((p) => t(`features.views.perm.${p}` as MessageKey)).join(", ");
      const newTab = manifest.kind === "newTab";
      const accepted = window.confirm(
        t(newTab ? "features.views.confirmNewTab" : "features.views.confirm", {
          name: manifest.label ?? "",
          author: manifest.author ?? t("features.views.unknown"),
          version: manifest.version ?? t("features.views.unknown"),
          permissions: permissions || t("features.views.none"),
          warning: t(newTab ? "features.views.warningNewTab" : "features.views.warning"),
        }),
      );
      if (!accepted) return;
      const files = await Promise.all(entries.map(async ({ file, path }) => ({ path, data: await toBase64(file) })));
      try {
        await invoke("view_plugin_install", { files, overwrite: false });
      } catch (err) {
        const message = String(err);
        if (!message.startsWith(EXISTS_PREFIX)) throw err;
        if (!window.confirm(t("features.views.overwrite", { id: message.slice(EXISTS_PREFIX.length) }))) return;
        await invoke("view_plugin_install", { files, overwrite: true });
      }
      await reload(manifest.id);
    } catch (err) {
      setError(t("features.views.installFailed", { error: String(err) }));
    }
  }

  async function handleDelete(view: InstalledPlugin) {
    const name = view.labels?.[language] ?? view.label;
    if (!window.confirm(t("features.views.deleteConfirm", { name }))) return;
    try {
      await invoke("view_plugin_delete", { id: view.id });
      await reload();
    } catch (err) {
      setError(t("features.views.deleteFailed", { error: String(err) }));
    }
  }

  const [introBefore, introAfter] = t("features.views.intro").split("{file}");

  return (
    <section className="funzionalita-views">
      <h3 className="funzionalita-views-title">{t("features.views.title")}</h3>
      <p className="funzionalita-intro">
        {introBefore}
        <code>PLUGINS.md</code>
        {introAfter}
      </p>

      {views.length === 0 ? (
        <p className="funzionalita-view-empty">{t("features.views.empty")}</p>
      ) : (
        <div className="funzionalita-view-list">
          {views.map((view) => {
            const name = view.labels?.[language] ?? view.label;
            return (
              <div key={view.id} className="funzionalita-view">
                <div className="funzionalita-view-main">
                  <div className="funzionalita-name">
                    {name}
                    <span className="funzionalita-chip">{t(`features.views.kind.${view.kind}` as MessageKey)}</span>
                    <span className="funzionalita-view-meta">
                      {[view.version && `v${view.version}`, view.author && t("features.views.by", { author: view.author })].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  {view.description && <div className="funzionalita-desc">{view.description}</div>}
                  <div className="funzionalita-chips">
                    {view.permissions.length === 0 && <span className="funzionalita-chip">{t("features.views.noPermissions")}</span>}
                    {view.permissions.map((p) => (
                      <span key={p} className="funzionalita-chip">
                        {t(`features.views.perm.${p}` as MessageKey)}
                      </span>
                    ))}
                    {view.devices.map((d) => (
                      <span key={d} className="funzionalita-chip">
                        {t(`features.views.device.${d}` as MessageKey)}
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  className="funzionalita-delete"
                  aria-label={t("features.views.deleteNamed", { name })}
                  title={t("common.delete")}
                  onClick={() => void handleDelete(view)}
                >
                  <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" stroke="currentColor" fill="none">
                    <path d="M5 7.5h14" />
                    <path d="M9.5 7.5V5.6c0-.6.4-1 1-1h3c.6 0 1 .4 1 1v1.9" />
                    <path d="M7 7.5 7.7 19a1.3 1.3 0 0 0 1.3 1.3h6a1.3 1.3 0 0 0 1.3-1.3l.7-11.5" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="funzionalita-toolbar">
        <button type="button" className="settings-choice" onClick={() => inputRef.current?.click()}>
          {t("features.views.install")}
        </button>
        <input ref={inputRef} type="file" hidden multiple {...{ webkitdirectory: "" }} onChange={(e) => void handleInstall(e)} />
      </div>
      {error && <p className="funzionalita-import-error">{error}</p>}
    </section>
  );
}
