import { describe, expect, it } from "vitest";
import { cleanPreview } from "./linkPreviews";

describe("cleanPreview", () => {
  it("keeps the fields of a preview", () => {
    const raw = { url: "https://a.dev", finalUrl: "https://a.dev/x", title: "T", description: "D", siteName: "S", image: "data:image/png;base64,AA", favicon: "data:image/x-icon;base64,AA" };
    expect(cleanPreview(raw)).toEqual(raw);
  });

  it("drops fields of the wrong shape, and pictures that are not data images", () => {
    expect(cleanPreview({ url: "https://a.dev", title: 5, description: "D", image: "https://evil.dev/i.png", favicon: "javascript:1" })).toEqual({
      url: "https://a.dev",
      finalUrl: "https://a.dev",
      title: undefined,
      description: "D",
      siteName: undefined,
      image: undefined,
      favicon: undefined,
    });
  });

  it("is null when there is nothing to show", () => {
    expect(cleanPreview(null)).toBeNull();
    expect(cleanPreview("x")).toBeNull();
    expect(cleanPreview({ title: "no url" })).toBeNull();
    expect(cleanPreview({ url: "https://a.dev", siteName: "only a site" })).toBeNull();
  });
});
