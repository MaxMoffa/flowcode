import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline, type Block, type Inline } from "./markdownBlocks";

const list = (b: Block | undefined) => {
  if (b?.type !== "list") throw new Error("not a list");
  return b;
};
const text = (s: string): Inline => ({ type: "text", text: s });

describe("parseBlocks", () => {
  it("reads paragraphs, keeping single line breaks", () => {
    expect(parseBlocks("one\ntwo\n\nthree")).toEqual([
      { type: "paragraph", lines: ["one", "two"] },
      { type: "paragraph", lines: ["three"] },
    ]);
  });

  it("reads headings of every level", () => {
    expect(parseBlocks("# A\n###### F ##")).toEqual([
      { type: "heading", level: 1, text: "A" },
      { type: "heading", level: 6, text: "F" },
    ]);
  });

  it("keeps a # that ends a heading's last word (C#), dropping only a closing sequence", () => {
    expect(parseBlocks("## Learning C#\n# a ## b ##")).toEqual([
      { type: "heading", level: 2, text: "Learning C#" },
      { type: "heading", level: 1, text: "a ## b" },
    ]);
  });

  it("reads a fenced block with its language, and closes only on a long enough same fence", () => {
    expect(parseBlocks("```ts\nlet a;\n```")).toEqual([{ type: "code", lang: "ts", text: "let a;" }]);
    expect(parseBlocks("````md\n```\ninner\n```\n````\nafter")).toEqual([
      { type: "code", lang: "md", text: "```\ninner\n```" },
      { type: "paragraph", lines: ["after"] },
    ]);
    expect(parseBlocks("~~~\na\n```\n~~~")).toEqual([{ type: "code", lang: "", text: "a\n```" }]);
  });

  it("runs an unclosed fence to the end while streaming", () => {
    expect(parseBlocks("text\n```js\nconst a = 1;\nconst b")).toEqual([
      { type: "paragraph", lines: ["text"] },
      { type: "code", lang: "js", text: "const a = 1;\nconst b" },
    ]);
  });

  it("still detects tables", () => {
    const [b] = parseBlocks("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(b.type).toBe("table");
    if (b.type === "table") expect(b.table.rows).toEqual([["1", "2"]]);
  });

  it("tells a rule from a bullet and from a table delimiter", () => {
    expect(parseBlocks("---\n***\n___\n- - -")).toEqual([{ type: "hr" }, { type: "hr" }, { type: "hr" }, { type: "hr" }]);
    const blocks = parseBlocks("- one\n- two\n---\ntext");
    expect(blocks.map((b) => b.type)).toEqual(["list", "hr", "paragraph"]);
    expect(parseBlocks("| a | b |\n|---|---|\n| 1 | 2 |")[0].type).toBe("table");
    expect(parseBlocks("**bold** line")[0].type).toBe("paragraph");
  });

  it("reads bullet and ordered lists with the first number as start", () => {
    const ul = list(parseBlocks("- a\n* b\n+ c")[0]);
    expect(ul.ordered).toBe(false);
    expect(ul.items).toHaveLength(3);
    const ol = list(parseBlocks("3. a\n4) b")[0]);
    expect(ol.ordered).toBe(true);
    expect(ol.start).toBe(3);
    expect(ol.items).toHaveLength(2);
  });

  it("nests lists by indentation, two levels", () => {
    const ul = list(parseBlocks("- a\n  - b\n    - c\n- d")[0]);
    expect(ul.items).toHaveLength(2);
    const inner = list(ul.items[0].blocks[1]);
    expect(inner.items).toHaveLength(1);
    expect(list(inner.items[0].blocks[1]).items[0].blocks).toEqual([{ type: "paragraph", lines: ["c"] }]);
    // An ordered list with a nested bullet list under three-column content.
    const ol = list(parseBlocks("1. a\n   - b\n2. c")[0]);
    expect(ol.items).toHaveLength(2);
    expect(list(ol.items[0].blocks[1]).ordered).toBe(false);
  });

  it("keeps a loose list going across blank lines and a fence indented under an item", () => {
    expect(list(parseBlocks("- a\n\n- b\n\n- c")[0]).items).toHaveLength(3);
    const ol = list(parseBlocks("1. run:\n\n   ```sh\n   npm i\n\n   npm test\n   ```\n\n2. done")[0]);
    expect(ol.start).toBe(1);
    expect(ol.items).toHaveLength(2);
    expect(ol.items[0].blocks[1]).toEqual({ type: "code", lang: "sh", text: "npm i\n\nnpm test" });
  });

  it("numbers 1, 2 around an unindented code block", () => {
    const blocks = parseBlocks("1. one\n```\ncode\n```\n2. two");
    expect(blocks.map((b) => b.type)).toEqual(["list", "code", "list"]);
    expect(list(blocks[2]).start).toBe(2);
  });

  it("reads task items", () => {
    const ul = list(parseBlocks("- [ ] todo\n- [x] done\n- plain")[0]);
    expect(ul.items.map((i) => i.checked)).toEqual([false, true, null]);
    expect(ul.items[1].blocks).toEqual([{ type: "paragraph", lines: ["done"] }]);
  });

  it("reads blockquotes, nested and lazy", () => {
    expect(parseBlocks("> a\n> > b")).toEqual([
      { type: "blockquote", blocks: [{ type: "paragraph", lines: ["a"] }, { type: "blockquote", blocks: [{ type: "paragraph", lines: ["b"] }] }] },
    ]);
    expect(parseBlocks("> a\nlazy\n\nafter")).toEqual([
      { type: "blockquote", blocks: [{ type: "paragraph", lines: ["a", "lazy"] }] },
      { type: "paragraph", lines: ["after"] },
    ]);
  });

  it("ends a paragraph at a list item", () => {
    expect(parseBlocks("intro\n- a").map((b) => b.type)).toEqual(["paragraph", "list"]);
  });
});

describe("parseInline", () => {
  it("reads code spans, winning over formatting", () => {
    expect(parseInline("a `**x**` b")).toEqual([text("a "), { type: "code", text: "**x**" }, text(" b")]);
  });

  it("reads bold, italic and both", () => {
    expect(parseInline("**b** __b__")).toEqual([
      { type: "strong", children: [text("b")] },
      text(" "),
      { type: "strong", children: [text("b")] },
    ]);
    expect(parseInline("*i* _i_")).toEqual([{ type: "em", children: [text("i")] }, text(" "), { type: "em", children: [text("i")] }]);
    expect(parseInline("***x***")).toEqual([{ type: "strong", children: [{ type: "em", children: [text("x")] }] }]);
    expect(parseInline("**a *b* c**")).toEqual([{ type: "strong", children: [text("a "), { type: "em", children: [text("b")] }, text(" c")] }]);
  });

  it("reads strikethrough", () => {
    expect(parseInline("~~gone~~")).toEqual([{ type: "del", children: [text("gone")] }]);
  });

  it("keeps snake_case and spaced stars plain", () => {
    expect(parseInline("use snake_case_name here")).toEqual([text("use snake_case_name here")]);
    expect(parseInline("a * b * c")).toEqual([text("a * b * c")]);
    expect(parseInline("2 ** 3")).toEqual([text("2 ** 3")]);
  });

  it("reads links, one level of parens in the url included", () => {
    expect(parseInline("see [wiki](https://x.org/a_(b)) now")).toEqual([
      text("see "),
      { type: "link", raw: "[wiki](https://x.org/a_(b))" },
      text(" now"),
    ]);
  });

  it("leaves bare urls alone", () => {
    expect(parseInline("https://x.org/a_b_c and _it_")).toEqual([text("https://x.org/a_b_c and "), { type: "em", children: [text("it")] }]);
  });

  it("honours backslash escapes", () => {
    expect(parseInline("\\*not\\* \\_x\\_ C:\\Users")).toEqual([text("*not* _x_ C:\\Users")]);
  });

  it("keeps Windows paths intact, backslashes included", () => {
    expect(parseInline("C:\\Users\\massi\\.claude\\projects")).toEqual([text("C:\\Users\\massi\\.claude\\projects")]);
    expect(parseInline("D:\\_tmp\\file_name.txt")).toEqual([text("D:\\_tmp\\file_name.txt")]);
    expect(parseInline("\\\\server\\share\\_x")).toEqual([text("\\\\server\\share\\_x")]);
  });

  it("still escapes at the start of the text and after a space", () => {
    expect(parseInline("\\*not italic\\*")).toEqual([text("*not italic*")]);
    expect(parseInline("a \\_b\\_ c")).toEqual([text("a _b_ c")]);
  });

  it("leaves an unmatched mark as text", () => {
    expect(parseInline("**open and `tick")).toEqual([text("**open and `tick")]);
  });
});

describe("parseInline images", () => {
  it("reads ![alt](src), dropping a title", () => {
    expect(parseInline("a ![cat](img/c.png) b")).toEqual([text("a "), { type: "image", alt: "cat", src: "img/c.png" }, text(" b")]);
    expect(parseInline('![x](https://h/i.png "T")')).toEqual([{ type: "image", alt: "x", src: "https://h/i.png" }]);
  });
  it("allows <src> with spaces and one level of parens", () => {
    expect(parseInline("![x](<my dir/a b.png>)")).toEqual([{ type: "image", alt: "x", src: "my dir/a b.png" }]);
    expect(parseInline("![x](a_(1).png)")).toEqual([{ type: "image", alt: "x", src: "a_(1).png" }]);
  });
  it("keeps a lone ! and code spans as they are", () => {
    expect(parseInline("wow! [a](b)")).toEqual([text("wow! "), { type: "link", raw: "[a](b)" }]);
    expect(parseInline("![x]")).toEqual([text("![x]")]);
    expect(parseInline("`![x](y.png)`")).toEqual([{ type: "code", text: "![x](y.png)" }]);
  });
});
