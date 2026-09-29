import { PALETTES, type PaletteVariant } from "../themes/palettes";
import { t } from "../i18n";

/** Half of a swatch: one variant's background, an "Aa" in its text colour and
 * its accent/secondary/status colours as dots. */
function SwatchHalf({ variant }: { variant: PaletteVariant }) {
  const dots = [variant.accent, variant.accent2, variant.green, variant.red, variant.blue];
  return (
    <span className="palette-half" style={{ background: variant.bg, color: variant.fg }}>
      <span className="palette-sample">Aa</span>
      <span className="palette-dots">
        {dots.map((color, i) => (
          <span key={i} className="palette-dot" style={{ background: color }} />
        ))}
      </span>
    </span>
  );
}

export function PalettePicker({
  value,
  onChange,
  ariaLabel = t("settings.palette.label"),
}: {
  value: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="palette-grid" role="radiogroup" aria-label={ariaLabel}>
      {PALETTES.map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={value === p.id}
          className={"palette-card" + (value === p.id ? " is-active" : "")}
          onClick={() => onChange(p.id)}
        >
          <span className="palette-swatch" aria-hidden="true">
            <SwatchHalf variant={p.light} />
            <SwatchHalf variant={p.dark} />
          </span>
          <span className="palette-name">{p.name}</span>
        </button>
      ))}
    </div>
  );
}
