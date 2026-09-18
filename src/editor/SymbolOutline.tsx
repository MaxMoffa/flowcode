import { useEffect, useState } from "react";
import "./symbol-outline.css";

interface Symbol {
  name: string;
  line: number;
  kind: "function" | "class";
}

// Deliberately simple, regex-based, not a real parser for every language -
// good enough for a "jump to function" sidebar without pulling in a
// per-language AST just for this. Misses plenty of valid syntax; that's an
// acceptable trade-off given what this panel is for.
const PATTERNS: { re: RegExp; kind: Symbol["kind"] }[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=]*\)?\s*=>/, kind: "function" },
  { re: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^\s*def\s+([A-Za-z_]\w*)\s*\(/, kind: "function" },
  { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
  { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
  { re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: "class" },
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
];

function extractSymbols(content: string): Symbol[] {
  const lines = content.split("\n");
  const symbols: Symbol[] = [];
  lines.forEach((text, i) => {
    for (const { re, kind } of PATTERNS) {
      const match = text.match(re);
      if (match) {
        symbols.push({ name: match[1], line: i + 1, kind });
        break;
      }
    }
  });
  return symbols;
}

function FunctionIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill="none">
      <path d="M9 4.5c-3 0-3.5 2-3.5 4v11" />
      <path d="M5.5 12h4" />
      <path d="M14 4.5h5v5" />
      <path d="M19 4.5 12 11.5" />
    </svg>
  );
}

function ClassIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill="none">
      <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" />
      <line x1="4.5" y1="9.5" x2="19.5" y2="9.5" />
    </svg>
  );
}

interface SymbolOutlineProps {
  label: string;
  getContent: () => string;
  onJump: (line: number) => void;
}

export function SymbolOutline({ label, getContent, onJump }: SymbolOutlineProps) {
  const [symbols, setSymbols] = useState<Symbol[]>(() => extractSymbols(getContent()));
  const [query, setQuery] = useState("");

  // Recomputed whenever this panel becomes relevant (active tab switched to
  // this file) rather than on every keystroke in the editor - a live-typing
  // outline isn't worth the extra plumbing for what's meant to be a quick
  // jump list.
  useEffect(() => {
    setSymbols(extractSymbols(getContent()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  const filtered = symbols.filter((s) => s.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="symbol-outline">
      <div className="symbol-outline-header">
        <span className="symbol-outline-title" title={label}>
          {label}
        </span>
      </div>
      <div className="symbol-outline-search-row">
        <input
          className="symbol-outline-search"
          placeholder="Cerca funzione…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="symbol-outline-list">
        {symbols.length === 0 && <div className="symbol-outline-empty">Nessun simbolo riconosciuto in questo file</div>}
        {symbols.length > 0 && filtered.length === 0 && <div className="symbol-outline-empty">Nessun risultato</div>}
        {filtered.map((s) => (
          <button key={`${s.name}-${s.line}`} type="button" className="symbol-outline-item" onClick={() => onJump(s.line)}>
            <span className="symbol-outline-item-icon">{s.kind === "class" ? <ClassIcon /> : <FunctionIcon />}</span>
            <span className="symbol-outline-item-label">{s.name}</span>
            <span className="symbol-outline-item-line">{s.line}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
