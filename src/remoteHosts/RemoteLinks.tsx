import { useMemo, type ReactNode } from "react";
import { openUrlInPreview } from "../browser/browserStore";
import { FileLinkActionsContext, FileLinkCwdContext, FileLinkResolverContext, type FileLinkActions } from "../lib/fileLinks";
import { LinkRewriteContext } from "../terminal/useOpenLink";
import { absoluteRemote, checkRemotePath, openRemoteFile } from "./remoteFiles";
import { useHost } from "./remoteHosts";
import { chatFileUrl, tunnelUrl } from "./remoteTunnel";

/** `path` relative to `cwd` with forward slashes, or null when it is not under it. */
export function relativeToFolder(path: string, cwd: string): string | null {
  const full = absoluteRemote(path, cwd);
  const base = absoluteRemote(cwd, null);
  if (!full || !base) return null;
  const windows = /^[A-Za-z]:|^\\\\/.test(base);
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const [f, b] = [norm(full), norm(base)];
  const [fc, bc] = windows ? [f.toLowerCase(), b.toLowerCase()] : [f, b];
  return fc.startsWith(bc + "/") ? f.slice(b.length + 1) : null;
}

/** What links in a view of another PC do here: its localhost addresses go through a tunnel to this PC's browser panel, and the paths in its chat resolve against its disk and open in a read-only viewer (or, for pages, in the browser panel through that PC's file server). */
export function RemoteLinks({ hostId, chatId, cwd, children }: { hostId: string; chatId?: string; cwd?: string; children: ReactNode }) {
  const host = useHost(hostId);
  const canExplore = !!host?.caps.includes("fileExplorer");
  const canPreview = !!host?.caps.includes("chatPreview");
  const rewrite = useMemo(() => (url: string) => tunnelUrl(hostId, url), [hostId]);
  const resolver = useMemo(() => (canExplore ? (path: string, base: string | null) => checkRemotePath(hostId, path, base) : () => Promise.resolve(null)), [hostId, canExplore]);
  const actions = useMemo<FileLinkActions>(
    () => ({
      remote: true,
      openInEditor: (path, line) => openRemoteFile({ hostId, path, line }),
      browseFolder: () => {},
      openInPreview: (path) => {
        const rel = chatId && cwd && canPreview ? relativeToFolder(path, cwd) : null;
        if (rel && chatId) void chatFileUrl(hostId, chatId, rel).then((url) => openUrlInPreview(url), () => openRemoteFile({ hostId, path }));
        else openRemoteFile({ hostId, path });
      },
    }),
    [hostId, chatId, cwd, canPreview],
  );
  return (
    <LinkRewriteContext.Provider value={rewrite}>
      <FileLinkActionsContext.Provider value={actions}>
        <FileLinkResolverContext.Provider value={resolver}>
          <FileLinkCwdContext.Provider value={cwd ?? null}>{children}</FileLinkCwdContext.Provider>
        </FileLinkResolverContext.Provider>
      </FileLinkActionsContext.Provider>
    </LinkRewriteContext.Provider>
  );
}
