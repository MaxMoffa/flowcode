import { createStore } from "../lib/externalStore";
import { readBool, readEnum, writeBool, writeString } from "../lib/storage";

/** Where a kind of link opens: the in-app browser, the system one, or after asking. */
export type Target = "app" | "system" | "ask";
const TARGETS: readonly Target[] = ["app", "system", "ask"];

/** Whether agents may use the browser tabs: not at all, after asking, or on local pages without asking. */
type ControlMode = "off" | "ask" | "local";
type EvalMode = "never" | "local" | "ask" | "always";
type ExternalInteract = "no" | "ask" | "yes";
const CONTROL_MODES: readonly ControlMode[] = ["off", "ask", "local"];
const EVAL_MODES: readonly EvalMode[] = ["never", "local", "ask", "always"];
const EXTERNAL_INTERACT: readonly ExternalInteract[] = ["no", "ask", "yes"];

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
  /** Agent browser control (see control.ts). */
  control: ControlMode;
  eval: EvalMode;
  externalInteract: ExternalInteract;
  /** A real click or key of the user in a controlled page pauses the agent. */
  pauseOnUser: boolean;
  /** The element an agent touches is highlighted in the page. */
  highlightActions: boolean;
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
    control: readEnum(key("control"), CONTROL_MODES, "ask"),
    eval: readEnum(key("eval"), EVAL_MODES, "local"),
    externalInteract: readEnum(key("externalInteract"), EXTERNAL_INTERACT, "ask"),
    pauseOnUser: readBool(key("pauseOnUser"), true),
    highlightActions: readBool(key("highlightActions"), true),
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
