import { invoke } from "@tauri-apps/api/core";
import type { PeerTab } from "./peerMessage";

/** Answers a consent card (`peer_decide`); a second answer (from the phone, the bubble) is refused and ignored. */
export function decidePeer(msgId: string, decision: "accept" | "always" | "decline") {
  invoke("peer_decide", { messageId: msgId, decision }).catch(() => {});
}

/** Brings the other side's tab forward, in whichever window shows it. */
export function openPeerTab(tab: PeerTab) {
  if (!tab.window || !tab.tabId) return;
  invoke("peer_open_tab", { window: tab.window, tabId: tab.tabId }).catch(() => {});
}
