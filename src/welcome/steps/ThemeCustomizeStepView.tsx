import { resolveContentText } from "@flowkit-io/core";
import { registerStepComponent, type StepComponentProps } from "@flowkit-io/react";
import { useI18n } from "../../i18n";
import { useTheme } from "../../themes/ThemeContext";
import { PALETTES, type PaletteVariant } from "../../themes/palettes";
import "./theme-customize.css";
import type { ThemeCustomizeStep } from "./themeCustomizeStepType";

/** Same slot flowkit's own steps use for the title icon (`.fk-title-icon`). */
function TitleIcon({ image }: { image: ThemeCustomizeStep["image"] }) {
  if (!image) return null;
  if (image.kind === "image") {
    return (
      <span className="fk-title-icon">
        <img src={image.value} alt="" />
      </span>
    );
  }
  return <span className="fk-title-icon">{image.value}</span>;
}

/** One variant of a palette as a tiny terminal: a prompt line in its accent,
 * a muted line, and its accent and status colours as dots. */
function Preview({ variant }: { variant: PaletteVariant }) {
  const dots = [variant.accent, variant.accent2, variant.green, variant.red, variant.blue];
  return (
    <span className="theme-preview" style={{ background: variant.bg, color: variant.fg }}>
      <span className="theme-preview-line">
        <span style={{ color: variant.accent }}>❯</span> ls
      </span>
      <span className="theme-preview-line" style={{ color: variant.fgMuted }}>
        src docs
      </span>
      <span className="theme-preview-dots">
        {dots.map((color, i) => (
          <span key={i} className="theme-preview-dot" style={{ background: color }} />
        ))}
      </span>
    </span>
  );
}

/** Colour palette picker, applied live through the same theme store the
 * Settings page uses: every pick shows at once, in the app behind and in this
 * dialog's own colours (WelcomeFlow rebuilds the flow theme from the palette). */
function ThemeCustomizeStepView({ step, flow }: StepComponentProps<ThemeCustomizeStep>) {
  const { t } = useI18n();
  const { paletteId, setPaletteId } = useTheme();
  const title = step.title !== undefined ? resolveContentText(flow, step.title) : undefined;
  const subtitle = step.subtitle !== undefined ? resolveContentText(flow, step.subtitle) : undefined;

  return (
    <div className="fk-step fk-step-theme-customize">
      {(step.image || title) && (
        <h2 className="fk-title">
          <TitleIcon image={step.image} />
          {title}
        </h2>
      )}
      {subtitle && <p className="fk-subtitle">{subtitle}</p>}

      <div className="theme-grid" role="radiogroup" aria-label={t("settings.palette.label")}>
        {PALETTES.map((p) => {
          const active = p.id === paletteId;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              className={"theme-card" + (active ? " is-active" : "")}
              onClick={() => setPaletteId(p.id)}
            >
              <span className="theme-card-swatch" aria-hidden="true">
                <Preview variant={p.light} />
                <Preview variant={p.dark} />
              </span>
              <span className="theme-card-foot">
                <span className="theme-card-name">{p.name}</span>
                <span className="theme-card-check" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m5 12.5 4.5 4.5L19 7.5" />
                  </svg>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

registerStepComponent<ThemeCustomizeStep>("themeCustomize", ThemeCustomizeStepView);
