import { useEffect, useState } from "react";
import { useNearViewport } from "./useNearViewport";

type Mermaid = (typeof import("mermaid"))["default"];

let mermaidPromise: Promise<Mermaid> | null = null;
const loadMermaid = () => (mermaidPromise ??= import("mermaid").then((m) => m.default));

export type MermaidTheme = "dark" | "default";

/**
 * The mermaid theme for the app: `data-theme` on the root ("dark" / "light") decides; without it, the
 * page background decides (dark when its luminance is under 128; a transparent background counts as light).
 */
export function mermaidTheme(attr: string | null, bodyBg: string): MermaidTheme {
  if (attr === "dark") return "dark";
  if (attr === "light") return "default";
  const m = bodyBg.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return "default";
  const [r, g, b, a] = m.map(Number);
  if (a === 0) return "default";
  return 0.299 * r + 0.587 * g + 0.114 * b < 128 ? "dark" : "default";
}

/** The current theme, kept up to date while the app switches `data-theme`. */
function readDocumentTheme(): MermaidTheme {
  return mermaidTheme(document.documentElement.getAttribute("data-theme"), getComputedStyle(document.body).backgroundColor);
}

function useDocumentTheme(): MermaidTheme {
  const [theme, setTheme] = useState<MermaidTheme>(readDocumentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readDocumentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

const cache = new Map<string, string>();
/** Renders on their way (same source and theme): a second request shares the first one. */
const inflight = new Map<string, Promise<string>>();
let seq = 0;
let lastTheme = "";
/** Mermaid keeps one global config: renders run one at a time so the theme set for one is the theme it gets. */
let queue: Promise<unknown> = Promise.resolve();

function renderSvg(src: string, theme: MermaidTheme): Promise<string> {
  const key = `${theme}:${src}`;
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;
  const job = queue.then(async () => {
    const done = cache.get(key);
    if (done !== undefined) return done;
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
  inflight.set(key, job);
  job.then(
    () => inflight.delete(key),
    () => inflight.delete(key),
  );
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
  const theme = useDocumentTheme();
  // Past messages render their diagram only when scrolled near (the code shows meanwhile).
  const [nearRef, near] = useNearViewport<HTMLDivElement>("600px");

  useEffect(() => {
    if (!near) return;
    let live = true;
    // Debounced so a streaming block is not re-parsed on every token.
    const timer = setTimeout(() => {
      renderSvg(text, theme).then(
        (out) => live && setSvg(out),
        () => {},
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, theme, near]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const code = showCode || svg === null;
  return (
    <div className="chat-code chat-mermaid" ref={nearRef}>
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
