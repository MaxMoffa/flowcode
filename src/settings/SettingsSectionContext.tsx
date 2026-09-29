import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

export type SettingsSection =
  | "appearance"
  | "terminal"
  | "startup"
  | "explorer"
  | "notifications"
  | "funzionalita"
  | "info";

interface SettingsSectionValue {
  section: SettingsSection;
  setSection: (section: SettingsSection) => void;
  /** Id of a setting the page should scroll to and highlight (set by a
   * search result), or null. */
  focusId: string | null;
  goToSetting: (section: SettingsSection, id: string) => void;
  clearFocus: () => void;
}

const SettingsSectionContext = createContext<SettingsSectionValue | null>(null);

/** Shared between the settings page (main content) and its nav (the side
 * panel) - they're siblings in different slots of the layout, not parent/
 * child, so this is how clicking a nav entry switches the visible page. */
export function SettingsSectionProvider({ children }: { children: ReactNode }) {
  const [section, setSectionState] = useState<SettingsSection>("appearance");
  const [focusId, setFocusId] = useState<string | null>(null);
  const setSection = useCallback((s: SettingsSection) => {
    setFocusId(null);
    setSectionState(s);
  }, []);
  const goToSetting = useCallback((s: SettingsSection, id: string) => {
    setSectionState(s);
    setFocusId(id);
  }, []);
  const clearFocus = useCallback(() => setFocusId(null), []);
  return (
    <SettingsSectionContext.Provider value={{ section, setSection, focusId, goToSetting, clearFocus }}>
      {children}
    </SettingsSectionContext.Provider>
  );
}

export function useSettingsSection() {
  const ctx = useContext(SettingsSectionContext);
  if (!ctx) throw new Error("useSettingsSection must be used within SettingsSectionProvider");
  return ctx;
}
