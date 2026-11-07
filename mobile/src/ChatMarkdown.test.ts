import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("./ChatImage", () => ({ ChatImageView: () => null }));
vi.mock("./ChatTable", () => ({ ChatTable: () => null }));
vi.mock("./i18n", () => ({ t: (key: string) => key }));
import { ChatFileLinks, ChatMarkdown } from "./ChatMarkdown";

function render(text: string) {
  return renderToStaticMarkup(createElement(ChatFileLinks.Provider, { value: () => true }, createElement(ChatMarkdown, { text, onLink: () => {} })));
}

describe("mobile markdown file links", () => {
  it("keeps a single anchor inside formatted markdown link labels", () => {
    for (const text of ["[`docs/a.html`](docs/a.html)", "[**`docs/a.html`**](https://example.com)"]) {
      expect(render(text).match(/<a /g)).toHaveLength(1);
      expect(render(text)).toContain("<code>docs/a.html</code>");
    }
  });
  it("links a command argument instead of the whole command", () => {
    expect(render("`open docs/report.html`")).toContain('href="docs/report.html"');
    expect(render("`open docs/report.html`")).not.toContain('href="open docs/report.html"');
  });
  it("preserves filenames containing spaces", () => {
    expect(render("`docs/my report.html`")).toContain('href="docs/my report.html"');
  });
  it("does not mistake an implicit hostname for a local folder", () => {
    expect(render("example.com/logo.png")).not.toContain("<a ");
    expect(render("./example.com/logo.png")).toContain('<a href="./example.com/logo.png"');
  });
});
