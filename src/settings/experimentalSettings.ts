import { createStore } from "../lib/externalStore";
import { readBool, writeBool } from "../lib/storage";

const ACP_V2_KEY = "flowcode.experimental.acpV2";

interface ExperimentalSettings {
  /** ACP v2 wire protocol for Claude and Codex chats, read once per agent start. */
  acpV2: boolean;
}

const store = createStore<ExperimentalSettings>({
  acpV2: readBool(ACP_V2_KEY, false),
});

export const getExperimentalSettings = store.get;
export const useExperimentalSettings = store.use;

export function setAcpV2(enabled: boolean) {
  if (store.get().acpV2 === enabled) return;
  writeBool(ACP_V2_KEY, enabled);
  store.update((s) => ({ ...s, acpV2: enabled }));
}
