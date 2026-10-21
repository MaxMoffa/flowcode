import { describe, expect, it } from "vitest";
import { previewUrls, splitLinks } from "./chatLinks";

const links = (text: string) => splitLinks(text).flatMap((p) => (p.url ? [p.url] : []));

describe("splitLinks", () => {
  it("finds markdown links and bare urls", () => {
    expect(splitLinks("see [the docs](https://a.dev/x) now")).toEqual([
      { text: "see " },
      { text: "the docs", url: "https://a.dev/x" },
      { text: " now" },
    ]);
    expect(splitLinks("go to https://a.dev/x ok")).toEqual([{ text: "go to " }, { text: "https://a.dev/x", url: "https://a.dev/x" }, { text: " ok" }]);
  });

  it("leaves trailing punctuation out of a bare url", () => {
    expect(links("Visit https://a.dev/x.")).toEqual(["https://a.dev/x"]);
    expect(links("(https://a.dev/x), then https://b.dev?q=1!")).toEqual(["https://a.dev/x", "https://b.dev?q=1"]);
    expect(links("really https://a.dev/x?!")).toEqual(["https://a.dev/x"]);
    expect(splitLinks("see https://a.dev.")[2]).toEqual({ text: "." });
  });

  it("keeps balanced parentheses in a url", () => {
    expect(links("https://en.wikipedia.org/wiki/Rust_(language)")).toEqual(["https://en.wikipedia.org/wiki/Rust_(language)"]);
    expect(links("(see https://en.wikipedia.org/wiki/Rust_(language))")).toEqual(["https://en.wikipedia.org/wiki/Rust_(language)"]);
    expect(links("[Rust](https://en.wikipedia.org/wiki/Rust_(language))")).toEqual(["https://en.wikipedia.org/wiki/Rust_(language)"]);
  });

  it("only takes http and https", () => {
    expect(links("[x](javascript:alert(1)) file:///etc/passwd ftp://a.b mailto:a@b.c")).toEqual([]);
    expect(links("HTTPS://A.DEV/x")).toEqual(["HTTPS://A.DEV/x"]);
    expect(links("https:// nothing")).toEqual([]);
  });

  it("returns plain text as one piece", () => {
    expect(splitLinks("no links here")).toEqual([{ text: "no links here" }]);
    expect(splitLinks("")).toEqual([]);
  });
});

describe("previewUrls", () => {
  it("skips code spans and fenced blocks", () => {
    const text = "run `curl https://in-span.dev` or\n```sh\ncurl https://in-fence.dev\n```\nthen https://real.dev/a and [b](https://real.dev/b)";
    expect(previewUrls(text, 3)).toEqual(["https://real.dev/a", "https://real.dev/b"]);
  });

  it("treats an unclosed fence as code to the end", () => {
    expect(previewUrls("https://a.dev\n```\nhttps://b.dev", 3)).toEqual(["https://a.dev"]);
  });

  it("lists distinct urls, the first few", () => {
    const text = "https://a.dev https://a.dev https://b.dev https://c.dev https://d.dev";
    expect(previewUrls(text, 3)).toEqual(["https://a.dev", "https://b.dev", "https://c.dev"]);
  });
});
