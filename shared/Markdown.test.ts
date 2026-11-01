import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderMarkdown, type MarkdownAdapters } from "./Markdown";

function html(text: string, overrides: Partial<MarkdownAdapters> = {}) {
  const adapter: MarkdownAdapters = {
    text: (text) => text,
    code: (text, key) => createElement("code", { key }, text),
    image: (_src, alt, key) => createElement("span", { key }, alt),
    table: (table, cell, key) => createElement("div", { key }, table.header.map((text, i) => cell(text, String(i)))),
    copyLabels: { copy: "Copy", copied: "Copied", title: "Copy code" },
    ...overrides,
  };
  return renderToStaticMarkup(createElement("div", null, renderMarkdown(text, adapter)));
}

describe("shared markdown rendering", () => {
  it("preserves headings, nesting and task checkboxes", () => {
    const output = html("# Heading\n\n- [x] Done **well**\n- [ ] Next\n\n> Quote\n\n---");
    expect(output).toContain('<h2 class="chat-h chat-h1">Heading</h2>');
    expect(output).toContain('type="checkbox"');
    expect(output).toContain("<strong>well</strong>");
    expect(output).toContain("<blockquote>");
    expect(output).toContain("<hr/>");
  });
  it("keeps code literal and escapes content instead of injecting HTML", () => {
    const output = html("```html\n<script>alert(1)</script>\n```\n\n<img src=x onerror=bad>");
    expect(output).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(output).not.toContain("<script>");
    expect(output).not.toContain("<img src=x");
    expect(output).toContain('title="Copy code"');
  });
  it("delegates links, images and tables to the platform adapters", () => {
    const seen: string[] = [];
    const output = html("![Screenshot](shots/a.png)\n\n| First | Second |\n| --- | --- |\n| A | B |", {
      image: (src, alt) => { seen.push(src); return alt; },
      table: (table) => { seen.push(table.rows[0][0]); return "TABLE"; },
    });
    expect(seen).toEqual(["shots/a.png", "A"]);
    expect(output).toContain("Screenshot");
    expect(output).toContain("TABLE");
  });
});
