import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { useI18n } from "../i18n";
import { PluginToast } from "../plugins/PluginToast";

const NOTICE_MS = 3500;

/** Asks the user whether a phone presenting a valid pairing code may be
 * paired (the backend waits for the answer, see remote.rs). The backend
 * targets one window, so only that one gets the event. The dialog shows the
 * phone's fingerprint to compare with what the phone displays, and goes away
 * on its own if the backend gives up on the request. */
export function RemotePairConfirm() {
  const confirm = useConfirmDialog();
  const { t } = useI18n();
  const [notice, setNotice] = useState<string | null>(null);
  // The listeners are registered once; keep them pointed at the latest values.
  const latest = useRef({ confirm, t });
  latest.current = { confirm, t };

  useEffect(() => {
    const pending = new Map<string, AbortController>();
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    const win = getCurrentWebviewWindow();
    const unlistenRequest = win.listen<{ reqId: string; deviceName: string; fingerprint?: string }>(
      "remote://pair-request",
      async (e) => {
        const { reqId, deviceName, fingerprint } = e.payload;
        const { confirm, t } = latest.current;
        const abort = new AbortController();
        pending.set(reqId, abort);
        const accept = await confirm({
          title: t("remote.pairConfirm.title"),
          message:
            t("remote.pairConfirm.message", { name: deviceName }) +
            (fingerprint ? "\n\n" + t("remote.pairConfirm.fingerprint", { code: fingerprint }) : ""),
          confirmLabel: t("remote.pairConfirm.accept"),
          cancelLabel: t("remote.pairConfirm.decline"),
          signal: abort.signal,
        });
        pending.delete(reqId);
        // Expired on the backend's side: nobody is waiting for an answer.
        if (abort.signal.aborted) return;
        await invoke("remote_pair_decide", { reqId, accept }).catch(() => {});
      },
    );
    const unlistenCancel = win.listen<{ reqId: string }>("remote://pair-cancel", (e) => {
      const abort = pending.get(e.payload.reqId);
      if (!abort) return;
      abort.abort();
      pending.delete(e.payload.reqId);
      setNotice(latest.current.t("remote.pairConfirm.expired"));
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => setNotice(null), NOTICE_MS);
    });
    return () => {
      clearTimeout(noticeTimer);
      pending.forEach((a) => a.abort());
      pending.clear();
      unlistenRequest.then((off) => off());
      unlistenCancel.then((off) => off());
    };
  }, []);

  return notice ? <PluginToast message={notice} /> : null;
}
