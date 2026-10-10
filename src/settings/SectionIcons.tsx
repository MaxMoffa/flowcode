import type { ReactNode } from "react";
import type { SettingsSection } from "./SettingsSectionContext";

/** 24x24 stroke glyphs, one per settings section. */
const PATHS: Record<SettingsSection, ReactNode> = {
  appearance: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />
    </>
  ),
  terminal: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="m7.5 10 3 2.5-3 2.5" />
      <path d="M13 15h3.5" />
    </>
  ),
  startup: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m10 8.5 5 3.5-5 3.5z" />
    </>
  ),
  explorer: <path d="M3.5 7.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.2h8a1.5 1.5 0 0 1 1.5 1.5v7.8a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />,
  // The same side-panel glyph as the Agents toggle in the title bar.
  agents: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M14.5 4.5v15" />
    </>
  ),
  shortcuts: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01" />
      <path d="M8 14h8" />
    </>
  ),
  funzionalita: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" />,
  profiles: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.9" r="0.6" fill="currentColor" />
    </>
  ),
};

export function SectionIcon({ section }: { section: SettingsSection }) {
  return (
    <svg className="settings-nav-item-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[section]}
    </svg>
  );
}
