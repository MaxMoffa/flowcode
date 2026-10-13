import { useCallback, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { StatusPill } from "./common";
import { t } from "./i18n";
import { BackIcon, BoltIcon, FolderIcon } from "./icons";
import { send, useRemote, type ConnStatus, type Tab } from "./remote";
import { TermActions } from "./TermActions";
import { TermFiles } from "./TermFiles";
import { TermKeyBar } from "./TermKeyBar";
import { homeCwd } from "./termShell";
import { encodeKey, encodeText, useModifiers, type NamedKey } from "./termModifiers";
import { useTouchScroll } from "./termTouch";
import { useKeybarHeight, useTerminalViewport } from "./termViewport";
import { focusTerminal, useTerminal } from "./useTerminal";

export function TerminalScreen({ tab, status, onBack }: { tab: Tab; status: ConnStatus; onBack: () => void }) {
  const screenRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const { ptyId } = tab;
  const remote = useRemote();
  const { settings } = remote;
  const { mods, tap, lock, consume } = useModifiers();

  /** What the user types (soft keyboard or symbol chips): armed modifiers apply. */
  const onInput = useCallback((data: string) => send({ t: "input", ptyId, data: encodeText(data, consume()) }), [ptyId, consume]);
  const { areaRef, hostRef, termRef, ended, dims, atBottom } = useTerminal({
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

  const sub = [tab.cli, homeCwd(tab.cwd)].filter(Boolean).join(" · ");
  const online = status === "online";

  return (
    <div className="screen term-screen" ref={screenRef}>
      <header className="term-head">
        <button type="button" className="tm-btn plain" aria-label={t("back")} onClick={onBack}>
          <BackIcon />
        </button>
        <div className="term-titles">
          <span className="term-title">{tab.label}</span>
          <span className="term-sub">{sub}</span>
        </div>
        {tab.cli ? <StatusPill status={tab.status} /> : null}
        <button type="button" className="tm-btn" aria-label={t("openFiles")} onClick={() => setFilesOpen(true)}>
          <FolderIcon />
        </button>
        <button type="button" className="tm-btn" aria-label={t("openFeatures")} onClick={() => setActionsOpen(true)}>
          <BoltIcon />
        </button>
      </header>
      <div className="term-card">
        <div className="term-strip">
          <span className="term-cwd">{homeCwd(tab.cwd)}</span>
          {dims && (
            <span className="term-dims">
              {dims.cols}×{dims.rows}
            </span>
          )}
          <span className={"term-live" + (online ? " on" : "")}>{online ? `● ${t("live")}` : t("offlineShort")}</span>
        </div>
        <div className="term-area" ref={areaRef} onClick={() => focusTerminal(termRef.current)}>
          {ended && <div className="ended">{t("ended")}</div>}
          <div ref={hostRef} className="term-host" />
        </div>
        {!atBottom && (
          <button
            type="button"
            className="term-jump"
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              termRef.current?.scrollToBottom();
            }}
          >
            {t("jumpToEnd")}
          </button>
        )}
      </div>
      <TermKeyBar
        barRef={barRef}
        mods={mods}
        onTap={tap}
        onLock={lock}
        onKey={sendKey}
        onText={onInput}
        onRaw={(seq) => send({ t: "input", ptyId, data: seq })}
        kbOpen={kbOpen}
        onToggleKeyboard={toggleKeyboard}
      />
      <TermFiles tab={tab} open={filesOpen} onClose={closeFiles} onType={typeText} />
      <TermActions tab={tab} actions={remote.actions} open={actionsOpen} onClose={closeActions} />
    </div>
  );
}
