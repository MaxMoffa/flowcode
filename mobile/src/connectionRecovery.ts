/** Recover from connectivity changes even while the UI still says online. */
export function listenForNetworkRecovery(events: EventTarget, connection: EventTarget | undefined, recover: () => void): () => void {
  let active = true;
  let scheduled = false;
  const changed = () => {
    if (scheduled) return;
    scheduled = true;
    // Some WebViews report both events for one change. Start only one dial.
    queueMicrotask(() => {
      scheduled = false;
      if (active) recover();
    });
  };
  events.addEventListener("online", changed);
  connection?.addEventListener("change", changed);
  return () => {
    active = false;
    events.removeEventListener("online", changed);
    connection?.removeEventListener("change", changed);
  };
}
