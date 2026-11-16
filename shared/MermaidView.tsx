import { useEffect, useState } from "react";

type Mermaid = (typeof import("mermaid"))["default"];

let mermaidPromise: Promise<Mermaid> | null = null;
const loadMermaid = () => (mermaidPromise ??= import("mermaid").then((m) => m.default));

/** Dark when the page background is dark: works for both apps without knowing their theme stores. */
function isDark(): boolean {
  const m = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return document.documentElement.getAttribute("data-theme") === "dark";
  const [r, g, b] = m.map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

const cache = new Map<string, string>();
let seq = 0;
let lastTheme = "";
/** Mermaid keeps one global config: renders run one at a time so the theme set for one is the theme it gets. */
let queue: Promise<unknown> = Promise.resolve();

function renderSvg(src: string): Promise<string> {
  const theme = isDark() ? "dark" : "default";
  const key = `${theme}:${src}`;
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const job = queue.then(async () => {
    const mermaid = await loadMermaid();
    if (theme !== lastTheme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme,
        fontFamily: "inherit",
        maxTextSize: 50000,
        maxEdges: 500,
      });
      lastTheme = theme;
    }
    // Throws on invalid syntax (a half-streamed block, typically) before touching the DOM.
    await mermaid.parse(src);
    const { svg } = await mermaid.render(`fc-mermaid-${++seq}`, src);
    if (cache.size >= 100) cache.clear();
    cache.set(key, svg);
    return svg;
  });
  queue = job.catch(() => {});
  return job;
}

/**
 * A ```mermaid block as a diagram, with a Code toggle and Copy. Mermaid loads on first use.
 * While the agent is still typing the source is often invalid: the last good diagram stays,
 * and the code shows until one renders.
 */
export function MermaidView({
  text,
  labels,
}: {
  text: string;
  labels: { copy: string; copied: string; title?: string; code?: string; diagram?: string };
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    // Debounced so a streaming block is not re-parsed on every token.
    const timer = setTimeout(() => {
      renderSvg(text).then(
        (out) => live && setSvg(out),
        () => {},
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const code = showCode || svg === null;
  return (
    <div className="chat-code chat-mermaid">
      <div className="chat-code-bar">
        <span className="chat-code-lang">mermaid</span>
        <span className="chat-mermaid-actions">
          {svg !== null && (
            <button type="button" className="chat-table-btn" onClick={() => setShowCode((v) => !v)}>
              {showCode ? (labels.diagram ?? "Diagram") : (labels.code ?? "Code")}
            </button>
          )}
          <button
            type="button"
            className="chat-table-btn"
            title={labels.title}
            onClick={() =>
              navigator.clipboard.writeText(text).then(
                () => setCopied(true),
                () => {},
              )
            }
          >
            {copied ? labels.copied : labels.copy}
          </button>
        </span>
      </div>
      {code ? (
        <pre>
          <code>{text}</code>
        </pre>
      ) : (
        <div className="chat-mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
    </div>
  );
}
