import { useEffect, useState } from "react";

let katexPromise: Promise<typeof import("katex")> | null = null;
/** Set once KaTeX has loaded, so later formulas render on their first paint (no raw-TeX flash while streaming). */
let katexReady: typeof import("katex") | null = null;
const loadKatex = () =>
  (katexPromise ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => (katexReady = m)));

const cache = new Map<string, string>();

function render(katex: typeof import("katex"), tex: string, display: boolean): string | null {
  const key = `${display ? 1 : 0}:${tex}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  try {
    const html = katex.default.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      trust: false,
      strict: "ignore",
      maxSize: 50,
      maxExpand: 500,
      output: "htmlAndMathml",
    });
    if (cache.size >= 500) cache.clear();
    cache.set(key, html);
    return html;
  } catch {
    return null;
  }
}

/** TeX as KaTeX markup. KaTeX loads on first use; until then (or if it fails) the raw source shows. */
export function MathView({
  tex,
  display,
  labels,
}: {
  tex: string;
  display: boolean;
  labels?: { copy: string; copied: string; title?: string };
}) {
  const [loaded, setLoaded] = useState(katexReady);
  const html = loaded ? render(loaded, tex, display) : null;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (loaded) return;
    let live = true;
    loadKatex().then(
      (k) => live && setLoaded(() => k),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [loaded]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const body =
    html === null ? <code className="chat-math-raw">{tex}</code> : <span className="chat-math" dangerouslySetInnerHTML={{ __html: html }} />;
  if (!display) return body;
  return (
    <div className="chat-math-block">
      {body}
      {labels && (
        <button
          type="button"
          className="chat-table-btn chat-math-copy"
          title={labels.title}
          onClick={() =>
            navigator.clipboard.writeText(tex).then(
              () => setCopied(true),
              () => {},
            )
          }
        >
          {copied ? labels.copied : labels.copy}
        </button>
      )}
    </div>
  );
}
