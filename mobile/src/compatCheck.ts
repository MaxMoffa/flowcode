// What the connected desktop supports. The desktop says so in `ready`
// (`appVersion`, `proto`, `caps`); one that says nothing predates the check and
// counts as protocol 1 with none of the optional features.
import type { RemoteCap } from "../../shared/remote-types";

/** The oldest desktop protocol this phone still works with; below it the app is blocked. */
export const MIN_DESKTOP_PROTO = 1;

/** What desktops that send no `caps` (0.9 / 0.10) already had: profile create/update/delete/login for non-default profiles, and the background mode. */
export const LEGACY_CAPS: string[] = ["profiles", "profileLogin", "background"];

/** Every optional feature the phone knows, and the i18n key naming it for the user. */
export const CAP_LABELS = {
  rename: "capRename",
  profiles: "capProfiles",
  profileLogin: "capProfileAgents",
  profileAgents: "capProfileAgents",
  newTabProfile: "capNewTabProfile",
  background: "capBackground",
  gemini: "capGemini",
} as const satisfies Record<RemoteCap, string>;

export interface HostInfo {
  appVersion?: string;
  proto: number;
  caps: string[];
  /** The desktop sent no version information at all. */
  legacy: boolean;
}

export type CompatLevel = "ok" | "partial" | "blocked";

export interface Compat {
  level: CompatLevel;
  /** Known features this desktop lacks, in `CAP_LABELS` order. */
  missing: RemoteCap[];
}

/** Reads the version fields of a `ready` message; absent ones mean an old desktop. */
export function hostInfoFrom(m: { appVersion?: string; proto?: number; caps?: string[] }): HostInfo {
  const legacy = m.proto === undefined && m.appVersion === undefined && m.caps === undefined;
  return { appVersion: m.appVersion, proto: typeof m.proto === "number" ? m.proto : 1, caps: Array.isArray(m.caps) ? m.caps : LEGACY_CAPS, legacy };
}

export function checkCompat(host: HostInfo | null): Compat {
  // Not known yet (not connected): nothing to say.
  if (!host) return { level: "ok", missing: [] };
  if (host.proto < MIN_DESKTOP_PROTO) return { level: "blocked", missing: [] };
  const missing = (Object.keys(CAP_LABELS) as RemoteCap[]).filter((c) => !host.caps.includes(c));
  return { level: missing.length ? "partial" : "ok", missing };
}

/** Whether a feature can be offered: true while the desktop is not known yet, so nothing flickers away. */
export function supports(host: HostInfo | null, cap: RemoteCap): boolean {
  return !host || host.caps.includes(cap);
}
