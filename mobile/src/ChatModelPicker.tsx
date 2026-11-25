import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ChatModelOption, ChatModels, ChatThought } from "../../src/chat/chatTypes";
import { GROUP_MIN, groupModels, matchesModel } from "../../src/chat/modelGroups";
import { splitModelVersions } from "../../src/chat/modelVersions";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { useBackHandler, useEscape } from "./back";
import { tapFeedback } from "./haptics";
import { t } from "./i18n";
import { showToast } from "./remote";
import { safeStorage } from "./store";
import { CheckIcon, ChevronDownIcon, CloseIcon, Svg } from "./icons";

const ChipIcon = ({ size = 18 }: { size?: number }) => (
  <Svg size={size}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M10 10h4v4h-4zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
  </Svg>
);

/** How far along the track the current thinking level sits, 0 to 1. */
function thoughtFill(thought: ChatThought): number {
  const at = thought.available.findIndex((l) => l.id === thought.currentId);
  return thought.available.length > 1 && at > 0 ? at / (thought.available.length - 1) : 0;
}

const RECENT_MAX = 3;
const recentKey = (agent: string) => `flowcode.chatRecentModels.${agent}`;

function readRecents(agent: string): string[] {
  try {
    const v: unknown = JSON.parse(safeStorage.get(recentKey(agent)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

const LONG_PRESS_MS = 500;

/** Keeps the keyboard where it is while the pill is tapped. */
const keepFocus = {
  onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
  onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
};

/** The composer's model pill and the bottom drawer it opens, styled like the mode
 * picker; the newest models come first and older versions sit behind an expandable row.
 * `models` is null when the agent offers no choice (or the desktop can't switch). */
export function ChatModelPicker({
  models,
  thought = null,
  busy,
  agent,
  onModel,
  onThought,
}: {
  models: ChatModels | null;
  /** The agent id: recent models are remembered per agent. */
  agent: string;
  /** The thinking levels (more than one), shown under the models; the pill also shows the current one. */
  thought?: ChatThought | null;
  busy: boolean;
  onModel: (modelId: string) => void;
  onThought?: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [olderOpen, setOlderOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [olderGroups, setOlderGroups] = useState<Set<string>>(new Set());
  const [recents, setRecents] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const swallowClick = useRef(false);
  // A press still pending when the picker closes must not toast afterwards.
  useEffect(() => () => window.clearTimeout(press.current?.timer), []);
  const split = useMemo(() => (models ? splitModelVersions(models.availableModels) : null), [models]);
  const grouped = useMemo(() => (models ? groupModels(models.availableModels) : null), [models]);
  const searchable = !!models && models.availableModels.length >= GROUP_MIN;
  const close = () => {
    setOpen(false);
    setQuery("");
    setSearchFocused(false);
  };
  useEscape(open, close);
  useBackHandler(open, close);
  if ((!models || !split) && !thought) return null;
  const current = models?.availableModels.find((m) => m.modelId === models.currentModelId);
  const modelName = models ? (grouped?.names.get(models.currentModelId) ?? current?.name ?? models.currentModelId) : null;
  const level = thought ? (thought.available.find((l) => l.id === thought.currentId) ?? null) : null;
  // Without a model choice the pill shows just the level.
  const name = modelName ?? level?.name ?? thought?.currentId ?? "";
  const olderHasCurrent = !!models && !!split && split.older.some((m) => m.modelId === models.currentModelId);

  const pick = (id: string) => {
    const next = [id, ...recents.filter((r) => r !== id)].slice(0, RECENT_MAX);
    setRecents(next);
    safeStorage.set(recentKey(agent), JSON.stringify(next));
    tapFeedback();
    searchRef.current?.blur();
    close();
    if (id !== models?.currentModelId) onModel(id);
  };

  const toggleIn = (set: (f: (prev: Set<string>) => Set<string>) => void, key: string) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  /** Long press shows the model's description; the click that follows is swallowed. */
  const pressProps = (m: ChatModelOption) => ({
    onPointerDown: (e: React.PointerEvent) => {
      cancelPress();
      swallowClick.current = false;
      const timer = window.setTimeout(() => {
        press.current = null;
        swallowClick.current = true;
        tapFeedback();
        showToast(m.description ?? m.modelId);
      }, LONG_PRESS_MS);
      press.current = { timer, x: e.clientX, y: e.clientY };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancelPress();
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    // Keep the search focused (and the keyboard up) until the tap lands, so the layout doesn't shift under it.
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });
  /** Runs `fn` unless the click is the tail of a long press. */
  const tap = (fn: () => void) => () => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    fn();
  };

  const q = query.trim();
  const matches = q && models ? models.availableModels.filter((m) => matchesModel(m, q, grouped?.groupOf.get(m.modelId))) : [];
  const recentModels = models && grouped ? recents.map((id) => models.availableModels.find((m) => m.modelId === id)).filter((m): m is ChatModelOption => !!m) : [];
  const showRecents = !q && recentModels.length >= 2;

  const renderCompact = (m: ChatModelOption, opts: { label?: string; old?: boolean } = {}) => {
    const on = m.modelId === models?.currentModelId;
    return (
      <div key={m.modelId} className={"chat-mode-row compact" + (on ? " on" : "") + (opts.old ? " old" : "")}>
        <button type="button" role="radio" aria-checked={on} className="chat-mode-pick chat-model-compact" {...pressProps(m)} onClick={tap(() => pick(m.modelId))}>
          <span className="chat-model-check">{on && <CheckIcon />}</span>
          <span className="chat-mode-text">
            <span className="chat-model-compact-name">{grouped?.names.get(m.modelId) ?? m.name}</span>
            {on && <span className="chat-model-compact-id">{m.modelId}</span>}
          </span>
          {opts.label && <span className="chat-model-compact-group">{opts.label}</span>}
        </button>
      </div>
    );
  };

  const renderGrouped = () => {
    if (!grouped || !models) return null;
    const currentId = models.currentModelId;
    return (
      <>
        {showRecents && (
          <>
            <div className="chat-model-cap">{t("chatModelRecent")}</div>
            <div className="chat-model-recent">
              {recentModels.map((m) => {
                const on = m.modelId === currentId;
                return (
                  <button key={m.modelId} type="button" className={"chat-model-rc" + (on ? " on" : "")} {...pressProps(m)} onClick={tap(() => pick(m.modelId))}>
                    {grouped.names.get(m.modelId) ?? m.name}
                    <small>{grouped.groupOf.get(m.modelId)}</small>
                  </button>
                );
              })}
            </div>
          </>
        )}
        {grouped.groups.map((g) => {
          const isOpen = openGroups.has(g.key);
          const all = g.latest.concat(g.older);
          const cur = all.find((m) => m.modelId === currentId);
          const olderForced = g.older.some((m) => m.modelId === currentId);
          const olderShown = olderForced || olderGroups.has(g.key);
          return (
            <Fragment key={g.key}>
              <button
                type="button"
                className={"chat-model-grp" + (isOpen ? " open" : "")}
                aria-expanded={isOpen}
                onClick={() => {
                  tapFeedback();
                  toggleIn(setOpenGroups, g.key);
                }}
              >
                <span className="chat-model-grp-chev">
                  <ChevronDownIcon />
                </span>
                <b>{g.label}</b>
                <span className="chat-model-grp-count">{all.length}</span>
                {!isOpen && cur && <span className="chat-model-grp-cur">✓ {grouped.names.get(cur.modelId) ?? cur.name}</span>}
              </button>
              {isOpen && (
                <>
                  {g.latest.map((m) => renderCompact(m))}
                  {olderShown && g.older.map((m) => renderCompact(m, { old: true }))}
                  {g.older.length > 0 && !olderForced && (
                    <button
                      type="button"
                      className="chat-model-more"
                      onClick={() => {
                        tapFeedback();
                        toggleIn(setOlderGroups, g.key);
                      }}
                    >
                      {olderShown ? t("chatModelOlderHide") : t("chatModelOlderCount", { count: g.older.length })}
                    </button>
                  )}
                </>
              )}
            </Fragment>
          );
        })}
      </>
    );
  };

  const renderList = (list: ChatModelOption[]) =>
    list.map((m, i) => {
      const on = m.modelId === models?.currentModelId;
      const newGroup = m.group && m.group !== list[i - 1]?.group;
      return (
        <Fragment key={m.modelId}>
          {newGroup && <div className="chat-model-group">{m.group}</div>}
          <div className={"chat-mode-row" + (on ? " on" : "")}>
            <button
              type="button"
              role="radio"
              aria-checked={on}
              className="chat-mode-pick"
              onClick={() => {
                tapFeedback();
                close();
                if (!on) onModel(m.modelId);
              }}
            >
              <span className="chat-model-check">{on && <CheckIcon />}</span>
              <span className="chat-mode-text">
                <span className="chat-mode-name">{m.name}</span>
                {m.description && <span className="chat-mode-desc">{m.description}</span>}
              </span>
            </button>
          </div>
        </Fragment>
      );
    });

  return (
    <div className="chat-mode chat-model">
      <AdaptiveSheet open={open} onClose={close} variant="drawer" side="right" portal panelClass={grouped ? "chat-model-sheet tall" : "chat-model-sheet"} label={t(models ? "chatModel" : "chatThinkingLevel")}>
        <div className="tm-grabber" />
        <header className="tm-sheet-head">
          <h2>{t(models ? "chatModel" : "chatThinkingLevel")}</h2>
          <button type="button" className="tm-btn" aria-label={t("closeViewer")} onClick={close}>
            <CloseIcon />
          </button>
        </header>
        {searchable && models && (
          <label className="chat-model-search">
            <Svg size={18}>
              <circle cx="11" cy="11" r="6.5" />
              <path d="m16 16 4.5 4.5" />
            </Svg>
            <input
              ref={searchRef}
              type="search"
              enterKeyHint="search"
              className="chat-model-search-input"
              placeholder={t("chatModelSearch", { count: models.availableModels.length })}
              aria-label={t("chatModel")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (q && matches.length) pick(matches[0].modelId);
                }
              }}
            />
            {query && (
              <button
                type="button"
                className="chat-model-search-clear"
                aria-label={t("chatModelSearchClear")}
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
              >
                <CloseIcon />
              </button>
            )}
          </label>
        )}
        <div className="chat-pick-body">
          {busy && <div className="chat-model-hint">{t("chatModelNextTurn")}</div>}
          {models && split && (
            <div role="radiogroup" aria-label={t("chatModel")}>
              {q ? (
                matches.length ? (
                  matches.map((m) => renderCompact(m, { label: grouped?.groupOf.get(m.modelId) }))
                ) : (
                  <div className="chat-model-empty">{t("chatModelNoMatch", { query: q })}</div>
                )
              ) : grouped ? (
                renderGrouped()
              ) : (
                <>
              {renderList(split.latest)}
              {split.older.length > 0 && (
            <>
              <div className="chat-mode-row">
                <button
                  type="button"
                  className="chat-mode-pick"
                  aria-expanded={olderOpen}
                  onClick={() => {
                    tapFeedback();
                    setOlderOpen(!olderOpen);
                  }}
                >
                  <span className="chat-mode-text">
                    <span className="chat-mode-name">{t("chatModelOlder")}</span>
                    {!olderOpen && olderHasCurrent && <span className="chat-mode-desc">{name}</span>}
                  </span>
                  <span className={"chat-model-chevron" + (olderOpen ? " open" : "")}>
                    <ChevronDownIcon />
                  </span>
                </button>
              </div>
              {olderOpen && renderList(split.older)}
            </>
              )}
                </>
              )}
            </div>
          )}
        </div>
        {thought && onThought && !searchFocused && (
          <div className="chat-model-foot">
            <div className="chat-think">
              <div className="chat-think-head">
                <span>{t("chatThinkingLevel")}</span>
                <b>{level?.name ?? thought.currentId}</b>
              </div>
              <div
                className="chat-think-seg"
                role="radiogroup"
                aria-label={t("chatThinkingLevel")}
                onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
                onPointerMove={(e) => {
                  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  const n = thought.available.length;
                  const at = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left - 14) / (r.width - 28))) * (n - 1));
                  const next = thought.available[at];
                  if (next && next.id !== thought.currentId) {
                    tapFeedback();
                    onThought(next.id);
                  }
                }}
              >
                <i className="chat-think-fill" style={{ width: `calc((100% - 28px) * ${thoughtFill(thought)})` }} aria-hidden="true" />
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
                      className={on ? "on" : past ? "past" : ""}
                      onClick={() => {
                        tapFeedback();
                        if (!on) onThought(l.id);
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
              {level?.description && <div className="chat-think-desc">{level.description}</div>}
            </div>
          </div>
        )}
      </AdaptiveSheet>
      <button
        type="button"
        {...keepFocus}
        className="chat-mode-pill chat-model-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={models ? t("chatModelAria", { name }) + (level ? `, ${t("chatThinkingLevel")}: ${level.name}` : "") : `${t("chatThinkingLevel")}: ${name}`}
        onClick={() => {
          if (!open) {
            (document.activeElement as HTMLElement | null)?.blur();
            setOlderOpen(olderHasCurrent);
            setQuery("");
            setSearchFocused(false);
            setOlderGroups(new Set());
            setRecents(readRecents(agent));
            const g = grouped?.groups.find((x) => x.latest.concat(x.older).some((m) => m.modelId === models?.currentModelId)) ?? grouped?.groups[0];
            setOpenGroups(new Set(g ? [g.key] : []));
            setOpen(true);
          } else close();
        }}
      >
        <ChipIcon />
        <span>{name}</span>
        <span className="chat-pill-chevron">
          <ChevronDownIcon />
        </span>
      </button>
    </div>
  );
}
