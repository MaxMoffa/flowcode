import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, renderMarkdown } from "./markdown";

describe("parseInline", () => {
  it("finds code, bold and links, and leaves code alone", () => {
    expect(parseInline("a `**x** http://u.io` **b** see https://e.com/p.")).toEqual([
      { type: "text", text: "a " },
      { type: "code", text: "**x** http://u.io" },
      { type: "text", text: " " },
      { type: "bold", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " see " },
      { type: "link", text: "https://e.com/p", url: "https://e.com/p" },
      { type: "text", text: "." },
    ]);
  });

  it("reads [text](url) and leaves other schemes as text", () => {
    expect(parseInline("[hi](https://a.io/x)")).toEqual([{ type: "link", text: "hi", url: "https://a.io/x" }]);
    expect(parseInline("[hi](javascript:alert(1))")).toEqual([{ type: "text", text: "[hi](javascript:alert(1))" }]);
  });

  it("keeps lone asterisks and unclosed backticks as text", () => {
    expect(parseInline("2 ** 3 and `open")).toEqual([{ type: "text", text: "2 ** 3 and `open" }]);
  });
});

describe("parseMarkdown", () => {
  it("splits fences, lists and paragraphs", () => {
    const blocks = parseMarkdown("Intro\nline two\n\n- one\n- **two**\n\n```ts\nconst a = 1;\n\nb\n```\nafter");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "list", "code", "paragraph"]);
    expect(blocks[0]).toMatchObject({ lines: [[{ text: "Intro" }], [{ text: "line two" }]] });
    expect(blocks[1]).toMatchObject({ items: [[{ text: "one" }], [{ type: "bold" }]] });
    expect(blocks[2]).toEqual({ type: "code", lang: "ts", text: "const a = 1;\n\nb" });
  });

  it("runs an unclosed fence to the end", () => {
    expect(parseMarkdown("```\nx\ny")).toEqual([{ type: "code", lang: "", text: "x\ny" }]);
  });
});

// The tests run without a DOM, so a minimal one: enough to check what gets built.
class FakeNode {
  children: (FakeNode | string)[] = [];
  className = "";
  title = "";
  constructor(readonly tag: string) {}
  set textContent(value: string) {
    this.children = [value];
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }
  append(...nodes: (FakeNode | string)[]) {
    this.children.push(...nodes);
  }
  tags(): string[] {
    return this.children.flatMap((c) => (typeof c === "string" ? [] : [c.tag, ...c.tags()]));
  }
}
const fakeDoc = {
  createElement: (tag: string) => new FakeNode(tag),
  createTextNode: (text: string) => text,
  createDocumentFragment: () => new FakeNode("#fragment"),
} as unknown as Document;

describe("renderMarkdown", () => {
  it("never turns agent text into markup", () => {
    const fragment = renderMarkdown("<img src=x onerror=alert(1)> **b** [l](https://a.io)", fakeDoc) as unknown as FakeNode;
    expect(fragment.tags()).toEqual(["p", "strong", "span"]);
    expect(fragment.textContent).toBe("<img src=x onerror=alert(1)> b l");
    const link = (fragment.children[0] as FakeNode).children.find((c) => typeof c !== "string" && c.tag === "span") as FakeNode;
    expect(link.title).toBe("https://a.io");
  });

  it("builds pre > code for a fence", () => {
    const fragment = renderMarkdown("```\nA<b>\n```", fakeDoc) as unknown as FakeNode;
    expect(fragment.tags()).toEqual(["pre", "code"]);
    expect(fragment.textContent).toBe("A<b>");
  });
});
