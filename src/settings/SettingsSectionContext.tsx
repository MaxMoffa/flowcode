import { createContext, useContext, useState, type ReactNode } from "react";

export type SettingsSection = "generale" | "terminale" | "funzionalita" | "info";

interface SettingsSectionValue {
  section: SettingsSection;
  setSection: (section: SettingsSection) => void;
}

const SettingsSectionContext = createContext<SettingsSectionValue | null>(null);

/** Shared between the settings page (main content) and its nav (the side
 * panel) - they're siblings in different slots of the layout, not parent/
 * child, so this is how clicking a nav entry switches the visible page. */
export function SettingsSectionProvider({ children }: { children: ReactNode }) {
  const [section, setSection] = useState<SettingsSection>("generale");
  return <SettingsSectionContext.Provider value={{ section, setSection }}>{children}</SettingsSectionContext.Provider>;
}

export function useSettingsSection() {
  const ctx = useContext(SettingsSectionContext);
  if (!ctx) throw new Error("useSettingsSection must be used within SettingsSectionProvider");
  return ctx;
}
