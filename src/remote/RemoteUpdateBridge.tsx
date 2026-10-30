import { useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useUpdater } from "../update/UpdateContext";
import { isRemoteLeader, useRemoteLeader } from "./leader";
import { toRemoteUpdate, type RemoteUpdate } from "./remoteUpdate";

/** Progress updates reach the phone at most this often; a change of state is sent at once. */
const PROGRESS_INTERVAL_MS = 250;

/** Mirrors the desktop update state to the phone and runs the phone's check and install
 * requests. Only the leader window does either (see leader.ts). Renders nothing. */
export function RemoteUpdateBridge() {
  const { status, check, install } = useUpdater();
  const leader = useRemoteLeader();
  const update = useMemo(() => toRemoteUpdate(status), [status]);

  const published = useRef<{ json: string; state: RemoteUpdate["state"]; at: number } | null>(null);
  useEffect(() => {
    if (!leader) {
      published.current = null;
      return;
    }
    const json = JSON.stringify(update);
    const last = published.current;
    if (last?.json === json) return;
    // A new state goes out at once; progress within one state is throttled.
    const wait = !last || last.state !== update.state ? 0 : Math.max(0, PROGRESS_INTERVAL_MS - (Date.now() - last.at));
    const timer = setTimeout(() => {
      if (!isRemoteLeader()) return;
      published.current = { json, state: update.state, at: Date.now() };
      invoke("remote_publish_update", { update }).catch(() => {});
    }, wait);
    return () => clearTimeout(timer);
  }, [update, leader]);

  // Callbacks are stable, so the listeners are registered once per leader change.
  useEffect(() => {
    if (!leader) return;
    const unlistenCheck = listen("remote://update-check", () => {
      void check(false, true);
    });
    const unlistenInstall = listen("remote://update-install", () => {
      install();
    });
    return () => {
      unlistenCheck.then((fn) => fn()).catch(() => {});
      unlistenInstall.then((fn) => fn()).catch(() => {});
    };
  }, [leader, check, install]);

  return null;
}
