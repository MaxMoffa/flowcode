import { useEffect, useRef, useState } from "react";
import { DUR, motionMs } from "../lib/motion";
import { GitPanel } from "../git/GitPanel";
import type { GitChange, GitStatus } from "../git/gitStatus";
import { readBool, readNumber, usePersistentState, writeBool, writeString } from "../lib/storage";
import { useI18n } from "../i18n";

const OPEN_KEY = "flowcode.gitDock.open";
const HEIGHT_KEY = "flowcode.gitDock.height";
const FULL_KEY = "flowcode.gitDock.full";
const BAR_H = 34;
const MIN_H = 120;
// Room kept for the tree's header when the dock is dragged/toggled to full height.
const TREE_MIN = 60;

const readOpen = (key: string) => readBool(key, false);
const readFull = (key: string) => readBool(key, false);
const readHeight = (key: string) => readNumber(key, 300, MIN_H, 5000);
const writeHeight = (key: string, value: number) => writeString(key, String(Math.round(value)));

const branchIcon = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="5.5" r="2" />
    <circle cx="6" cy="18.5" r="2" />
    <circle cx="18" cy="8.5" r="2" />
    <path d="M6 7.5v9M18 10.5c0 4-6 3-11 6.5" />
  </svg>
);

interface GitDockProps {
  cwd: string;
  /** Whether the Explorer tab is showing. */
  visible: boolean;
  onOpenFile: (absPath: string) => void;
  onOpenDiff: (root: string, change: GitChange, staged: boolean) => void;
  onStatusChange: (s: { root: string; status: GitStatus } | null) => void;
  /** Derived by the Sidebar from the status, so the bar keeps no state of its own. */
  summary: { branch: string | null; ahead: number; behind: number; count: number } | null;
}

/** Git drawer docked at the bottom of the Explorer tab. The panel inside stays
 * mounted while closed: it keeps the draft commit message and keeps feeding the
 * tree's decorations. */
export function GitDock({ cwd, visible, onOpenFile, onOpenDiff, onStatusChange, summary }: GitDockProps) {
  const { t } = useI18n();
  const [open, setOpen] = usePersistentState(OPEN_KEY, readOpen, writeBool);
  const [height, setHeight] = usePersistentState(HEIGHT_KEY, readHeight, writeHeight);
  const [full, setFull] = usePersistentState(FULL_KEY, readFull, writeBool);
  // The height only animates on open/close/full toggles, never while dragging.
  const [animating, setAnimating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  // Closing, the body stays drawn until the height transition is over (it used to vanish first, then the box shrank empty).
  const [bodyShown, setBodyShown] = useState(open);
  const settle = () => {
    setAnimating(false);
    if (!open) setBodyShown(false);
  };
  useEffect(() => {
    if (open) setBodyShown(true);
    if (!animating) {
      if (!open) setBodyShown(false);
      return;
    }
    // transitionend never comes for a 0ms (reduced motion) or interrupted transition.
    const timer = window.setTimeout(settle, motionMs(DUR[3]) + 80);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, animating]);
  // The drag writes the height straight to the element once a frame; state (and storage) only on release.
  const drag = useRef({ raf: 0, next: 0, moved: false });

  const toggle = () => {
    setAnimating(true);
    setOpen(!open);
  };

  const onSashPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setAnimating(false);
    setDragging(true);
    drag.current.moved = false;
  };
  const onSashPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const panel = dockRef.current?.parentElement?.getBoundingClientRect();
    if (!panel) return;
    const max = Math.max(MIN_H, panel.height - TREE_MIN);
    const d = drag.current;
    d.next = Math.min(max, Math.max(MIN_H, panel.bottom - e.clientY));
    d.moved = true;
    if (!d.raf)
      d.raf = requestAnimationFrame(() => {
        d.raf = 0;
        if (dockRef.current) dockRef.current.style.height = `${d.next}px`;
      });
  };
  const endDrag = () => {
    const d = drag.current;
    if (d.raf) cancelAnimationFrame(d.raf);
    d.raf = 0;
    if (d.moved) {
      d.moved = false;
      setFull(false);
      setHeight(d.next);
    }
    setDragging(false);
  };

  const pill = summary && summary.count > 0 ? <span className="git-dock-pill">{t("git.dock.changes", { count: summary.count })}</span> : null;

  return (
    <div
      ref={dockRef}
      className={"git-dock" + (open ? " is-open" : "") + (animating ? " is-anim" : "")}
      style={{ height: open ? (full ? `calc(100% - ${TREE_MIN}px)` : height) : BAR_H }}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && e.propertyName === "height") settle();
      }}
    >
      {open && (
        <div
          className={"git-dock-sash" + (dragging ? " is-drag" : "")}
          role="separator"
          aria-orientation="horizontal"
          title={t("git.dock.resize")}
          onPointerDown={onSashPointerDown}
          onPointerMove={onSashPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => {
            setAnimating(true);
            setFull(!full);
          }}
        />
      )}
      <button type="button" className="git-dock-bar" aria-expanded={open} aria-label={t("git.dock.toggle")} onClick={toggle}>
        {open || !summary ? (
          <>
            <span>{t("git.dock.title")}</span>
            {pill}
          </>
        ) : (
          <>
            <span className="git-dock-branch">
              {branchIcon}
              <span className="git-dock-branch-name">{summary.branch ?? "HEAD"}</span>
            </span>
            {summary.ahead > 0 && <span className="git-dock-sync">{`↑${summary.ahead}`}</span>}
            {summary.behind > 0 && <span className="git-dock-sync">{`↓${summary.behind}`}</span>}
            {pill}
          </>
        )}
        <svg className="git-dock-chev" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 15 12 9 18 15" />
        </svg>
      </button>
      <div className="git-dock-body" hidden={!open && !bodyShown}>
        <GitPanel cwd={cwd} visible={visible} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} onStatusChange={onStatusChange} />
      </div>
    </div>
  );
}
