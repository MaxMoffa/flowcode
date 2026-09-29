import type { ReactNode } from "react";

/** DOM id of a setting row - what a search result scrolls to. */
export const settingDomId = (id: string) => `setting-${id}`;

/** A titled card holding related setting rows. */
export function SettingsGroup({ id, title, desc, children }: { id?: string; title: string; desc?: string; children: ReactNode }) {
  return (
    <section id={id ? settingDomId(id) : undefined} className="settings-group">
      <h3 className="settings-group-title">{title}</h3>
      {desc && <p className="settings-group-desc">{desc}</p>}
      <div className="settings-card">{children}</div>
    </section>
  );
}

/** One setting: label + explanation on the left, control on the right.
 * `stacked` puts the control under the text, full width - for text inputs
 * and lists that don't fit beside it. */
export function SettingRow({
  id,
  label,
  desc,
  stacked,
  children,
}: {
  id: string;
  label: string;
  desc?: ReactNode;
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div id={settingDomId(id)} className={"settings-row" + (stacked ? " is-stacked" : "")}>
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        {desc && <p className="settings-row-desc">{desc}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

/** Mutually exclusive options as a joined button strip. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="settings-segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={"settings-segment" + (value === o.value ? " is-active" : "")}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** On/off switch with its current state spelled out next to it. */
export function Switch({
  checked,
  onChange,
  label,
  stateLabels,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  stateLabels: [on: string, off: string];
}) {
  return (
    <label className="settings-switch">
      <span className="settings-switch-state">{checked ? stateLabels[0] : stateLabels[1]}</span>
      <input type="checkbox" role="switch" checked={checked} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span className="settings-switch-track" />
    </label>
  );
}
