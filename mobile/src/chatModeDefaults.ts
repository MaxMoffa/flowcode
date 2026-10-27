// What a chat mode looks like (an icon family picked from well-known ids and
// names, agent-agnostic) and the per-agent default mode kept on this device.
import { safeStorage } from "./store";

export type ModeKind = "ask" | "chat" | "edit" | "plan" | "bolt" | "eye" | "wand" | "code" | "generic";

/** Warning-colored kinds: the ones that skip the agent's own checks. */
export const isRiskyKind = (k: ModeKind) => k === "bolt";

const BY_ID: Record<string, ModeKind> = {
  default: "ask",
  ask: "ask",
  manual: "ask",
  chat: "chat",
  acceptedits: "edit",
  plan: "plan",
  architect: "plan",
  bypasspermissions: "bolt",
  "full-access": "bolt",
  yolo: "bolt",
  "read-only": "eye",
  auto: "wand",
  code: "code",
};

const BY_NAME: [RegExp, ModeKind][] = [
  [/bypass|yolo|full.?access|dangerous/, "bolt"],
  [/read.?only|view/, "eye"],
  [/accept.?edit|edit/, "edit"],
  [/plan|architect/, "plan"],
  [/auto/, "wand"],
  [/code/, "code"],
  [/chat/, "chat"],
  [/ask|default|manual/, "ask"],
];

/** The icon family for a mode: its lowercase id first, then keywords in the name. */
export function modeKind(mode: { id: string; name: string }): ModeKind {
  const byId = BY_ID[mode.id.toLowerCase()];
  if (byId) return byId;
  const name = mode.name.toLowerCase();
  return BY_NAME.find(([re]) => re.test(name))?.[1] ?? "generic";
}

const key = (agent: string) => `chat.defaultMode.${agent}`;

export const getDefaultMode = (agent: string): string | null => safeStorage.get(key(agent)) || null;

/** Stores `modeId` as the agent's default; null clears it. */
export function setDefaultMode(agent: string, modeId: string | null) {
  if (modeId) safeStorage.set(key(agent), modeId);
  else safeStorage.remove(key(agent));
}

/**
 * The mode to switch a brand-new chat to, or null. New = no conversation yet
 * and no mode change seen (a resumed session replays history; a mode the user
 * already picked arrives as an event).
 */
export function defaultModeToApply(opts: { agent: string; offered: string[]; currentModeId: string | null; liveModeId: string | null; itemCount: number; loaded: boolean; ready: boolean }): string | null {
  if (!opts.ready || !opts.loaded || opts.itemCount > 0 || opts.liveModeId !== null) return null;
  const wanted = getDefaultMode(opts.agent);
  if (!wanted || wanted === opts.currentModeId || !opts.offered.includes(wanted)) return null;
  return wanted;
}
