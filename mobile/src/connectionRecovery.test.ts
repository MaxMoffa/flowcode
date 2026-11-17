import { describe, expect, it, vi } from "vitest";
import { listenForNetworkRecovery } from "./connectionRecovery";

/** A NetworkInformation stand-in whose `type` can be switched. */
function fakeConnection(type?: string) {
  const target = new EventTarget() as EventTarget & { type?: string };
  target.type = type;
  return target;
}

describe("network recovery", () => {
  it("recovers on network-online and on Wi-Fi/cellular changes without an offline event", async () => {
    const events = new EventTarget();
    const connection = fakeConnection("wifi");
    const recover = vi.fn();
    const off = listenForNetworkRecovery(events, connection, recover);
    events.dispatchEvent(new Event("online"));
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(1);
    connection.type = "cellular";
    connection.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(2);
    off();
  });

  it("ignores changes that only re-estimate rtt or bandwidth", async () => {
    const events = new EventTarget();
    const connection = fakeConnection("wifi");
    const recover = vi.fn();
    const off = listenForNetworkRecovery(events, connection, recover);
    connection.dispatchEvent(new Event("change"));
    connection.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(recover).not.toHaveBeenCalled();
    // Without a `type` at all, `change` says nothing reliable either.
    const typeless = fakeConnection();
    const off2 = listenForNetworkRecovery(events, typeless, recover);
    typeless.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(recover).not.toHaveBeenCalled();
    off();
    off2();
  });

  it("coalesces duplicate events and cancels queued recovery when listeners are removed", async () => {
    const events = new EventTarget();
    const connection = fakeConnection("wifi");
    const recover = vi.fn();
    const off = listenForNetworkRecovery(events, connection, recover);
    events.dispatchEvent(new Event("online"));
    connection.type = "cellular";
    connection.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(1);
    events.dispatchEvent(new Event("online"));
    off();
    await Promise.resolve();
    events.dispatchEvent(new Event("online"));
    connection.type = "wifi";
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
