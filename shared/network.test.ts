import { describe, expect, it } from "vitest";
import { isNetworkError } from "./network";

describe("isNetworkError", () => {
  it("recognises network failures", () => {
    expect(isNetworkError("API Error: Connection error.")).toBe(true);
    expect(isNetworkError("getaddrinfo ENOTFOUND api.anthropic.com")).toBe(true);
    expect(isNetworkError("TypeError: fetch failed")).toBe(true);
    expect(isNetworkError("connect ECONNREFUSED 127.0.0.1:443")).toBe(true);
  });
  it("ignores everything else", () => {
    expect(isNetworkError("auth_required: Authentication required")).toBe(false);
    expect(isNetworkError("Rate limit reached")).toBe(false);
  });
});
