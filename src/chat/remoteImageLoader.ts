import { listen } from "@tauri-apps/api/event";
import { createChatImageFetcher, type ChatImageRequest } from "../../shared/chatImageFetch";
import { onHostMessages, sendToHost, type HostInfo } from "../remoteHosts/remoteHosts";

export interface RemoteImageLoaderLease {
  fetcher: { fetch(request: ChatImageRequest): Promise<Blob | null> };
  release(): void;
}

interface Loader {
  fetcher: RemoteImageLoaderLease["fetcher"];
  owners: number;
  cleanup: ReturnType<typeof setTimeout> | null;
  connection(online: boolean, requestIds: boolean, force?: boolean): void;
  dispose(): void;
}

const loaders = new Map<string, Loader>();

function createLoader(hostId: string, supportsRequestIds: boolean): Loader {
  let requestIds = supportsRequestIds;
  let online = true;
  let disposed = false;
  let generation = 0;
  const waiting = new Set<() => void>();
  const wake = () => {
    const callbacks = [...waiting];
    waiting.clear();
    callbacks.forEach((done) => done());
  };
  const core = createChatImageFetcher((message) => sendToHost(hostId, message), 30_000, { supportsRequestIds: () => requestIds });
  const loader: Loader = {
    owners: 0,
    cleanup: null,
    fetcher: {
      async fetch(request) {
        while (!disposed) {
          if (!online) {
            await new Promise<void>((done) => waiting.add(done));
            continue;
          }
          const current = generation;
          const blob = await core.fetch(request);
          if (disposed) return null;
          // An image request is idempotent. Keep the URL cache's promise alive
          // while the old link is reset, then retry on its replacement.
          if (current !== generation) continue;
          return blob;
        }
        return null;
      },
    },
    connection(nextOnline, nextRequestIds, force = false) {
      if (disposed || (!force && nextOnline === online && nextRequestIds === requestIds)) return;
      online = nextOnline;
      requestIds = nextRequestIds;
      generation++;
      core.reset();
      wake();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (loader.cleanup !== null) clearTimeout(loader.cleanup);
      loader.cleanup = null;
      offMessages();
      offState?.();
      core.dispose();
      wake();
    },
  };
  const offMessages = onHostMessages(hostId, (messages) => {
    for (const message of messages) {
      if (message.t === "ready") loader.connection(true, !!message.caps?.includes("chatImageRequestId"), true);
      else core.handle(message);
    }
  });
  let offState: (() => void) | undefined;
  // host.rs consumes Ready during its handshake, so the state event is the
  // generation boundary even when React batches connecting/online renders.
  void listen<HostInfo>("remote-host://state", ({ payload }) => {
    if (payload.id === hostId) loader.connection(payload.status === "online", payload.caps.includes("chatImageRequestId"));
  }).then((off) => {
    if (disposed) off();
    else offState = off;
  }, () => {});
  return loader;
}

/** One transport and legacy response namespace per host. A synchronous
 * reacquire cancels disposal, as React StrictMode's effect replay requires. */
export function retainRemoteImageLoader(hostId: string, supportsRequestIds: boolean): RemoteImageLoaderLease {
  let loader = loaders.get(hostId);
  if (!loader) {
    loader = createLoader(hostId, supportsRequestIds);
    loaders.set(hostId, loader);
  }
  const current = loader;
  if (current.cleanup !== null) clearTimeout(current.cleanup);
  current.cleanup = null;
  current.owners++;
  current.connection(true, supportsRequestIds);
  let released = false;
  return {
    fetcher: current.fetcher,
    release() {
      if (released) return;
      released = true;
      current.owners--;
      if (current.owners > 0) return;
      current.cleanup = setTimeout(() => {
        current.cleanup = null;
        if (current.owners > 0) return;
        current.dispose();
        if (loaders.get(hostId) === current) loaders.delete(hostId);
      }, 0);
    },
  };
}
