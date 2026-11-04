import { createContext, memo, useEffect, useState, type RefObject } from "react";
import { elapsed } from "../../shared/BackgroundTerminalsCard";
import type { BackgroundTerminal } from "../../src/chat/backgroundTerminals";
import { tailLines } from "./terminalOutput";
import { tapFeedback } from "./haptics";
import { t } from "./i18n";
import { ChevronDownIcon } from "./icons";

/** Lines of output a folded block shows. */
const PREVIEW_LINES = 3;
/** Characters of output an open block shows. */
const OUTPUT_MAX = 3000;
/** How much of a block must be inside the thread for it to count as on screen. */
const VISIBLE_SLACK = 24;
const FLASH_MS = 1200;

/** The conversation's background terminals, by the id of the tool call that launched them. */
export const TerminalsContext = createContext<ReadonlyMap<string, BackgroundTerminal>>(new Map());

/** A background terminal where the agent launched it: what it is for, the command, and the last output the agent read. Tap opens the whole output in place, in the thread's own scroll. */
export const TerminalBlock = memo(function TerminalBlock({ term }: { term: BackgroundTerminal }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!term.running) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [term.running]);
  const output = open ? term.output.slice(-OUTPUT_MAX) : tailLines(term.output, PREVIEW_LINES);
  return (
    <div className={"chat-termblock" + (open ? " is-open" : "")} data-term-id={term.id}>
      <button type="button" className="chat-termblock-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={"chat-subtray-dot" + (term.running ? "" : " is-ended")} aria-hidden="true" />
        <span className="chat-termblock-text">
          <b>{term.description || term.command}</b>
          {term.description && <code className="mono">{term.command}</code>}
        </span>
        <span className="chat-subtray-time">{term.running ? elapsed(term.startedAt, now) : t("chatTermEnded")}</span>
        <ChevronDownIcon />
      </button>
      <pre className={"chat-termblock-out" + (output ? " mono" : " is-empty")}>{output || t("chatTermNoOutput")}</pre>
    </div>
  );
});

/** The running terminals out of sight: on the thread but scrolled away, or inside a subagent's chat. */
function outOfSight(scroller: HTMLElement, running: BackgroundTerminal[]): BackgroundTerminal[] {
  const box = scroller.getBoundingClientRect();
  return running.filter((term) => {
    const block = scroller.querySelector(`[data-term-id="${CSS.escape(term.id)}"]`);
    if (!block) return term.ownerId !== null;
    const rect = block.getBoundingClientRect();
    return rect.bottom < box.top + VISIBLE_SLACK || rect.top > box.bottom - VISIBLE_SLACK;
  });
}

/** Floats over the thread while a running terminal is out of sight; tap goes to the next one. */
export function TerminalJump({ terminals, scrollRef, onOpenSubagent }: { terminals: ReadonlyMap<string, BackgroundTerminal>; scrollRef: RefObject<HTMLDivElement | null>; onOpenSubagent: (id: string) => void }) {
  const running = [...terminals.values()].filter((term) => term.running);
  const key = running.map((term) => term.id).join(" ");
  const [hidden, setHidden] = useState(0);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !key) {
      setHidden(0);
      return;
    }
    const check = () => setHidden(outOfSight(scroller, running).length);
    check();
    scroller.addEventListener("scroll", check, { passive: true });
    const observer = new ResizeObserver(check);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => {
      scroller.removeEventListener("scroll", check);
      observer.disconnect();
    };
    // `running` is rebuilt on every draw; `key` says when it really changed.
  }, [key, scrollRef]);
  if (hidden === 0) return null;
  const go = () => {
    const scroller = scrollRef.current;
    const next = scroller && outOfSight(scroller, running)[0];
    if (!scroller || !next) return;
    tapFeedback();
    const block = scroller.querySelector<HTMLElement>(`[data-term-id="${CSS.escape(next.id)}"]`);
    if (!block) {
      if (next.ownerId) onOpenSubagent(next.ownerId);
      return;
    }
    const top = block.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 12;
    scroller.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    block.classList.add("is-flash");
    window.setTimeout(() => block.classList.remove("is-flash"), FLASH_MS);
  };
  return (
    <button type="button" className="chat-termjump" aria-label={t("chatTermJump")} onClick={go}>
      <span className="chat-subtray-dot" aria-hidden="true" />
      {t("chatTermRunning", { n: running.length })}
    </button>
  );
}
