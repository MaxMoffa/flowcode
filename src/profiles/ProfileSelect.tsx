import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { useProfiles, type ProfileInfo } from "./profiles";
import "./profile-select.css";

interface ProfileSelectProps {
  /** The chosen profile id; `undefined` is the default profile. */
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  /** Marks a row with a star (the project's default profile). */
  isStarred?: (id: string | undefined) => boolean;
  /** Rendered under the list, inside the dropdown. */
  footer?: ReactNode;
  /** Limits which profiles are listed (the default one always is). */
  filter?: (profile: ProfileInfo) => boolean;
}

/** Compact "dot + name + chevron" profile selector for a popup's title row.
 * The list is an absolutely positioned child (not a portal) so a hover-driven
 * popover that contains it doesn't see the pointer leave. Renders nothing
 * when there are no account profiles; when the filter leaves only the default
 * profile, shows the selection as a static label (no list). */
export function ProfileSelect({ value, onChange, isStarred, footer, filter }: ProfileSelectProps) {
  const { t } = useI18n();
  const all = useProfiles().profiles;
  const profiles = filter ? all.filter(filter) : all;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const items = [{ id: undefined as string | undefined, name: t("agents.profile.default"), color: undefined as string | undefined }, ...profiles];
  const current = profiles.find((p) => p.id === value);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  if (all.length === 0) return null;
  // Only the default profile is selectable: show the selection, don't open a list.
  const single = profiles.length === 0;

  function openList() {
    if (single) return;
    setActive(Math.max(0, items.findIndex((p) => p.id === (current ? value : undefined))));
    setOpen(true);
  }

  function pick(id: string | undefined) {
    onChange(id);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape" && open) {
      // Only the list closes, not the popup around it.
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (single) return;
      if (!open) openList();
      else setActive((i) => (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      pick(items[active]?.id);
    }
  }

  return (
    <div className="profile-select" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={"profile-select-btn" + (single ? " is-static" : "")}
        disabled={single}
        aria-haspopup={single ? undefined : "listbox"}
        aria-expanded={single ? undefined : open}
        aria-controls={open ? listId : undefined}
        aria-label={t("agents.profile.label")}
        title={t("agents.profile.label")}
        onClick={() => (open ? setOpen(false) : openList())}
      >
        <span className={"profile-select-dot" + (current ? "" : " is-default")} style={current ? { background: current.color } : undefined} />
        <span className="profile-select-name">{current?.name ?? t("agents.profile.default")}</span>
        {!single && (
          <svg className="profile-select-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m6 9 6 6 6-6" />
          </svg>
        )}
      </button>
      {open && (
        <div className="profile-select-menu">
          <div className="profile-select-list" id={listId} role="listbox" aria-activedescendant={`${listId}-${active}`}>
            {items.map((p, i) => (
              <div
                key={p.id ?? "default"}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={p.id === (current ? value : undefined)}
                className={"profile-select-option" + (i === active ? " is-active" : "")}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(p.id)}
              >
                <span className={"profile-select-dot" + (p.color ? "" : " is-default")} style={p.color ? { background: p.color } : undefined} />
                <span className="profile-select-name">{p.name}</span>
                {isStarred?.(p.id) && (
                  <span className="profile-select-star" title={t("agents.profile.projectDefault")} aria-hidden>
                    ★
                  </span>
                )}
              </div>
            ))}
          </div>
          {footer}
        </div>
      )}
    </div>
  );
}
