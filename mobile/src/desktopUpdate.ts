// The desktop's own self-update, as it reports it in `update` messages.
import type { DesktopUpdate, DesktopUpdateState } from "../../shared/remote-types";

const STATES: DesktopUpdateState[] = ["idle", "checking", "upToDate", "available", "installing", "error"];
const STAGES = ["download", "verify", "install"] as const;

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Validates the untrusted `update` object: unknown state becomes "idle", strings are capped, numbers must be finite. */
export function normalizeDesktopUpdate(raw: unknown): DesktopUpdate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const state = STATES.includes(o.state as DesktopUpdateState) ? (o.state as DesktopUpdateState) : "idle";
  const stage = STAGES.find((s) => s === o.stage);
  return {
    allowed: o.allowed === true,
    state,
    version: str(o.version, 64),
    currentVersion: str(o.currentVersion, 64),
    notes: str(o.notes, 20000),
    size: num(o.size),
    stage,
    downloaded: num(o.downloaded),
    total: num(o.total),
    error: str(o.error, 500),
  };
}
