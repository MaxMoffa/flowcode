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
  notifications: (
    <>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  funzionalita: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" />,
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
