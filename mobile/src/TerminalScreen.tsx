import { useCallback, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { t } from "./i18n";
import { AgentsIcon, BackIcon, DotsIcon, FolderIcon, KeyboardIcon } from "./icons";
import { interrupt, send, useRemoteSelector, useSupports, type ConnStatus, type Tab } from "./remote";
import { TermActions } from "./TermActions";
import { TermAgents } from "./TermAgents";
import { TermFiles } from "./TermFiles";
import { openLink, TermLink } from "./TermLink";
import { TermKeyBar } from "./TermKeyBar";
import { TermMenu } from "./TermMenu";
import { encodeKey, encodeText, useModifiers, type Active, type NamedKey } from "./termModifiers";
import { tapFeedback } from "./haptics";
import { phoneFontSize } from "./termFont";
import { linkAtCell } from "./termLinks";
import { useTouchScroll } from "./termTouch";
import { useKeybarHeight, useTerminalViewport } from "./termViewport";
import { focusTerminal, useTerminal } from "./useTerminal";

/** Keeps the keyboard where it is while a button is tapped. */
const keepFocus = {
  onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
  onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
};

/** `embedded`: the wide layout's main card; its header owns the files, quick actions and menu, so only the terminal and its docked key bar (shown while `keys`) remain. */
export function TerminalScreen({ tab, status, onBack, onSwitch, embedded, keys }: { tab: Tab; status: ConnStatus; onBack: () => void; onSwitch?: (ptyId: string) => void; embedded?: boolean; keys?: boolean }) {
  const screenRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const canRename = useSupports("rename");
  const [draft, setDraft] = useState("");
  const cancelRename = useRef(false);
  const lastLink = useRef({ url: "", at: 0 });
  const { ptyId } = tab;
  const settings = useRemoteSelector((s) => s.settings);
  const tabs = useRemoteSelector((s) => s.tabs);
  const othersWaiting = (tabs ?? []).filter((x) => x.cli && x.status === "waiting" && x.ptyId !== ptyId).length;
  const localFont = phoneFontSize.use().size;
  const actions = useRemoteSelector((s) => s.actions);
  const { mods, tap, lock, consume, peek } = useModifiers();

  /** What the user types (soft keyboard or symbol keys): armed modifiers apply. */
  const onInput = useCallback((data: string) => send({ t: "input", ptyId, data: encodeText(data, consume()) }), [ptyId, consume]);

  /** A link was tapped: open it at once when the user opted out of the prompt, else ask in the sheet. */
  const onLink = useCallback(
    (url: string) => {
      const now = Date.now();
      if (lastLink.current.url === url && now - lastLink.current.at < 600) return;
      lastLink.current = { url, at: now };
      if (settings?.confirmLinkOpen === false) void openLink(url);
      else setLinkUrl(url);
    },
    [settings?.confirmLinkOpen],
  );
  const { areaRef, hostRef, termRef, ended, atBottom, resetIme } = useTerminal({
    ptyId,
    status,
    fontSize: localFont ?? settings?.terminalFontSize,
    themeKey: settings,
    onInput,
    onLink,
  });
  useTouchScroll(areaRef, termRef, ptyId);

  /** A symbol key from the key bar: the keyboard's line ends there, so later corrections can't reach past it. */
  const onBarText = useCallback(
    (data: string) => {
      resetIme();
      onInput(data);
    },
    [resetIme, onInput],
  );

  // The page never scrolls; the keyboard state comes from the viewport, so Back hiding the IME is noticed.
  const kbOpen = useTerminalViewport(
    screenRef,
    useCallback(() => termRef.current?.blur(), [termRef]),
  );
  useKeybarHeight(screenRef, barRef);

  const sendKey = (key: NamedKey) => {
    resetIme();
    const appCursor = termRef.current?.modes.applicationCursorKeysMode ?? false;
    send({ t: "input", ptyId, data: encodeKey(key, consume(), appCursor) });
  };

  /** A cursor-pad step: modifiers were snapshotted at drag start and stay armed for the whole drag. */
  const padKey = (key: NamedKey, a: Active) => {
    resetIme();
    const appCursor = termRef.current?.modes.applicationCursorKeysMode ?? false;
    send({ t: "input", ptyId, data: encodeKey(key, a, appCursor) });
  };

  const closeFiles = useCallback(() => setFilesOpen(false), []);
  const closeAgents = useCallback(() => setAgentsOpen(false), []);
  const closeActions = useCallback(() => setActionsOpen(false), []);
  const closeLink = useCallback(() => setLinkUrl(null), []);

  /** Types text as-is (no modifiers, never Enter), then hands the keyboard back to the terminal. */
  const typeText = useCallback(
    (text: string) => {
      resetIme();
      send({ t: "input", ptyId, data: text });
      setFilesOpen(false);
      focusTerminal(termRef.current);
    },
    [ptyId, termRef, resetIme],
  );

  /** A tap that lands on a link opens it instead of raising the keyboard. */
  function onAreaTap(e: React.MouseEvent) {
    const term = termRef.current;
    const screen = areaRef.current?.querySelector<HTMLElement>(".xterm-screen");
    if (term && screen) {
      // The rect already reflects an over-wide pty panned by the area's scrollLeft.
      const r = screen.getBoundingClientRect();
      const col = Math.floor(((e.clientX - r.left) / r.width) * term.cols);
      const row = Math.floor(((e.clientY - r.top) / r.height) * term.rows);
      if (col >= 0 && col < term.cols && row >= 0 && row < term.rows) {
        const buf = term.buffer.active;
        const url = linkAtCell(buf, buf.viewportY + row, col);
        if (url) {
          tapFeedback();
          onLink(url);
          return;
        }
      }
    }
    focusTerminal(term);
  }

  function toggleKeyboard() {
    if (kbOpen) termRef.current?.blur();
    else focusTerminal(termRef.current);
  }

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const answer = (data: string) => send({ t: "input", ptyId, data });

  /** Ends the title edit: Escape sets `cancelRename` before blurring, so it is dropped here. */
  function commitRename() {
    if (cancelRename.current) {
      cancelRename.current = false;
      setEditing(false);
      return;
    }
    const label = draft.trim();
    setEditing(false);
    if (label && label !== tab.label) send({ t: "rename", ptyId, label });
  }

  const state = tab.status === "waiting" ? "waiting" : tab.status === "busy" ? "busy" : "idle";
  const stateText = state === "waiting" ? t("termStateWaiting") : state === "busy" ? t("termStateBusy") : t("termStateIdle");
  const cliName = tab.cli ? tab.cli[0].toUpperCase() + tab.cli.slice(1) : "";
  const showWait = tab.status === "waiting" && !!tab.cli;

  const more = !embedded && (
    <>
      <button type="button" className="tm-back" aria-label={t("termMore")} aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
        <DotsIcon />
      </button>
      <TermMenu
        open={menuOpen}
        kbOpen={kbOpen}
        onClose={closeMenu}
        onFiles={() => {
          setMenuOpen(false);
          setFilesOpen(true);
        }}
        onActions={() => {
          setMenuOpen(false);
          setActionsOpen(true);
        }}
        onKeyboard={() => {
          setMenuOpen(false);
          toggleKeyboard();
        }}
        onInterrupt={() => {
          setMenuOpen(false);
          interrupt(ptyId);
        }}
      />
    </>
  );

  const keyBar = (
    <TermKeyBar
      barRef={barRef}
      open={embedded ? !!keys : kbOpen && !editing}
      mods={mods}
      onTap={tap}
      onLock={lock}
      onKey={sendKey}
      onText={onBarText}
      peek={peek}
      onPadKey={padKey}
      onPadDone={consume}
      trailing={
        embedded && (
          <>
            <button type="button" {...keepFocus} className="tm-k tm-int" onClick={() => interrupt(ptyId)}>
              {t("termMenuInterrupt")}
            </button>
            <button type="button" {...keepFocus} className="tm-k" aria-label={kbOpen ? t("hideKeyboard") : t("showKeyboard")} onClick={toggleKeyboard}>
              <KeyboardIcon size={18} />
            </button>
          </>
        )
      }
    />
  );

  return (
    <div className={"screen term-screen" + (embedded ? " is-embedded" : "")} ref={screenRef}>
      {!embedded && (
        <header className="term-head">
          <button type="button" className="tm-back" aria-label={t("back")} onClick={onBack}>
            <BackIcon />
          </button>
          <div className="term-titles">
            <i className={"term-dot is-" + state} />
            {editing ? (
              <input
                className="term-title-input"
                value={draft}
                autoFocus
                maxLength={128}
                enterKeyHint="done"
                aria-label={t("renameTerminal")}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  else if (e.key === "Escape") {
                    cancelRename.current = true;
                    e.currentTarget.blur();
                  }
                }}
                onBlur={commitRename}
              />
            ) : !canRename ? (
              <span className="term-title">{tab.label}</span>
            ) : (
              <button
                type="button"
                className="term-title"
                aria-label={t("renameTerminal")}
                onClick={() => {
                  setDraft(tab.label);
                  setEditing(true);
                }}
              >
                {tab.label}
              </button>
            )}
            {!editing && <span className="term-state">{stateText}</span>}
          </div>
          {more}
        </header>
      )}
      <div className="term-card">
        <div className="term-body">
          <div className="term-area" ref={areaRef} onClick={onAreaTap}>
            {ended && <div className="ended">{t("ended")}</div>}
            <div ref={hostRef} className="term-host" />
          </div>
          {!atBottom && (
            <button
              type="button"
              className={"term-jump" + (kbOpen ? " kb" : "") + (!kbOpen && !embedded ? " pill" : "")}
              onPointerDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                termRef.current?.scrollToBottom();
              }}
            >
              {t("jumpToEnd")}
            </button>
          )}
          {!kbOpen && !embedded && (
            <div className="term-pill" role="toolbar" aria-label={t("termTools")}>
              <button type="button" aria-label={t("termMenuFiles")} onPointerDown={(e) => e.preventDefault()} onClick={() => setFilesOpen(true)}>
                <FolderIcon />
              </button>
              <i className="term-pill-sep" />
              <button
                type="button"
                aria-label={othersWaiting ? t("agentsWaitingAria", { n: othersWaiting }) : t("agents")}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => setAgentsOpen(true)}
              >
                <AgentsIcon />
                {othersWaiting > 0 && <b className="term-pill-badge">{othersWaiting}</b>}
              </button>
              <button type="button" className="term-pill-kb" aria-label={t("showKeyboard")} onPointerDown={(e) => e.preventDefault()} onClick={toggleKeyboard}>
                <KeyboardIcon size={21} />
              </button>
            </div>
          )}
          {!kbOpen && embedded && (
            <button type="button" className="term-fab" aria-label={t("showKeyboard")} onPointerDown={(e) => e.preventDefault()} onClick={toggleKeyboard}>
              <KeyboardIcon size={22} />
            </button>
          )}
        </div>
        {showWait && (
          <div className="term-wait" role="status">
            <span>{t("termWaitBanner", { cli: cliName })}</span>
            <button type="button" className="yes" {...keepFocus} onClick={() => answer("1")}>
              {t("termYes")}
            </button>
            <button type="button" {...keepFocus} onClick={() => answer("")}>
              {t("termNo")}
            </button>
          </div>
        )}
        {embedded && keyBar}
      </div>
      {!embedded && keyBar}
      {!embedded && <TermFiles tab={tab} open={filesOpen} onClose={closeFiles} onType={typeText} />}
      {!embedded && onSwitch && <TermAgents activePty={ptyId} open={agentsOpen} onClose={closeAgents} onOpen={onSwitch} />}
      {!embedded && <TermActions tab={tab} actions={actions} open={actionsOpen} onClose={closeActions} />}
      <TermLink url={linkUrl} onClose={closeLink} />
    </div>
  );
}
