import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { useI18n } from "../i18n";

/** Asks the user whether a phone presenting a valid pairing code may be
 * paired (the backend waits for the answer, see remote.rs). The backend
 * targets one window, so only that one gets the event. Renders nothing. */
export function RemotePairConfirm() {
  const confirm = useConfirmDialog();
  const { t } = useI18n();
  // The listener is registered once; keep it pointed at the latest values.
  const latest = useRef({ confirm, t });
  latest.current = { confirm, t };

  useEffect(() => {
    const unlisten = getCurrentWebviewWindow().listen<{ reqId: string; deviceName: string }>(
      "remote://pair-request",
      async (e) => {
        const { confirm, t } = latest.current;
        const accept = await confirm({
          title: t("remote.pairConfirm.title"),
          message: t("remote.pairConfirm.message", { name: e.payload.deviceName }),
          confirmLabel: t("remote.pairConfirm.accept"),
          cancelLabel: t("remote.pairConfirm.decline"),
        });
        await invoke("remote_pair_decide", { reqId: e.payload.reqId, accept }).catch(() => {});
      },
    );
    return () => {
      unlisten.then((off) => off());
    };
  }, []);

  return null;
}
