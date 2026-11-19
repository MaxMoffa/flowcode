import { useRef, useState, type PointerEvent } from "react";
import { t } from "./i18n";
import { safeStorage } from "./store";
import { WideGit, type GitSummary } from "./WideGit";

const OPEN_KEY = "wide.gitDock.open";
const HEIGHT_KEY = "wide.gitDock.height";
const FULL_KEY = "wide.gitDock.full";
const BAR_H = 34;
const MIN_H = 120;
// Room kept for the tree's header when the dock is dragged/toggled to full height.
const TREE_MIN = 60;

const readHeight = () => {
  const n = Number(safeStorage.get(HEIGHT_KEY));
  return Number.isFinite(n) && n >= MIN_H ? Math.min(n, 5000) : 300;
};

/** A boolean kept in localStorage. */
function useStoredBool(key: string): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => safeStorage.get(key) === "1");
  return [
    v,
    (next) => {
      setV(next);
      safeStorage.set(key, next ? "1" : "0");
    },
  ];
}

const branchIcon = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="5.5" r="2" />
    <circle cx="6" cy="18.5" r="2" />
    <circle cx="18" cy="8.5" r="2" />
    <path d="M6 7.5v9M18 10.5c0 4-6 3-11 6.5" />
  </svg>
);

interface Props {
  cwd: string;
  /** Whether the Explorer tab is showing. */
  visible: boolean;
  onOpenDiff: (root: string, path: string, staged: boolean, status: string) => void;
  /** The changed-file count, for the Explorer tab's pill. */
  onCount?: (n: number) => void;
}

/** The desktop's Git drawer, docked at the bottom of the Explorer tab (a flex child of the panel next to the tree). The panel inside stays mounted while closed: it keeps the draft commit message and the summary fresh. */
export function WideGitDock({ cwd, visible, onOpenDiff, onCount }: Props) {
  const [open, setOpen] = useStoredBool(OPEN_KEY);
  const [full, setFull] = useStoredBool(FULL_KEY);
  const [height, setHeightState] = useState(readHeight);
  const [summary, setSummary] = useState<GitSummary | null>(null);
  // The height only animates on open/close/full toggles, never while dragging.
  const [animating, setAnimating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef(height);

  const setHeight = (h: number) => {
    heightRef.current = h;
    setHeightState(h);
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setAnimating(false);
    setDragging(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const panel = dockRef.current?.parentElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    // The panel may sit under a CSS zoom: the scale is the on-screen size over the layout size.
    const scale = panel.offsetHeight > 0 ? rect.height / panel.offsetHeight : 1;
    const max = Math.max(MIN_H, panel.offsetHeight - TREE_MIN);
    if (full) setFull(false);
    setHeight(Math.min(max, Math.max(MIN_H, (rect.bottom - e.clientY) / scale)));
  };
  const endDrag = () => {
    if (!dragging) return;
    setDragging(false);
    safeStorage.set(HEIGHT_KEY, String(Math.round(heightRef.current)));
  };

  const pill = summary && summary.count > 0 ? <span className="git-dock-pill">{t("wsGitDockChanges", { count: summary.count })}</span> : null;

  return (
    <div ref={dockRef} className={"git-dock" + (open ? " is-open" : "") + (animating ? " is-anim" : "")} style={{ height: open ? (full ? `calc(100% - ${TREE_MIN}px)` : height) : BAR_H }}>
      {open && (
        <div
          className={"git-dock-sash" + (dragging ? " is-drag" : "")}
          role="separator"
          aria-orientation="horizontal"
          title={t("wsGitDockResize")}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => {
            setAnimating(true);
            setFull(!full);
          }}
        />
      )}
      <button
        type="button"
        className="git-dock-bar"
        aria-expanded={open}
        aria-label={t("wsGitDockToggle")}
        onClick={() => {
          setAnimating(true);
          setOpen(!open);
        }}
      >
        {open || !summary ? (
          <>
            <span>{t("wsGit")}</span>
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
      <div className="git-dock-body" hidden={!open}>
        <WideGit cwd={cwd} visible={visible} onOpenDiff={onOpenDiff} onCount={onCount} onStatus={setSummary} />
      </div>
    </div>
  );
}
