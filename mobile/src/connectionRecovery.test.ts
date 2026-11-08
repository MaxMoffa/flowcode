import { describe, expect, it, vi } from "vitest";
import { listenForNetworkRecovery } from "./connectionRecovery";

describe("network recovery", () => {
  it("recovers on network-online and on Wi-Fi/cellular changes without an offline event", async () => {
    const events = new EventTarget();
    const connection = new EventTarget();
    const recover = vi.fn();
    const off = listenForNetworkRecovery(events, connection, recover);
    events.dispatchEvent(new Event("online"));
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(1);
    connection.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(2);
    off();
  });

  it("coalesces duplicate events and cancels queued recovery when listeners are removed", async () => {
    const events = new EventTarget();
    const connection = new EventTarget();
    const recover = vi.fn();
    const off = listenForNetworkRecovery(events, connection, recover);
    events.dispatchEvent(new Event("online"));
    connection.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(1);
    events.dispatchEvent(new Event("online"));
    off();
    await Promise.resolve();
    events.dispatchEvent(new Event("online"));
    connection.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("supports WebViews without NetworkInformation", async () => {
    const events = new EventTarget();
    const recover = vi.fn();
    const off = listenForNetworkRecovery(events, undefined, recover);
    events.dispatchEvent(new Event("offline"));
    await Promise.resolve();
    expect(recover).not.toHaveBeenCalled();
    events.dispatchEvent(new Event("online"));
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(1);
    off();
  });
});
