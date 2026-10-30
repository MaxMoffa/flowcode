import { describe, expect, it } from "vitest";
import { markdownImageRef, previewUrls, splitLinks } from "./chatLinks";

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

  it("shows a markdown link to a local file as its label, linked to the file", () => {
    expect(splitLinks("[Compose](C:/a/docker-compose.yml) con backend")).toEqual([{ text: "Compose", path: "C:/a/docker-compose.yml" }, { text: " con backend" }]);
    expect(splitLinks("vedi [README](file:///C:/x/my%20file.md).")).toEqual([{ text: "vedi " }, { text: "README", path: "C:/x/my file.md" }, { text: "." }]);
    expect(splitLinks("[cfg](src/app.ts:12)")).toEqual([{ text: "cfg", path: "src/app.ts:12" }]);
  });

  it("shows only the label when the target is an anchor or another scheme", () => {
    expect(splitLinks("[mail](mailto:a@b.it)")).toEqual([{ text: "mail" }]);
    expect(splitLinks("[top](#top)")).toEqual([{ text: "top" }]);
  });

  it("keeps markdown links to the web as links", () => {
    expect(splitLinks("[site](https://example.com/a)")).toEqual([{ text: "site", url: "https://example.com/a" }]);
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

  it("skips markdown links to local files", () => {
    expect(previewUrls("[x](C:/a.md) https://e.com", 3)).toEqual(["https://e.com"]);
  });
});

describe("markdownImageRef", () => {
  it("takes web, data and file urls", () => {
    expect(markdownImageRef("https://x/y.png")).toEqual({ url: "https://x/y.png" });
    expect(markdownImageRef("data:image/png;base64,QQ==")).toEqual({ url: "data:image/png;base64,QQ==" });
    expect(markdownImageRef("file:///C:/a%20b/x.png")).toEqual({ path: "C:/a b/x.png" });
  });
  it("takes paths with an image extension", () => {
    for (const p of ["C:\\x\\a.PNG", "C:/x/a.jpg", "/home/x/a.webp", "~/a.gif", "./a.svg?v=1", "img/a.avif#f"]) expect(markdownImageRef(p)).toEqual({ path: p });
  });
  it("refuses the rest", () => {
    for (const p of ["javascript:alert(1)", "mailto:a@b.c", "ftp://x/a.png", "docs/readme.md", "a", ""]) expect(markdownImageRef(p)).toBeNull();
  });
});

describe("images are not links", () => {
  it("shows the alt of an image, not a link", () => {
    expect(splitLinks("![a](https://x/y.png)")).toEqual([{ text: "!" }, { text: "a" }]);
    expect(previewUrls("see ![a](https://x/y.png) and [b](https://z.io)", 5)).toEqual(["https://z.io"]);
  });
});
