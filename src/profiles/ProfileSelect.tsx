import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  /** The list is portaled out of the surrounding popup, so a hover-driven one
   * needs to hear the pointer move onto and off the list to stay open. */
  onMenuPointerEnter?: () => void;
  onMenuPointerLeave?: () => void;
}

const MENU_MARGIN = 8;

/** Fixed-position coordinates of the list: right-aligned under the button, or
 * above it (`bottom`) when there is little room below. */
interface MenuPos {
  right: number;
  top?: number;
  bottom?: number;
}

function placeMenu(button: HTMLElement): MenuPos {
  const rect = button.getBoundingClientRect();
  const right = Math.max(MENU_MARGIN, window.innerWidth - rect.right);
  const roomBelow = window.innerHeight - rect.bottom;
  if (roomBelow < 160 && rect.top > roomBelow) return { right, bottom: window.innerHeight - rect.top + 4 };
  return { right, top: rect.bottom + 4 };
}

/** Compact "dot + name + chevron" profile selector for a popup's title row.
 * The list is portaled to the body (fixed to the viewport) so a scrolling or
 * clipping popup around the button can't cut it; it carries
 * `data-profile-select-menu` so the popup can tell clicks in it from outside
 * ones. Renders nothing when there are no account profiles; when the filter
 * leaves only the default profile, shows the selection as a static label (no
 * list). */
export function ProfileSelect({ value, onChange, isStarred, footer, filter, onMenuPointerEnter, onMenuPointerLeave }: ProfileSelectProps) {
  const { t } = useI18n();
  const all = useProfiles().profiles;
  const profiles = filter ? all.filter(filter) : all;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pointerInMenu = useRef(false);
  const listId = useId();

  const items = [{ id: undefined as string | undefined, name: t("agents.profile.default"), color: undefined as string | undefined }, ...profiles];
  const current = profiles.find((p) => p.id === value);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const inside = (rootRef.current?.contains(target) ?? false) || (menuRef.current?.contains(target) ?? false);
      if (!inside) setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // The list is fixed to the viewport: follow the button on resize, close on
  // blur or when anything but the list itself scrolls.
  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      if (buttonRef.current) setPos(placeMenu(buttonRef.current));
    };
    const onBlur = () => setOpen(false);
    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onBlur);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // A list that goes away under the pointer never reports it leaving.
  useEffect(() => {
    if (open) return;
    if (pointerInMenu.current) {
      pointerInMenu.current = false;
      onMenuPointerLeave?.();
    }
  }, [open]);

  if (all.length === 0) return null;
  // Only the default profile is selectable: show the selection, don't open a list.
  const single = profiles.length === 0;

  function openList() {
    if (single) return;
    setActive(Math.max(0, items.findIndex((p) => p.id === (current ? value : undefined))));
    if (buttonRef.current) setPos(placeMenu(buttonRef.current));
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
    } else if (e.key === "Enter" && open && e.target === buttonRef.current) {
      e.preventDefault();
      pick(items[active]?.id);
    }
  }

  return (
    <div className="profile-select" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        className={"profile-select-btn" + (single ? " is-static" : "")}
        disabled={single}
        aria-haspopup={single ? undefined : "listbox"}
        aria-expanded={single ? undefined : open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
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
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="profile-select-menu"
          data-profile-select-menu
          style={{ right: pos.right, top: pos.top, bottom: pos.bottom }}
          onKeyDown={onKeyDown}
          onMouseEnter={() => {
            pointerInMenu.current = true;
            onMenuPointerEnter?.();
          }}
          onMouseLeave={() => {
            pointerInMenu.current = false;
            onMenuPointerLeave?.();
          }}
        >
          <div className="profile-select-list" id={listId} role="listbox">
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
        </div>,
        document.body,
      )}
    </div>
  );
}
