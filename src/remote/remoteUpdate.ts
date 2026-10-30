import type { UpdateStatus } from "../update/UpdateContext";

/** Mirrors `RemoteUpdate` in the phone app's protocol (see docs/remote-protocol.md). */
export interface RemoteUpdate {
  state: "idle" | "checking" | "upToDate" | "available" | "installing" | "error";
  version?: string;
  currentVersion?: string;
  notes?: string;
  size?: number;
  stage?: "download" | "verify" | "install";
  downloaded?: number;
  total?: number;
  error?: string;
}

/** Release notes sent to the phone are cut to this many characters. */
export const MAX_NOTES_CHARS = 20000;

/** Maps the desktop update status to the update state the phone shows. Pure. */
export function toRemoteUpdate(status: UpdateStatus): RemoteUpdate {
  switch (status.kind) {
    case "idle":
    case "checking":
    case "upToDate":
      return { state: status.kind };
    case "available":
      return { state: "available", ...infoFields(status.info) };
    case "installing": {
      const update: RemoteUpdate = { state: "installing", ...infoFields(status.info) };
      const p = status.progress;
      if (p?.stage === "download") Object.assign(update, { stage: "download", downloaded: p.downloaded, total: p.total });
      else if (p?.stage === "verify") update.stage = "verify";
      else if (p?.stage === "install") update.stage = "install";
      return update;
    }
    case "error":
      return { state: "error", error: status.message, ...(status.info ? infoFields(status.info) : {}) };
  }
}

function infoFields(info: { version: string; current_version: string; notes: string; size: number }) {
  const notes = info.notes.trim();
  return {
    version: info.version,
    currentVersion: info.current_version,
    ...(notes ? { notes: notes.slice(0, MAX_NOTES_CHARS) } : {}),
    size: info.size,
  };
}
