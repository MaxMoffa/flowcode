import { createStore } from "../lib/externalStore";
import { readBool, readEnum, writeBool, writeString } from "../lib/storage";

/** Where a kind of link opens: the in-app browser, the system one, or after asking. */
export type Target = "app" | "system" | "ask";
export const TARGETS: readonly Target[] = ["app", "system", "ask"];

export interface BrowserSettings {
  /** localhost and detected dev servers. */
  local: Target;
  /** Files the agents write (html, svg, images...). */
  artifacts: Target;
  /** Everything else on the web. */
  external: Target;
  autoOpenOnServer: boolean;
  autoReloadArtifacts: boolean;
  artifactScripts: boolean;
}

const key = (field: keyof BrowserSettings) => `flowcode.browser.${field}`;

function read(): BrowserSettings {
  return {
    local: readEnum(key("local"), TARGETS, "app"),
    artifacts: readEnum(key("artifacts"), TARGETS, "app"),
    // Falls back to what the old "confirm before opening links" switch said.
    external: readEnum(key("external"), TARGETS, readBool("flowcode.confirmLinkOpen", true) ? "ask" : "system"),
    autoOpenOnServer: readBool(key("autoOpenOnServer"), false),
    autoReloadArtifacts: readBool(key("autoReloadArtifacts"), true),
    artifactScripts: readBool(key("artifactScripts"), true),
  };
}

const store = createStore<BrowserSettings>(read());

export const useBrowserSettings = store.use;
export const getBrowserSettings = store.get;

export function setBrowserSetting<K extends keyof BrowserSettings>(field: K, value: BrowserSettings[K]) {
  if (typeof value === "boolean") writeBool(key(field), value);
  else writeString(key(field), value as string);
  store.update((s) => ({ ...s, [field]: value }));
}
