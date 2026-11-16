import { describe, expect, it, vi } from "vitest";

vi.mock("./remote", () => ({ onMessage: () => () => {}, send: () => {}, useRemoteSelector: () => "online" }));
import { listingKey, shouldBlankListing } from "./fileListing";

describe("listing reset", () => {
  it("blanks on the first request and when the folder changes", () => {
    expect(shouldBlankListing(null, listingKey("p1", "", "/a"))).toBe(true);
    expect(shouldBlankListing(listingKey("p1", "", "/a"), listingKey("p1", "src", "/a"))).toBe(true);
    expect(shouldBlankListing(listingKey("p1", "", "/a"), listingKey("p1", "", "/b"))).toBe(true);
  });
  it("keeps the list on a plain re-request after a reconnect", () => {
    expect(shouldBlankListing(listingKey("p1", "src", "/a"), listingKey("p1", "src", "/a"))).toBe(false);
  });
});
