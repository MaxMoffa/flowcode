import { describe, expect, it } from "vitest";
import { parseBlocks } from "../src/chat/markdownBlocks";
import { splitMarkdown } from "./markdownSplit";

const samples = [
  "# Title\n\nA paragraph\nwith two lines.\n\nAnother one.",
  "- a\n- b\n\n- c\n\nAfter the list.",
  "1. one\n\n   continued under one\n\n2. two",
  "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro",
  "Open fence still streaming\n\n```\ncode\n\nmore code",
  "$$\nx = 1\n\ny = 2\n$$\n\nafter math",
  "$$ unclosed\n\ntext after",
  "| a | b |\n|---|---|\n| 1 | 2 |\n\n| c |\n|---|\n| 3 |",
  "> quote\n> more\n\n> second quote\n\nplain",
  "~~~\nx\n\n```\ny\n~~~\n\nz",
  "a\r\n\r\nb\r\n\r\n\r\nc",
  "- item\n\n    indented code-ish\n\n- next",
];

describe("splitMarkdown", () => {
  it("cuts a document at blank lines between blocks", () => {
    expect(splitMarkdown("one\n\ntwo\n\n\nthree")).toEqual(["one", "two", "three"]);
  });
  it("keeps an unclosed fence, with its blank lines, in the live tail", () => {
    expect(splitMarkdown("intro\n\n```\na\n\nb")).toEqual(["intro", "```\na\n\nb"]);
  });
  it("does not cut inside a closed fence or a multi-line math block", () => {
    expect(splitMarkdown("```\na\n\nb\n```\n\nx")).toEqual(["```\na\n\nb\n```", "x"]);
    expect(splitMarkdown("$$\na\n\nb\n$$\n\nx")).toEqual(["$$\na\n\nb\n$$", "x"]);
  });
  it("keeps a list together across blank lines between its items", () => {
    expect(splitMarkdown("- a\n\n- b\n\nend")).toEqual(["- a\n\n- b", "end"]);
  });
  it("is empty for blank text", () => {
    expect(splitMarkdown("\n\n")).toEqual([]);
  });
  it.each(samples)("parses the same in chunks as whole: %#", (text) => {
    const whole = parseBlocks(text);
    const parts = splitMarkdown(text).flatMap((c) => parseBlocks(c));
    expect(parts).toEqual(whole);
  });
});
