import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useI18n } from "../i18n";
import { useOutsideClose } from "../hooks/useOutsideClose";
import type { AgentCli } from "../agents/cliInfo";
import { readJson, writeJson } from "../lib/storage";
import type { ChatModelOption } from "./chatTypes";
import { GROUP_MIN, groupModels, matchesModel } from "./modelGroups";
import { splitModelVersions } from "./modelVersions";
import type { ChatSession } from "./useChat";

/** Everything the arrow keys visit: the model rows, the "older versions" row and the current thinking level (Left/Right move inside that group). */
const NAV = '[role="menuitemradio"], [data-older-toggle], [data-nav], [role="radio"][aria-checked="true"]';

const RECENT_MAX = 3;
const recentKey = (agent: AgentCli) => `flowcode.chatRecentModels.${agent}`;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** How far along the track the current thinking level sits, 0 to 1. */
function thoughtFill(thought: NonNullable<ChatSession["thought"]>): number {
  const at = thought.available.findIndex((l) => l.id === thought.currentId);
  return thought.available.length > 1 && at > 0 ? at / (thought.available.length - 1) : 0;
}

function ChipIcon({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M10 10h4v4h-4zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
    </svg>
  );
}

/** The composer's model pill (beside the mode one) and the menu it opens
 * upward: the models, then the thinking level. Hidden unless the agent offers
 * a choice of either (with levels only, the pill shows just the level). */
export default function ChatModelSelect({ chat, agent }: { chat: Pick<ChatSession, "models" | "setModel" | "model" | "thought" | "setThought">; agent: AgentCli }) {
  const { t } = useI18n();
  const models = chat.models;
  const thought = chat.thought;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [olderOpen, setOlderOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [olderGroups, setOlderGroups] = useState<Set<string>>(new Set());
  const [recents, setRecents] = useState<string[]>(() => readJson(recentKey(agent), isStringArray, []));
  useOutsideClose(open, [anchorRef], () => setOpen(false), { escape: true });
  const split = useMemo(() => (models ? splitModelVersions(models.availableModels) : null), [models]);
  const grouped = useMemo(() => (models ? groupModels(models.availableModels) : null), [models]);
  const searchable = !!models && models.availableModels.length >= GROUP_MIN;

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>(NAV);
    if (searchRef.current) searchRef.current.focus();
    else if (items?.length) {
      const current = Array.from(items).find((el) => el.getAttribute("aria-checked") === "true");
      (current ?? items[0]).focus();
    }
    menuRef.current?.querySelector<HTMLElement>(".chat-mode-row.is-selected")?.scrollIntoView({ block: "nearest" });
  }, [open]);

  if ((!models || !split) && !thought) return null;
  const currentId = models?.currentModelId ?? null;
  const current = models?.availableModels.find((m) => m.modelId === currentId);
  const level = thought ? (thought.available.find((l) => l.id === thought.currentId) ?? null) : null;
  const busy = chat.model.status === "busy" || chat.model.status === "waiting";

  const hasOlder = !!split && split.older.length > 0;
  const olderHasCurrent = !!split && split.older.some((m) => m.modelId === currentId);
  const showOlder = hasOlder && olderOpen;

  const close = () => {
    setOlderOpen(false);
    setQuery("");
    setOpen(false);
    pillRef.current?.focus();
  };

  const pick = (id: string) => {
    const next = [id, ...recents.filter((r) => r !== id)].slice(0, RECENT_MAX);
    setRecents(next);
    writeJson(recentKey(agent), next);
    close();
    if (id !== currentId) chat.setModel(id);
  };

  const toggleIn = (set: (f: (prev: Set<string>) => Set<string>) => void, key: string, on?: boolean) =>
    set((prev) => {
      const next = new Set(prev);
      if (on === undefined ? next.has(key) : !on) next.delete(key);
      else next.add(key);
      return next;
    });

  const q = query.trim();
  const matches = q && models ? models.availableModels.filter((m) => matchesModel(m, q, grouped?.groupOf.get(m.modelId))) : [];
  const recentModels = models && grouped ? recents.map((id) => models.availableModels.find((m) => m.modelId === id)).filter((m): m is ChatModelOption => !!m) : [];
  const showRecents = !q && recentModels.length >= 2;

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(NAV) ?? []);
    const active = document.activeElement as HTMLElement | null;
    // On a thinking level the menu's position is the group's current one.
    const group = active?.closest<HTMLElement>('[role="radiogroup"]') ?? null;
    const onLevel = active?.getAttribute("role") === "radio" && !!group;
    const index = onLevel ? items.indexOf(group.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') as HTMLElement) : items.indexOf(active as HTMLElement);
    const toggle = menuRef.current?.querySelector<HTMLElement>("[data-older-toggle]") ?? null;
    const inOlder = !!(document.activeElement as HTMLElement | null)?.closest("[data-older-list]");
    const collapseOlder = () => {
      setOlderOpen(false);
      toggle?.focus();
    };
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
    const input = searchRef.current;
    if (input && e.target === input) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        items[0]?.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (q && matches.length) pick(matches[0].modelId);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (query) setQuery("");
        else close();
      } else if (e.key === "Tab") {
        setOpen(false);
      }
      return;
    }
    const isHeader = !!active?.classList.contains("chat-model-grp");
    const groupKey = active?.dataset.groupKey;
    if (isHeader && groupKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      toggleIn(setOpenGroups, groupKey, e.key === "ArrowRight");
      return;
    }
    if (e.key === "ArrowLeft" && groupKey && !isHeader && active?.getAttribute("role") === "menuitemradio" && openGroups.has(groupKey)) {
      e.preventDefault();
      toggleIn(setOpenGroups, groupKey, false);
      items.find((el) => el.classList.contains("chat-model-grp") && el.dataset.groupKey === groupKey)?.focus();
      return;
    }
    if (input && e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey && active && items.includes(active) && !onLevel) {
      input.focus();
      return;
    }
    if (e.key === "ArrowUp" && input && index === 0) {
      e.preventDefault();
      input.focus();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (showOlder && inOlder) collapseOlder();
      else close();
    } else if (onLevel && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      const radios = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'));
      const at = radios.indexOf(active as HTMLElement);
      radios[(at + (e.key === "ArrowRight" ? 1 : -1) + radios.length) % radios.length]?.focus();
    } else if (e.key === "ArrowRight" && document.activeElement === toggle && !showOlder) {
      e.preventDefault();
      setOlderOpen(true);
    } else if (e.key === "ArrowLeft" && showOlder && (inOlder || document.activeElement === toggle)) {
      e.preventDefault();
      collapseOlder();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAt(index + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(index - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAt(items.length - 1);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const renderList = (list: ChatModelOption[]) =>
    list.map((m, i) => {
      const selected = m.modelId === currentId;
      const newGroup = m.group && m.group !== list[i - 1]?.group;
      return (
        <Fragment key={m.modelId}>
          {newGroup && <div className="chat-model-group">{m.group}</div>}
          <div className={`chat-mode-row${selected ? " is-selected" : ""}`}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              className="chat-mode-item"
              onClick={() => {
                close();
                if (!selected) chat.setModel(m.modelId);
              }}
            >
              <span className="chat-model-check" aria-hidden="true">
                {selected ? "✓" : ""}
              </span>
              <span className="chat-mode-text">
                <span className="chat-mode-title">{m.name}</span>
                {m.description && <span className="chat-mode-desc">{m.description}</span>}
              </span>
            </button>
          </div>
        </Fragment>
      );
    });

  const renderCompact = (m: ChatModelOption, opts: { label?: string; old?: boolean; groupKey?: string } = {}) => {
    const selected = m.modelId === currentId;
    return (
      <div key={m.modelId} className={`chat-mode-row${selected ? " is-selected" : ""}${opts.old ? " is-old" : ""}`}>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={selected}
          className="chat-mode-item chat-model-compact"
          title={m.description ?? m.modelId}
          data-group-key={opts.groupKey}
          onClick={() => pick(m.modelId)}
        >
          <span className="chat-model-check" aria-hidden="true">
            {selected ? "✓" : ""}
          </span>
          <span className="chat-model-compact-name">{grouped?.names.get(m.modelId) ?? m.name}</span>
          {opts.label && <span className="chat-model-compact-group">{opts.label}</span>}
        </button>
      </div>
    );
  };

  const pillTitle = !models ? t("chat.menu.thinking") : thought ? t("chat.thought.change") : t("chat.model.change");

  return (
    <div className="chat-mode-anchor" ref={anchorRef}>
      <button
        ref={pillRef}
        type="button"
        className="chat-mode-pill chat-model-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        title={busy ? `${pillTitle} - ${t("chat.model.nextTurn")}` : pillTitle}
        onClick={() => {
          if (!open) {
            setOlderOpen(olderHasCurrent);
            setQuery("");
            setOlderGroups(new Set());
            setRecents(readJson(recentKey(agent), isStringArray, []));
            const g = grouped?.groups.find((x) => x.latest.some((m) => m.modelId === currentId) || x.older.some((m) => m.modelId === currentId)) ?? grouped?.groups[0];
            setOpenGroups(new Set(g ? [g.key] : []));
          } else setQuery("");
          setOpen((o) => !o);
        }}
      >
        <ChipIcon size={15} />
        <span className="chat-mode-name">{models ? (grouped?.names.get(currentId ?? "") ?? current?.name ?? currentId) : (level?.name ?? thought?.currentId)}</span>
        {models && level && <span className="chat-model-level">· {level.name}</span>}
      </button>
      {open && (
        <div className="chat-menu chat-mode-menu chat-model-menu" role="menu" aria-label={t(models ? "chat.menu.model" : "chat.menu.thinking")} ref={menuRef} onKeyDown={onMenuKeyDown}>
          <div className="chat-model-head">
            {searchable && models ? (
              <label className="chat-model-search">
                <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="6.5" />
                  <path d="m16 16 4.5 4.5" />
                </svg>
                <input
                  ref={searchRef}
                  type="text"
                  className="chat-model-search-input"
                  placeholder={t("chat.model.search", { count: models.availableModels.length })}
                  aria-label={t("chat.menu.model")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            ) : (
              models && split && <div className="chat-mode-caption">{t("chat.menu.model")}</div>
            )}
            {busy && <div className="chat-model-hint">{t("chat.model.nextTurn")}</div>}
          </div>
          {models && split && (
            <div className="chat-model-scroll">
              {q ? (
                matches.length ? (
                  matches.map((m) => renderCompact(m, { label: grouped?.groupOf.get(m.modelId) }))
                ) : (
                  <div className="chat-model-empty">{t("chat.model.noMatch", { query: q })}</div>
                )
              ) : grouped ? (
                <>
                  {showRecents && (
                    <>
                      <div className="chat-mode-caption">{t("chat.model.recent")}</div>
                      {recentModels.map((m) => renderCompact(m, { label: grouped.groupOf.get(m.modelId) }))}
                      <div className="chat-model-sep" role="separator" />
                    </>
                  )}
                  {grouped.groups.map((g) => {
                    const isOpen = openGroups.has(g.key);
                    const all = g.latest.concat(g.older);
                    const cur = all.find((m) => m.modelId === currentId);
                    // With the current model among the older ones they stay shown, so no toggle.
                    const olderForced = g.older.some((m) => m.modelId === currentId);
                    const olderShown = olderForced || olderGroups.has(g.key);
                    const moreBtn = g.older.length > 0 && !olderForced && (
                      <button type="button" data-nav="" data-group-key={g.key} className="chat-model-more" onClick={() => toggleIn(setOlderGroups, g.key)}>
                        {olderShown ? t("chat.model.olderHide") : t("chat.model.olderCount", { count: g.older.length })}
                      </button>
                    );
                    return (
                      <Fragment key={g.key}>
                        <button
                          type="button"
                          data-nav=""
                          data-group-key={g.key}
                          className={"chat-model-grp" + (isOpen ? " is-open" : "")}
                          aria-expanded={isOpen}
                          onClick={() => toggleIn(setOpenGroups, g.key)}
                        >
                          <span className="chat-model-grp-chev" aria-hidden="true">
                            ›
                          </span>
                          <span className="chat-model-grp-name">{g.label}</span>
                          <span className="chat-model-grp-count">{all.length}</span>
                          {!isOpen && cur && <span className="chat-model-grp-current">✓ {grouped.names.get(cur.modelId) ?? cur.name}</span>}
                        </button>
                        {isOpen && (
                          <>
                            {g.latest.map((m) => renderCompact(m, { groupKey: g.key }))}
                            {!olderShown && moreBtn}
                            {olderShown && g.older.map((m) => renderCompact(m, { groupKey: g.key, old: true }))}
                            {olderShown && moreBtn}
                          </>
                        )}
                      </Fragment>
                    );
                  })}
                </>
              ) : (
                <>
                  {renderList(split.latest)}
                  {hasOlder && (
                    <>
                      <div className="chat-model-sep" role="separator" />
                      <button
                        type="button"
                        role="menuitem"
                        data-older-toggle=""
                        className="chat-mode-item chat-model-older"
                        aria-haspopup="menu"
                        aria-expanded={showOlder}
                        onClick={() => setOlderOpen((o) => !o)}
                      >
                        <span className="chat-mode-text">
                          <span className="chat-mode-title">{t("chat.model.older")}</span>
                          {!showOlder && olderHasCurrent && current && <span className="chat-mode-desc">{current.name}</span>}
                        </span>
                        <span className={`chat-model-chevron${showOlder ? " is-open" : ""}`} aria-hidden="true">
                          ›
                        </span>
                      </button>
                      {showOlder && (
                        <div role="group" data-older-list="" aria-label={t("chat.model.older")}>
                          {renderList(split.older)}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}
          {thought && (
            <div className="chat-model-foot">
              <div className="chat-think">
                <div className="chat-think-head">
                  <span>{t("chat.menu.thinking")}</span>
                  <b>{level?.name ?? thought.currentId}</b>
                </div>
                <div className="chat-think-seg" role="radiogroup" aria-label={t("chat.menu.thinking")}>
                  <i className="chat-think-fill" style={{ width: `calc((100% - 24px) * ${thoughtFill(thought)})` }} aria-hidden="true" />
                  {thought.available.map((l, i) => {
                    const on = l.id === thought.currentId;
                    const past = i < thought.available.findIndex((x) => x.id === thought.currentId);
                    return (
                      <button
                        key={l.id}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={l.name}
                        tabIndex={on ? 0 : -1}
                        className={`chat-think-opt${on ? " is-on" : past ? " is-past" : ""}`}
                        title={l.description ? `${l.name}: ${l.description}` : l.name}
                        onClick={() => {
                          if (!on) chat.setThought(l.id);
                        }}
                      >
                        <i aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
                <div className="chat-think-ends" aria-hidden="true">
                  <span>{thought.available[0].name}</span>
                  <span>{thought.available[thought.available.length - 1].name}</span>
                </div>
                {level?.description && <div className="chat-mode-desc chat-think-desc">{level.description}</div>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
