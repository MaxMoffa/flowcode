import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { viewLabel } from "../agentViews/registry";
import type { AgentViewDef } from "../agentViews/types";

/** The glyph a view's card shows: built-ins have their own, plugin views a generic one. */
function viewIcon(view: AgentViewDef): ReactNode {
  const common = { viewBox: "0 0 24 24", width: 20, height: 20, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (view.id === "chat")
    return (
      <svg {...common}>
        <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
      </svg>
    );
  if (view.id === "terminal")
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 9 3 3-3 3M13 15h4" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

/** Settings' "Default view" choice: one card per agent view (built-in or
 * installed plugin) offered on this computer, as a radio group. */
export function AgentViewPicker({ views, value, onChange }: { views: readonly AgentViewDef[]; value: string; onChange: (id: string) => void }) {
  const { t, language } = useI18n();
  return (
    <div className="agent-view-picker" role="radiogroup" aria-label={t("settings.agentView.label")}>
      {views.map((view) => {
        const selected = view.id === value;
        const description = view.description ?? (view.descriptionKey ? t(view.descriptionKey) : undefined);
        return (
          <button
            key={view.id}
            type="button"
            role="radio"
            aria-checked={selected}
            className={"agent-view-card" + (selected ? " is-active" : "")}
            onClick={() => onChange(view.id)}
          >
            <span className="agent-view-card-icon">{viewIcon(view)}</span>
            <span className="agent-view-card-text">
              <span className="agent-view-card-name">
                {viewLabel(view, t, language)}
                {view.source === "plugin" && <span className="agent-view-card-badge">{t("settings.agentView.plugin")}</span>}
              </span>
              {description && <span className="agent-view-card-desc">{description}</span>}
            </span>
            <span className="agent-view-card-radio" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
