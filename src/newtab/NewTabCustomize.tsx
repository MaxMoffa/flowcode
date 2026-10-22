import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useI18n } from "../i18n";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { CloseIcon, ImageIcon } from "./icons";
import { layoutLabel, resolveNewTabLayout, useNewTabLayouts } from "./layouts";
import { clearNewTabBackgroundImage, setNewTabBackgroundImage, useNewTabBackgroundImage } from "./newTabBackground";
import { BLUR_RANGE, GRAIN_RANGE, useNewTabSettings, type NewTabBackground, type NewTabSections } from "./newTabSettings";

interface NewTabCustomizeProps {
  onClose: () => void;
}

/** The sections each built-in layout lets the user hide. A plugin layout
 * decides what it shows by itself. */
const LAYOUT_SECTIONS: Record<string, (keyof NewTabSections)[]> = {
  terminal: ["recents", "favorites"],
  glass: ["recents", "favorites", "agents"],
};

const BACKGROUNDS: NewTabBackground[] = ["theme", "solid", "image"];

/** The side panel opened by the "Personalizza" button: which layout the new
 * tab page uses, what it shows and, for "Vetro", how it looks. Every change
 * applies at once and is kept (newTabSettings.ts). */
export function NewTabCustomize({ onClose }: NewTabCustomizeProps) {
  const { t, language } = useI18n();
  const { bannerEnabled, setBannerEnabled } = useTerminalSettings();
  const [settings, update] = useNewTabSettings();
  const layouts = useNewTabLayouts();
  const image = useNewTabBackgroundImage();
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const current = resolveNewTabLayout(settings.layout);
  const sections = LAYOUT_SECTIONS[current.id] ?? [];

  useEffect(() => panelRef.current?.focus(), []);

  // Escape closes the panel wherever the focus is - the page behind it keeps
  // its own Escape (clearing its search) for when the panel is shut.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  async function pickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      await setNewTabBackgroundImage(file);
      update({ background: "image" });
    } catch (err) {
      setError(t("newTab.customize.imageFailed", { error: String(err) }));
    }
  }

  async function removeImage() {
    setError(null);
    try {
      await clearNewTabBackgroundImage();
      update({ background: "theme" });
    } catch (err) {
      setError(t("newTab.customize.imageFailed", { error: String(err) }));
    }
  }

  function pickBackground(background: NewTabBackground) {
    // An image background without an image has nothing to show: ask for one.
    if (background === "image" && !image) fileRef.current?.click();
    else update({ background });
  }

  const toggle = (label: string, checked: boolean, onChange: (checked: boolean) => void) => (
    <label className="cz-row">
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );

  return (
    <aside
      ref={panelRef}
      className="newtab-customize"
      tabIndex={-1}
      aria-label={t("newTab.customize.title")}
    >
      <header className="cz-head">
        <h2 className="cz-title">{t("newTab.customize.title")}</h2>
        <button type="button" className="cz-close" title={t("common.close")} aria-label={t("common.close")} onClick={onClose}>
          <CloseIcon size={15} />
        </button>
      </header>

      <div className="cz-body">
        <section className="cz-section">
          <h3 className="cz-heading">{t("newTab.customize.layout")}</h3>
          <div className="cz-layouts" role="radiogroup" aria-label={t("newTab.customize.layout")}>
            {layouts.map((layout) => (
              <button
                key={layout.id}
                type="button"
                role="radio"
                aria-checked={layout.id === current.id}
                className="cz-layout"
                onClick={() => update({ layout: layout.id })}
              >
                <span className={"cz-preview cz-preview-" + (layout.source === "builtin" ? layout.id : "plugin")} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  {layout.source === "plugin" && <b>{layoutLabel(layout, t, language).slice(0, 1).toUpperCase()}</b>}
                </span>
                <span className="cz-layout-name">{layoutLabel(layout, t, language)}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="cz-section">
          <h3 className="cz-heading">{t("newTab.customize.content")}</h3>
          {current.source === "plugin" ? (
            <p className="cz-note">{t("newTab.customize.pluginOwn")}</p>
          ) : (
            <>
              {sections.includes("recents") && toggle(t("newTab.recents"), settings.sections.recents, (recents) => update({ sections: { recents } }))}
              {sections.includes("favorites") && toggle(t("favorites.title"), settings.sections.favorites, (favorites) => update({ sections: { favorites } }))}
              {sections.includes("agents") && toggle(t("newTab.glass.agents"), settings.sections.agents, (agents) => update({ sections: { agents } }))}
              {/* The terminal's own banner: the hand-off to the terminal needs the page to draw the same one. */}
              {current.id === "terminal" && toggle(t("newTab.customize.banner"), bannerEnabled, setBannerEnabled)}
            </>
          )}
        </section>

        {current.id === "glass" && (
          <section className="cz-section">
            <h3 className="cz-heading">{t("newTab.customize.background")}</h3>
            <div className="cz-segmented" role="radiogroup" aria-label={t("newTab.customize.background")}>
              {BACKGROUNDS.map((background) => (
                <button
                  key={background}
                  type="button"
                  role="radio"
                  aria-checked={settings.background === background}
                  className="cz-segment"
                  onClick={() => pickBackground(background)}
                >
                  {t(`newTab.customize.bg.${background}`)}
                </button>
              ))}
            </div>
            {settings.background === "image" && (
              <div className="cz-image">
                {image && <img className="cz-image-thumb" src={image} alt="" />}
                <button type="button" className="cz-button" onClick={() => fileRef.current?.click()}>
                  <ImageIcon size={14} />
                  {t("newTab.customize.pickImage")}
                </button>
                {image && (
                  <button type="button" className="cz-button" onClick={() => void removeImage()}>
                    {t("newTab.customize.removeImage")}
                  </button>
                )}
              </div>
            )}
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void pickImage(e)} />
            {error && <p className="cz-error">{error}</p>}

            <label className="cz-slider">
              <span>{t("newTab.customize.grain")}</span>
              <input type="range" {...GRAIN_RANGE} value={settings.grain} onChange={(e) => update({ grain: Number(e.target.value) })} />
              <output>{Math.round(settings.grain * 100)}%</output>
            </label>
            <label className="cz-slider">
              <span>{t("newTab.customize.blur")}</span>
              <input type="range" {...BLUR_RANGE} value={settings.blur} onChange={(e) => update({ blur: Number(e.target.value) })} />
              <output>{settings.blur}px</output>
            </label>
          </section>
        )}
      </div>
    </aside>
  );
}
