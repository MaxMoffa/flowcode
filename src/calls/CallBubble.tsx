import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import type { TabAgent } from "../agents/agentSessions";
import { cliName } from "../agents/cliInfo";
import { useI18n, type MessageKey } from "../i18n";
import { agentCliIcon } from "../plugins/icons";
import type { AppTab } from "../tabs/types";
import { removeCall, useCalls, type AgentCall, type CallKind } from "./callStore";
import "./call-bubble.css";

/** An unanswered informational bubble folds away after this; the tab keeps pulsing. */
const COLLAPSE_MS = 20_000;
const WIDTH = 340;
const MARGIN = 8;
/** Keeps the tip inside the bubble's rounded corners. */
const TIP_INSET = 22;

interface Anchor {
  left: number;
  top: number;
  width: number;
  tip: number;
}

const tabSelector = (tabId: string) => `.term-tab[data-tab-id="${CSS.escape(tabId)}"]`;

/** Where the bubble goes: under the calling tab, tip on its centre, kept inside the window. A tab scrolled out of the
 * strip is anchored at the strip's edge. */
function anchorFor(tabId: string, narrow: boolean): Anchor | null {
  const tab = document.querySelector<HTMLElement>(tabSelector(tabId));
  if (!tab) return null;
  const rect = tab.getBoundingClientRect();
  const strip = tab.closest<HTMLElement>(".tab-strip-viewport")?.getBoundingClientRect();
  const center = strip ? Math.min(Math.max(rect.left + rect.width / 2, strip.left + TIP_INSET), strip.right - TIP_INSET) : rect.left + rect.width / 2;
  const width = narrow ? window.innerWidth : Math.min(WIDTH, window.innerWidth - MARGIN * 2);
  const left = narrow ? 0 : Math.min(Math.max(center - 44, MARGIN), window.innerWidth - width - MARGIN);
  const top = (strip?.bottom ?? rect.bottom) + (narrow ? 4 : 8);
  return { left, top, width, tip: Math.min(Math.max(center - left - 6, TIP_INSET - 6), width - TIP_INSET - 6) };
}

/** The bubble's position, kept current while the window resizes and the tab strip scrolls or reflows. */
function useAnchor(tabId: string | undefined, narrow: boolean, tabs: AppTab[]): Anchor | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  useLayoutEffect(() => {
    if (!tabId) {
      setAnchor(null);
      return;
    }
    const update = () =>
      setAnchor((prev) => {
        const next = anchorFor(tabId, narrow);
        return prev && next && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.tip === next.tip ? prev : next;
      });
    update();
    window.addEventListener("resize", update);
    const viewport = document.querySelector(tabSelector(tabId))?.closest(".tab-strip-viewport");
    viewport?.addEventListener("scroll", update, { passive: true });
    const observer = viewport ? new ResizeObserver(update) : null;
    if (viewport) observer?.observe(viewport);
    return () => {
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [tabId, narrow, tabs]);
  return anchor;
}

/** The time, refreshed every few seconds while `active`, for the "12 s ago" caption. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const KIND_CHIP: Record<CallKind, MessageKey> = {
  permission: "calls.kind.permission",
  question: "calls.kind.question",
  browser: "calls.kind.browser",
  done: "calls.kind.done",
  attention: "calls.kind.attention",
  custom: "calls.kind.custom",
};

/** The newest call as a speech bubble under its tab, the others one click away. Rendered once, by App. */
export function CallBubble({ tabs, agents, narrow, onGoTo }: { tabs: AppTab[]; agents: Map<string, TabAgent>; narrow: boolean; onGoTo: (tabId: string) => void }) {
  const { t } = useI18n();
  const calls = useCalls();
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [cycle, setCycle] = useState(0);
  const [reply, setReply] = useState("");

  const open = calls.filter((c) => !folded.has(c.id));
  const shown = open.length ? open[cycle % open.length] : undefined;
  const others = open.length - 1;
  const next = others > 0 ? open[(cycle + 1) % open.length] : undefined;
  const anchor = useAnchor(shown?.tabId, narrow, tabs);
  const now = useNow(!!shown);

  // An informational bubble folds after a while; one waiting for an answer stays.
  const shownId = shown?.id;
  const waitsForAnswer = shown?.kind === "permission" || shown?.kind === "question";
  useEffect(() => {
    if (!shownId || waitsForAnswer) return;
    const timer = setTimeout(() => setFolded((f) => new Set(f).add(shownId)), COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [shownId, waitsForAnswer]);

  useEffect(() => setReply(""), [shownId]);

  useEffect(() => {
    if (!shownId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      removeCall(shownId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shownId]);

  if (!shown || !anchor) return null;

  const tabOf = (call: AgentCall) => tabs.find((tab) => tab.id === call.tabId);
  const agentOf = (call: AgentCall) => {
    const tab = tabOf(call);
    return call.agent ?? (tab?.kind === "chat" ? tab.agent : agents.get(call.tabId)?.cli);
  };
  const label = (call: AgentCall) => tabOf(call)?.label ?? "";
  const ago = (call: AgentCall) => {
    const s = Math.max(0, Math.round((now - call.createdAt) / 1000));
    return s < 5 ? t("calls.now") : s < 60 ? t("calls.secondsAgo", { n: s }) : t("calls.minutesAgo", { n: Math.round(s / 60) });
  };
  const goTo = () => onGoTo(shown.tabId);
  const answered = (fn: () => void) => {
    fn();
    removeCall(shown.id);
  };
  const agent = agentOf(shown);
  const hasOptions = !!shown.options?.length;
  const style = { left: anchor.left, top: anchor.top, width: anchor.width, "--call-tip": `${anchor.tip}px` } as CSSProperties;
  const send = () => {
    const text = reply.trim();
    if (text && shown.onReply) answered(() => shown.onReply?.(text));
  };

  return (
    <div className={"call-bubble" + (narrow ? " is-narrow" : "")} style={style} role="alertdialog" aria-label={shown.title}>
      <div className="call-who">
        <span className="call-logo">{agent ? agentCliIcon(agent) : null}</span>
        <div className="call-who-text">
          <b>{shown.title}</b>
          <small>{[label(shown), ago(shown)].filter(Boolean).join(" · ")}</small>
        </div>
        <span className={"call-kind is-" + shown.kind}>{t(KIND_CHIP[shown.kind])}</span>
        <button type="button" className="call-close" aria-label={t("calls.dismiss")} onClick={() => removeCall(shown.id)}>
          ✕
        </button>
      </div>
      {shown.detail && <div className="call-why">{shown.detail}</div>}
      {shown.command && <div className="call-command">{shown.command}</div>}
      {hasOptions && shown.kind === "question" && (
        <div className="call-options">
          {shown.options?.map((o) => (
            <button key={o.id} type="button" className="call-option" onClick={() => answered(() => shown.onOption?.(o.id))}>
              {o.label}
              {o.hint && <small>{o.hint}</small>}
            </button>
          ))}
        </div>
      )}
      {shown.onReply && (
        <div className="call-reply">
          <input value={reply} placeholder={t("calls.replyPlaceholder")} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
          <button type="button" className="call-btn is-primary" disabled={!reply.trim()} onClick={send}>
            {t("calls.send")}
          </button>
        </div>
      )}
      <div className="call-actions">
        {hasOptions &&
          shown.kind !== "question" &&
          shown.options?.map((o) => (
            <button key={o.id} type="button" className={"call-btn" + (o.tone && o.tone !== "default" ? " is-" + o.tone : "")} onClick={() => answered(() => shown.onOption?.(o.id))}>
              {o.label}
            </button>
          ))}
        {!hasOptions && !shown.onReply && (
          <button type="button" className="call-btn is-primary" onClick={goTo}>
            {t("calls.goTo")}
          </button>
        )}
        {shown.onOpenHere && (
          <button type="button" className="call-btn" onClick={() => answered(() => shown.onOpenHere?.())}>
            {t("calls.openHere")}
          </button>
        )}
        {!hasOptions && !shown.onReply && (
          <button type="button" className="call-btn is-ghost" onClick={() => removeCall(shown.id)}>
            {shown.kind === "browser" ? t("calls.later") : t("calls.ok")}
          </button>
        )}
        {(hasOptions || shown.onReply) && (
          <>
            <span className="call-spacer" />
            <button type="button" className="call-btn is-ghost" onClick={goTo}>
              {t("calls.goTo")}
            </button>
          </>
        )}
      </div>
      {next && (
        <button type="button" className="call-more" onClick={() => setCycle((c) => c + 1)}>
          {t(others === 1 ? "calls.more.one" : "calls.more.many", { n: others })} · <b>{cliName(agentOf(next) ?? "")}</b> {t("calls.inTab")} {label(next)}: {next.detail ?? next.title}
        </button>
      )}
    </div>
  );
}
