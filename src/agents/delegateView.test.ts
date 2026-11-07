import { describe, expect, it } from "vitest";
import { activeCount, delegateTone, historyDot } from "./delegateView";

describe("delegate view helpers", () => {
  it("maps statuses to tones", () => {
    expect(["running", "waiting_for_user", "done", "failed", "cancelled", "?"].map(delegateTone)).toEqual(["running", "waiting", "done", "failed", "cancelled", "cancelled"]);
  });
  it("maps statuses to history dots", () => {
    expect(["running", "waiting_for_user", "done", "failed"].map(historyDot)).toEqual(["busy", "waiting", "idle", "off"]);
  });
  it("counts the delegates still going", () => {
    expect(activeCount([{ status: "running" }, { status: "waiting_for_user" }, { status: "done" }])).toBe(2);
  });
});
