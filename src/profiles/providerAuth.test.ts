import { beforeEach, describe, expect, it, vi } from "vitest";

let auth: typeof import("./providerAuth");
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("window", new EventTarget());
  auth = await import("./providerAuth");
});

describe("provider authentication scope", () => {
  it("keeps expired access isolated by provider and account profile", () => {
    auth.markProviderAuthRequired("claude", "work");
    expect(auth.providerAuthRequired("claude", "work")).toBe(true);
    expect(auth.providerAuthRequired("codex", "work")).toBe(false);
    expect(auth.providerAuthRequired("claude", "personal")).toBe(false);
    expect(auth.providerAuthRequired("claude")).toBe(false);
  });

  it("does not clear a different profile when a login completes", () => {
    auth.markProviderAuthRequired("gemini", "work");
    auth.markProviderAuthRequired("gemini", "personal");
    auth.completeProviderAuthentication("gemini", "personal");
    expect(auth.providerAuthRequired("gemini", "work")).toBe(true);
    expect(auth.providerAuthRequired("gemini", "personal")).toBe(false);
  });

  it("normalizes the default account and emits a scoped completion", () => {
    const success = vi.fn();
    window.addEventListener(auth.PROVIDER_AUTHENTICATED, success);
    auth.markProviderAuthRequired("codex", null);
    expect(auth.providerAuthRequired("codex", undefined)).toBe(true);
    auth.completeProviderAuthentication("codex");
    expect(auth.providerAuthRequired("codex", null)).toBe(false);
    expect((success.mock.calls[0][0] as CustomEvent).detail).toEqual({ cli: "codex", profile: null });
  });

  it("waits for verified success or cancellation before resolving a launch", async () => {
    let request!: import("./providerAuth").ProviderAuthOpen;
    window.addEventListener(auth.PROVIDER_AUTH_OPEN, (event) => { request = (event as CustomEvent).detail; });
    const completed = vi.fn();
    const result = auth.openProviderAuth("vibe", "work").then(completed);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(request.cli).toBe("vibe");
    expect(request.profile).toBe("work");
    request.complete(false);
    await result;
    expect(completed).toHaveBeenCalledWith(false);
  });
});
