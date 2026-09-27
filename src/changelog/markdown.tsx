import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

/** A small markdown renderer for GitHub release notes - headings, lists
 * (nested by indentation), quotes, code, rules and inline emphasis/links.
 * Builds React elements rather than an HTML string, so nothing written in a
 * release can inject markup into the app. */
export function Markdown({ source }: { source: string }) {
  return <div className="markdown">{renderBlocks(source.replace(/\r\n?/g, "\n").split("\n"))}</div>;
}

type ListItem = { indent: number; ordered: boolean; text: string };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*(```|~~~)/;

function renderBlocks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const key = out.length;

    const fence = FENCE.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      i++;
      out.push(
        <pre key={key}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const Tag = `h${Math.min(heading[1].length + 1, 6)}` as "h2";
      out.push(<Tag key={key}>{renderInline(heading[2])}</Tag>);
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push(<hr key={key} />);
      i++;
      continue;
    }

    if (line.trimStart().startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) quoted.push(lines[i++].trimStart().replace(/^>\s?/, ""));
      out.push(<blockquote key={key}>{renderBlocks(quoted)}</blockquote>);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (m) {
          items.push({ indent: m[1].replace(/\t/g, "  ").length, ordered: /\d/.test(m[2]), text: m[3] });
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          // A wrapped continuation of the previous item.
          items[items.length - 1].text += " " + lines[i].trim();
        } else {
          break;
        }
        i++;
      }
      out.push(renderList(items, 0, items.length, key));
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !HEADING.test(lines[i]) &&
      !LIST_ITEM.test(lines[i]) &&
      !FENCE.test(lines[i]) &&
      !RULE.test(lines[i]) &&
      !lines[i].trimStart().startsWith(">")
    ) {
      para.push(lines[i++].trim());
    }
    out.push(<p key={key}>{renderInline(para.join(" "))}</p>);
  }
  return out;
}

/** `items[from..to]` as one list, items indented deeper than the first one
 * nesting under the item before them. */
function renderList(items: ListItem[], from: number, to: number, key: number): ReactNode {
  const base = items[from].indent;
  const children: ReactNode[] = [];
  let i = from;
  while (i < to) {
    const item = items[i];
    let end = i + 1;
    while (end < to && items[end].indent > base) end++;
    children.push(
      <li key={i}>
        {renderInline(item.text)}
        {end > i + 1 && renderList(items, i + 1, end, i)}
      </li>,
    );
    i = end;
  }
  return items[from].ordered ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>;
}

const INLINE = /(`+)(.+?)\1|\*\*(.+?)\*\*|__(.+?)__|\*(?!\s)(.+?)\*|(?<![\w])_(?!\s)(.+?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)]+)/g;

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const key = out.length;
    if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={key}>{renderInline(m[3] ?? m[4])}</strong>);
    else if (m[5] !== undefined || m[6] !== undefined) out.push(<em key={key}>{renderInline(m[5] ?? m[6])}</em>);
    else if (m[7] !== undefined) out.push(<ExternalLink key={key} href={m[8]}>{renderInline(m[7])}</ExternalLink>);
    else out.push(<ExternalLink key={key} href={m[9]}>{m[9]}</ExternalLink>);
    last = start + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Opens in the system browser - a click inside the webview would otherwise
 * navigate the app itself away. Anything but http(s) stays plain text. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  if (!/^https?:\/\//i.test(href)) return <>{children}</>;
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openUrl(href).catch(() => {});
      }}
    >
      {children}
    </a>
  );
}
