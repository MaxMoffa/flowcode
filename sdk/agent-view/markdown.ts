// A light markdown subset for the text an agent writes, for views to reuse:
// fenced code blocks, `inline code`, **bold**, "- " bullets, line breaks and
// links. Parsing is a pure function (`parseMarkdown`); `renderMarkdown` builds
// DOM nodes from its result with createElement/textContent, never innerHTML,
// so agent text can't inject markup.

import { splitLinks } from "../../src/chat/chatLinks";

export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "bold"; children: MarkdownInline[] }
  | { type: "link"; text: string; url: string };

export type MarkdownBlock =
  | { type: "code"; text: string; lang: string }
  | { type: "list"; items: MarkdownInline[][] }
  | { type: "paragraph"; lines: MarkdownInline[][] };

const CODE_SPAN = /`([^`\n]+)`/g;
const BOLD = /\*\*(?=\S)([^\n]*?\S)\*\*/g;
const FENCE = /^\s*```\s*([^\s`]*)/;
const BULLET = /^\s*[-*]\s+(.*)$/;

/** Text without code spans, cut into plain pieces and links. */
function linkParts(text: string): MarkdownInline[] {
  return splitLinks(text).map((part): MarkdownInline => (part.url ? { type: "link", text: part.text, url: part.url } : { type: "text", text: part.text }));
}

function boldParts(text: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let last = 0;
  for (const m of text.matchAll(BOLD)) {
    const start = m.index ?? 0;
    if (start > last) out.push(...linkParts(text.slice(last, start)));
    out.push({ type: "bold", children: linkParts(m[1]) });
    last = start + m[0].length;
  }
  if (last < text.length) out.push(...linkParts(text.slice(last)));
  return out;
}

/** One line of text as inline pieces; code spans are cut out first, so nothing inside them is a link or bold. */
export function parseInline(line: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let last = 0;
  for (const m of line.matchAll(CODE_SPAN)) {
    const start = m.index ?? 0;
    if (start > last) out.push(...boldParts(line.slice(last, start)));
    out.push({ type: "code", text: m[1] });
    last = start + m[0].length;
  }
  if (last < line.length) out.push(...boldParts(line.slice(last)));
  return out;
}

/** The blocks of a text: fenced code (an unclosed fence runs to the end), bullet lists and paragraphs (separated by blank lines). */
export function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const rows = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const fence = FENCE.exec(row);
    if (fence) {
      const code: string[] = [];
      for (i++; i < rows.length && !rows[i].trimStart().startsWith("```"); i++) code.push(rows[i]);
      blocks.push({ type: "code", text: code.join("\n"), lang: fence[1] });
      continue;
    }
    if (row.trim() === "") continue;
    const previous = i > 0 ? rows[i - 1] : "";
    const last = blocks[blocks.length - 1];
    const bullet = BULLET.exec(row);
    if (bullet) {
      const item = parseInline(bullet[1]);
      if (last?.type === "list" && BULLET.test(previous)) last.items.push(item);
      else blocks.push({ type: "list", items: [item] });
      continue;
    }
    const line = parseInline(row);
    if (last?.type === "paragraph" && previous.trim() !== "") last.lines.push(line);
    else blocks.push({ type: "paragraph", lines: [line] });
  }
  return blocks;
}

function inlineNodes(parts: MarkdownInline[], doc: Document): Node[] {
  return parts.map((part) => {
    switch (part.type) {
      case "text":
        return doc.createTextNode(part.text);
      case "code": {
        const node = doc.createElement("code");
        node.className = "md-code";
        node.textContent = part.text;
        return node;
      }
      case "bold": {
        const node = doc.createElement("strong");
        node.append(...inlineNodes(part.children, doc));
        return node;
      }
      case "link": {
        // A view can't open anything itself: the link is styled text whose
        // address is in the tooltip. No href, so a click navigates nowhere.
        const node = doc.createElement("span");
        node.className = "md-link";
        node.title = part.url;
        node.textContent = part.text;
        return node;
      }
    }
  });
}

/** The text as DOM nodes, ready to append. Only elements built here, with the agent's text in text nodes. */
export function renderMarkdown(text: string, doc: Document = document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  for (const block of parseMarkdown(text)) {
    if (block.type === "code") {
      const pre = doc.createElement("pre");
      pre.className = "md-pre";
      const code = doc.createElement("code");
      code.textContent = block.text;
      pre.append(code);
      fragment.append(pre);
    } else if (block.type === "list") {
      const list = doc.createElement("ul");
      list.className = "md-list";
      for (const item of block.items) {
        const li = doc.createElement("li");
        li.append(...inlineNodes(item, doc));
        list.append(li);
      }
      fragment.append(list);
    } else {
      const p = doc.createElement("p");
      p.className = "md-p";
      block.lines.forEach((line, index) => {
        if (index > 0) p.append(doc.createElement("br"));
        p.append(...inlineNodes(line, doc));
      });
      fragment.append(p);
    }
  }
  return fragment;
}
