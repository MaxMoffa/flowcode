import { useCallback, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { t } from "./i18n";
import { BackIcon } from "./icons";
import { send, useRemote, type ConnStatus, type Tab } from "./remote";
import { TermActions } from "./TermActions";
import { TermFiles } from "./TermFiles";
import { TermKeyBar } from "./TermKeyBar";
import { TermMenu } from "./TermMenu";
import { DotsIcon, KeyboardIcon } from "./termIcons";
import { encodeKey, encodeText, useModifiers, type Active, type NamedKey } from "./termModifiers";
import { useTouchScroll } from "./termTouch";
import { useKeybarHeight, useTerminalViewport } from "./termViewport";
import { focusTerminal, useTerminal } from "./useTerminal";

/** Keeps the keyboard where it is while a button is tapped. */
const keepFocus = {
  onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
  onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
};

export function TerminalScreen({ tab, status, onBack }: { tab: Tab; status: ConnStatus; onBack: () => void }) {
  const screenRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { ptyId } = tab;
  const remote = useRemote();
  const { settings } = remote;
  const { mods, tap, lock, consume, peek } = useModifiers();

  /** What the user types (soft keyboard or symbol keys): armed modifiers apply. */
  const onInput = useCallback((data: string) => send({ t: "input", ptyId, data: encodeText(data, consume()) }), [ptyId, consume]);
  const { areaRef, hostRef, termRef, ended, atBottom } = useTerminal({
    ptyId,
    status,
    fontSize: settings?.terminalFontSize,
    themeKey: settings,
    onInput,
  });
  useTouchScroll(areaRef, termRef, ptyId);

  // The page never scrolls; the keyboard state comes from the viewport, so Back hiding the IME is noticed.
  const kbOpen = useTerminalViewport(
    screenRef,
    useCallback(() => termRef.current?.blur(), [termRef]),
  );
  useKeybarHeight(screenRef, barRef);

  const sendKey = (key: NamedKey) => {
    const appCursor = termRef.current?.modes.applicationCursorKeysMode ?? false;
    send({ t: "input", ptyId, data: encodeKey(key, consume(), appCursor) });
  };

  /** A cursor-pad step: modifiers were snapshotted at drag start and stay armed for the whole drag. */
  const padKey = (key: NamedKey, a: Active) => {
    const appCursor = termRef.current?.modes.applicationCursorKeysMode ?? false;
    send({ t: "input", ptyId, data: encodeKey(key, a, appCursor) });
  };

  const closeFiles = useCallback(() => setFilesOpen(false), []);
  const closeActions = useCallback(() => setActionsOpen(false), []);

  /** Types text as-is (no modifiers, never Enter), then hands the keyboard back to the terminal. */
  const typeText = useCallback(
    (text: string) => {
      send({ t: "input", ptyId, data: text });
      setFilesOpen(false);
      focusTerminal(termRef.current);
    },
    [ptyId, termRef],
  );

  function toggleKeyboard() {
    if (kbOpen) termRef.current?.blur();
    else focusTerminal(termRef.current);
  }

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const answer = (data: string) => send({ t: "input", ptyId, data });

  const state = tab.status === "waiting" ? "waiting" : tab.status === "busy" ? "busy" : "idle";
  const stateText = state === "waiting" ? t("termStateWaiting") : state === "busy" ? t("termStateBusy") : t("termStateIdle");
  const cliName = tab.cli ? tab.cli[0].toUpperCase() + tab.cli.slice(1) : "";
  const showWait = tab.status === "waiting" && !!tab.cli;

  return (
    <div className="screen term-screen" ref={screenRef}>
      <header className="term-head">
        <button type="button" className="tm-back" aria-label={t("back")} onClick={onBack}>
          <BackIcon />
        </button>
        <div className="term-titles">
          <i className={"term-dot is-" + state} />
          <span className="term-title">{tab.label}</span>
          <span className="term-state">{stateText}</span>
        </div>
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
            send({ t: "input", ptyId, data: "" });
          }}
        />
      </header>
      <div className="term-card">
        <div className="term-body">
          <div className="term-area" ref={areaRef} onClick={() => focusTerminal(termRef.current)}>
            {ended && <div className="ended">{t("ended")}</div>}
            <div ref={hostRef} className="term-host" />
          </div>
          {!atBottom && (
            <button
              type="button"
              className={"term-jump" + (kbOpen ? " kb" : "")}
              onPointerDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                termRef.current?.scrollToBottom();
              }}
            >
              {t("jumpToEnd")}
            </button>
          )}
          {!kbOpen && (
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
      </div>
      <TermKeyBar
        barRef={barRef}
        open={kbOpen}
        mods={mods}
        onTap={tap}
        onLock={lock}
        onKey={sendKey}
        onText={onInput}
        peek={peek}
        onPadKey={padKey}
        onPadDone={consume}
      />
      <TermFiles tab={tab} open={filesOpen} onClose={closeFiles} onType={typeText} />
      <TermActions tab={tab} actions={remote.actions} open={actionsOpen} onClose={closeActions} />
    </div>
  );
}
