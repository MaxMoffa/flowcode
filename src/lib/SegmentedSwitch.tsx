import "./segmented-switch.css";

export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
  title?: string;
  /** Small pill after the label; hidden when empty or 0. */
  count?: number | string;
}

interface SegmentedSwitchProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  /** When set, tabs get `${idPrefix}-tab-${id}` ids and `aria-controls`
   * `${idPrefix}-panel-${id}` so they wire up to their tabpanels. */
  idPrefix?: string;
}

/** Two-or-more option pill switch for a panel header (Explorer/Git,
 * project/all agents): a tablist with roving tabindex and arrow-key moves. */
export function SegmentedSwitch<T extends string>({ options, value, onChange, ariaLabel, idPrefix }: SegmentedSwitchProps<T>) {
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = options.findIndex((o) => o.id === value);
    const next = options[(i + (e.key === "ArrowRight" ? 1 : options.length - 1)) % options.length];
    onChange(next.id);
    if (idPrefix) document.getElementById(`${idPrefix}-tab-${next.id}`)?.focus();
  }

  return (
    <div className="segmented-switch" role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          id={idPrefix ? `${idPrefix}-tab-${o.id}` : undefined}
          aria-selected={value === o.id}
          aria-controls={idPrefix ? `${idPrefix}-panel-${o.id}` : undefined}
          tabIndex={value === o.id ? 0 : -1}
          className={"segmented-switch-option" + (value === o.id ? " is-selected" : "")}
          title={o.title}
          onClick={() => onChange(o.id)}
        >
          <span className="segmented-switch-text">{o.label}</span>
          {o.count !== undefined && o.count !== 0 && o.count !== "" && <span className="agents-sidebar-scope-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
