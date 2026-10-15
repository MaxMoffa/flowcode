/** The profile changes the phone can ask for (see docs/remote-protocol.md,
 * `profile`). The backend already checks shapes and lengths; this re-checks
 * what the desktop acts on, and is pure so it can be unit-tested. */

const PROFILE_CLIS = ["claude", "codex", "vibe"] as const;
type ProfileCli = (typeof PROFILE_CLIS)[number];

export type ProfileOp =
  | { op: "create"; name: string; color: string; copySettings: boolean }
  | { op: "update"; id: string; name: string; color: string }
  | { op: "delete"; id: string; deleteFiles: boolean }
  /** `id` null = the default profile. */
  | { op: "login"; id: string | null; cli: ProfileCli }
  | { op: "logout"; id: string | null; cli: ProfileCli };

const COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_NAME = 64;

const isStr = (v: unknown): v is string => typeof v === "string";

/** The operation in `payload`, or null when it is malformed. The name and color are re-validated by the backend (`profiles.rs`) when applied. */
export function parseProfileOp(payload: unknown): ProfileOp | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const name = isStr(p.name) ? p.name.trim() : "";
  const nameOk = name.length > 0 && name.length <= MAX_NAME;
  const colorOk = isStr(p.color) && COLOR.test(p.color);
  const id = isStr(p.id) && p.id.length > 0 && p.id.length <= MAX_NAME ? p.id : null;
  switch (p.op) {
    case "create":
      return nameOk && colorOk ? { op: "create", name, color: p.color as string, copySettings: p.copySettings !== false } : null;
    case "update":
      return id && nameOk && colorOk ? { op: "update", id, name, color: p.color as string } : null;
    case "delete":
      return id ? { op: "delete", id, deleteFiles: p.deleteFiles === true } : null;
    case "login":
    case "logout":
      // An empty id is the default profile; a malformed one is not.
      if (!(PROFILE_CLIS as readonly unknown[]).includes(p.cli) || !isStr(p.id) || p.id.length > MAX_NAME) return null;
      return { op: p.op, id: p.id === "" ? null : p.id, cli: p.cli as ProfileCli };
    default:
      return null;
  }
}
