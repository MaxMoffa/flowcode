import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { t, useI18n } from "../i18n";
import { rememberVisit, remoteEntries, useHost, useHostState } from "./remoteHosts";
import { RemoteChatView } from "./RemoteChatView";
import { RemoteTerminalView } from "./RemoteTerminalView";
import { remoteTextBackend } from "./remoteTextFile";
import { renameRemoteEditor, setRemoteEditorDirty, showRemoteEditor, stashRemoteDraft, useRemoteEditors } from "./remoteFiles";
import { TextFileBackendContext } from "../editor/textFileBackend";
import type { EditorHandle } from "../editor/EditorView";
import { RemoteDiffViewer } from "./RemoteDiffViewer";
import { RemoteLinks } from "./RemoteLinks";
import { useRemoteBrowserMirror } from "./remoteBrowserMirror";
import "./remote-hosts.css";

const EditorView = lazy(() => import("../editor/EditorView").then((m) => ({ default: m.EditorView })));

/** The content area while another PC is in front. Tabs already visited stay mounted (switching is instant); only the active one is shown.
 * Mounted with `key={hostId}`, so leaving a PC stops its streams. */
export function RemoteWorkspace({ hostId }: { hostId: string }) {
  useI18n();
  const host = useHost(hostId);
  useRemoteBrowserMirror(hostId);
  const { tabs, chats, activeKey } = useHostState(hostId);
  const entries = remoteEntries(tabs, chats);
  const editors = useRemoteEditors(hostId);
  const backend = useMemo(() => remoteTextBackend(hostId), [hostId]);
  const handles = useRef(new Map<string, EditorHandle>());
  // The `seq` of the open each editor was last scrolled for (the ref callback below runs on every render).
  const scrolled = useRef(new Map<string, number>());
  const [visited, setVisited] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!activeKey) return;
    // Closed tabs are dropped first: they would count against the cap of chats kept mounted.
    const live = new Set(remoteEntries(tabs, chats).map((e) => e.key));
    setVisited((prev) => {
      const kept = prev.filter((k) => live.has(k));
      if (kept[kept.length - 1] === activeKey && kept.length === prev.length) return prev;
      return rememberVisit(kept, activeKey);
    });
    // The host's tab changed (from anywhere): its content is wanted, not an editor.
    showRemoteEditor(hostId, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  // Opening a file again with a line scrolls its editor there (a new editor does it once loaded).
  const frontTab = editors.tabs.find((f) => f.path === editors.front);
  useEffect(() => {
    const handle = frontTab && handles.current.get(frontTab.path);
    if (frontTab && handle && frontTab.line !== undefined) {
      scrolled.current.set(frontTab.path, frontTab.seq);
      handle.scrollToLine(frontTab.line);
    }
  }, [frontTab?.path, frontTab?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  const mounted = entries.filter((e) => e.key === activeKey || visited.includes(e.key));

  return (
    <div className="remote-workspace">
      {mounted.map((entry) =>
        entry.kind === "pty" ? (
          <RemoteLinks key={entry.key} hostId={hostId} cwd={entry.tab.cwd || undefined}>
            <RemoteTerminalView hostId={hostId} ptyId={entry.tab.ptyId} visible={entry.key === activeKey && !editors.front} cwd={entry.tab.cwd || undefined} />
          </RemoteLinks>
        ) : (
          <RemoteChatView key={entry.key} hostId={hostId} chatId={entry.chat.chatId} hidden={entry.key !== activeKey || !!editors.front} />
        ),
      )}
      <TextFileBackendContext.Provider value={backend}>
        {editors.tabs.map((file) => (
          <Suspense key={file.path} fallback={null}>
            <EditorView
              ref={(handle) => {
                if (handle) {
                  handles.current.set(file.path, handle);
                  // A new editor: carry the line it was opened with (kept until its text is loaded).
                  if (file.line !== undefined && scrolled.current.get(file.path) !== file.seq) {
                    scrolled.current.set(file.path, file.seq);
                    handle.scrollToLine(file.line);
                  }
                } else handles.current.delete(file.path);
              }}
              path={file.path}
              initialContent={file.draft}
              onUnmountDirty={(text) => stashRemoteDraft(hostId, file.path, text)}
              hidden={file.path !== editors.front}
              onDirtyChange={(dirty) => setRemoteEditorDirty(hostId, file.path, dirty)}
              onRenamed={(newPath) => renameRemoteEditor(hostId, file.path, newPath)}
            />
          </Suspense>
        ))}
      </TextFileBackendContext.Provider>
      <RemoteDiffViewer hostId={hostId} />
      {!activeKey && !editors.front && (
        <div className="remote-empty">
          {host?.status === "online" ? t("remoteHosts.noTabs", { name: host.hostName }) : host?.status === "connecting" ? t("remoteHosts.status.connectingDots") : t("remoteHosts.offlineEmpty", { name: host?.hostName ?? "" })}
        </div>
      )}
    </div>
  );
}
