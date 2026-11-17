import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { browserTabsSnapshot, closePage, goBack, goForward, navigatePage, openFileFromRemote, openUrlFromRemote, useBrowser } from "../browser/browserStore";
import { isRemoteLeader, useRemoteLeader } from "./leader";
import type { BrowserOpEvent } from "../../shared/remote-types";

/** Browser tab changes are coalesced: navigation and dev-server detection fire in bursts. */
const PUBLISH_DELAY_MS = 150;

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** A `remote://browser-op` payload, or null when malformed. */
function parseBrowserOp(payload: unknown): BrowserOpEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  switch (p.op) {
    case "openUrl":
      return isStr(p.url) && isStr(p.nonce) ? { op: "openUrl", url: p.url, nonce: p.nonce } : null;
    case "openFile":
      return isStr(p.path) && isStr(p.nonce) ? { op: "openFile", path: p.path, nonce: p.nonce } : null;
    case "close":
    case "back":
    case "forward":
      return isStr(p.id) ? { op: p.op, id: p.id } : null;
    case "navigate":
      return isStr(p.id) && isStr(p.url) ? { op: "navigate", id: p.id, url: p.url } : null;
    default:
      return null;
  }
}

/** Mirrors the desktop browser's tabs to the phone and applies the changes the phone asks for.
 * Only the leader window does either (see leader.ts). Renders nothing. */
export function RemoteBrowserBridge() {
  const leader = useRemoteLeader();
  const state = useBrowser();
  const lastSent = useRef<string | null>(null);

  useEffect(() => {
    if (!leader) {
      lastSent.current = null; // a new leader term starts from a clean slate
      return;
    }
    const json = JSON.stringify(browserTabsSnapshot(state));
    const timer = setTimeout(() => {
      if (!isRemoteLeader() || json === lastSent.current) return;
      lastSent.current = json;
      void invoke("remote_publish_browser_tabs", { tabs: JSON.parse(json) }).catch(() => {
        lastSent.current = null;
      });
    }, PUBLISH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state, leader]);

  useEffect(() => {
    const unlisten = listen<unknown>("remote://browser-op", (e) => {
      if (!isRemoteLeader()) return;
      const op = parseBrowserOp(e.payload);
      if (!op) return;
      switch (op.op) {
        case "openUrl":
          openUrlFromRemote(op.url, op.nonce);
          break;
        case "openFile":
          openFileFromRemote(op.path, op.nonce);
          break;
        case "close":
          closePage(op.id);
          break;
        case "back":
          goBack(op.id);
          break;
        case "forward":
          goForward(op.id);
          break;
        case "navigate":
          navigatePage(op.id, op.url);
          break;
      }
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  return null;
}
