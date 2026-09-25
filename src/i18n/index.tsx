import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readEnum, writeString } from "../lib/storage";
import { it, type MessageKey } from "./locales/it";
import { en } from "./locales/en";

export type { MessageKey } from "./locales/it";

/** Every language the UI ships in. Adding one = a new catalog under
 * ./locales (typed against `it`, so a missing key is a compile error) plus
 * an entry here. `name` is the language's own name for itself - shown as-is
 * in the settings picker whatever the current UI language is. */
export const LANGUAGES = [
  { code: "it", name: "Italiano", messages: it },
  { code: "en", name: "English", messages: en },
] as const satisfies readonly { code: string; name: string; messages: Record<MessageKey, string> }[];

export type Language = (typeof LANGUAGES)[number]["code"];
/** The stored preference - "system" follows the OS language. */
export type LanguagePreference = Language | "system";

const STORAGE_KEY = "flowcode.language";
/** Used when the OS language isn't one the UI ships in. */
const FALLBACK_LANGUAGE: Language = "en";

const CATALOGS = Object.fromEntries(LANGUAGES.map((l) => [l.code, l.messages])) as Record<Language, Record<MessageKey, string>>;
const PREFERENCES: readonly LanguagePreference[] = ["system", ...LANGUAGES.map((l) => l.code)];

function isLanguage(code: string): code is Language {
  return code in CATALOGS;
}

/** The first of the OS's preferred languages the UI ships in, matched on the
 * base tag ("it-IT" -> "it"). */
export function systemLanguage(): Language {
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of tags) {
    const base = tag?.toLowerCase().split("-")[0];
    if (base && isLanguage(base)) return base;
  }
  return FALLBACK_LANGUAGE;
}

function readPreference(): LanguagePreference {
  return readEnum<LanguagePreference>(STORAGE_KEY, PREFERENCES, "system");
}

function resolve(preference: LanguagePreference): Language {
  return preference === "system" ? systemLanguage() : preference;
}

let current: Language = resolve(readPreference());

/** The language the UI is rendered in right now. */
export function currentLanguage(): Language {
  return current;
}

/** Translates `key` into the current language, filling `{name}` placeholders
 * from `vars`. Usable outside React too (module-level helpers, text built
 * for the terminal) - but a component must read it through `useI18n()` so
 * it re-renders when the language changes. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const template = CATALOGS[current][key] ?? it[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** `key` in every shipped language - to recognize a default label stored
 * while another language was active. */
export function translationsOf(key: MessageKey): string[] {
  return LANGUAGES.map((l) => l.messages[key]);
}

/** Tells the backend which language its own user-facing messages (errors,
 * native dialogs) should use. */
function syncBackend(language: Language) {
  invoke("set_ui_language", { language }).catch(() => {});
}

interface I18nContextValue {
  t: typeof t;
  /** Resolved language - what's actually rendered, "system" included. */
  language: Language;
  /** The user's stored choice - "system" follows the OS. */
  preference: LanguagePreference;
  setPreference: (preference: LanguagePreference) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LanguagePreference>(readPreference);
  const [systemLang, setSystemLang] = useState<Language>(systemLanguage);
  const language = preference === "system" ? systemLang : preference;
  // Assigned during render, not in an effect: children read the module-level
  // `t` while rendering, and must already see the new language in the very
  // render the change triggers.
  current = language;

  useEffect(() => {
    const onChange = () => setSystemLang(systemLanguage());
    window.addEventListener("languagechange", onChange);
    // Other windows of the app share this storage - a change made in one
    // window's settings reaches every other open window too.
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setPreferenceState(readPreference());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("languagechange", onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    syncBackend(language);
  }, [language]);

  const value = useMemo<I18nContextValue>(
    () => ({
      // A fresh function per language, so memoized consumers that list `t`
      // as a dependency recompute on a language change.
      t: (key, vars) => t(key, vars),
      language,
      preference,
      setPreference: (next) => {
        writeString(STORAGE_KEY, next);
        setPreferenceState(next);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [language, preference],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Current language plus a `t` bound to it. Outside an `I18nProvider` (the
 * installer's own root) it falls back to the OS language, read once. */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  return { t, language: current, preference: "system", setPreference: () => {} };
}
