/** The kind of network (`wifi`, `cellular`...) a `NetworkInformation` reports, when it does. */
const typeOf = (connection: EventTarget | undefined): string | undefined => (connection as { type?: unknown } | undefined)?.type as string | undefined;

/** Recover from connectivity changes even while the UI still says online.
 *
 * NetworkInformation's `change` also fires whenever the WebView re-estimates
 * `rtt` / `downlink` (any sustained traffic, e.g. the dictation audio upload);
 * redialing on those tore a healthy link down mid-use. Only a change of the
 * network `type` (Wi-Fi <-> cellular) counts; without `type` the `online` event
 * and the link's own liveness check cover it. */
export function listenForNetworkRecovery(events: EventTarget, connection: EventTarget | undefined, recover: () => void): () => void {
  let active = true;
  let scheduled = false;
  let lastType = typeOf(connection);
  const changed = () => {
    if (scheduled) return;
    scheduled = true;
    // Some WebViews report both events for one change. Start only one dial.
    queueMicrotask(() => {
      scheduled = false;
      if (active) recover();
    });
  };
  const typeChanged = () => {
    const type = typeOf(connection);
    if (type === undefined || type === lastType) return;
    lastType = type;
    changed();
  };
  events.addEventListener("online", changed);
  connection?.addEventListener("change", typeChanged);
  return () => {
    active = false;
    events.removeEventListener("online", changed);
    connection?.removeEventListener("change", typeChanged);
  };
}
