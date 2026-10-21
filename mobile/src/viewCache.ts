// Agent view plugins on the phone. The desktop lists the ones fit for a
// screen this size (`views`); each is downloaded once, file by file, into the
// app's cache (the Rust `view_cache_*` commands, keyed by id + content hash)
// and then served to a sandboxed iframe from there. A changed hash downloads
// again; plugins the desktop no longer lists are pruned.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ServerMsg, ViewPackage } from "../../shared/remote-types";
import { pluginFileUrl } from "../../shared/agentViewBridge";
import { onMessage, send } from "./remote";
import { createStore } from "./store";

/** Packages downloaded at the same time; their files go one after the other. */
const CONCURRENCY = 2;
/** A file that goes this long without a chunk is given up on (the sync retries on the next `views`). */
const CHUNK_TIMEOUT_MS = 20_000;
/** The only bridge protocol this phone speaks. */
const API_VERSION = 1;

/** What the sync needs from the cache and the link; the app wires the Tauri commands, tests a fake. */
export interface ViewCacheOps {
  has(id: string, hash: string): Promise<boolean>;
  /** Fetches one file of a package from the desktop into the cache; resolves once it is complete. */
  fetchFile(pkg: ViewPackage, path: string): Promise<void>;
  commit(id: string, hash: string, files: string[]): Promise<void>;
  prune(keep: { id: string; hash: string }[]): Promise<void>;
}

/** The packages this phone can run: its screens and bridge version. */
export const runnableViews = (packages: ViewPackage[]): ViewPackage[] =>
  packages.filter((p) => p.kind === "agentView" && p.apiVersion === API_VERSION && p.devices.some((d) => d === "phone" || d === "tablet"));

/**
 * Brings the cache in line with `packages`: what is cached is ready at once
 * (`onReady` first hears about those), the rest is downloaded with bounded
 * concurrency and reported as each one is committed. Pruning only happens
 * when every download worked, so a failed update doesn't take the old copy
 * of its plugin away.
 */
export async function syncViews(packages: ViewPackage[], ops: ViewCacheOps, onReady: (ready: ViewPackage[]) => void): Promise<void> {
  const wanted = runnableViews(packages);
  const ready = new Set<ViewPackage>();
  const publish = () => onReady(wanted.filter((p) => ready.has(p)));
  const missing: ViewPackage[] = [];
  for (const pkg of wanted) {
    if (await ops.has(pkg.id, pkg.hash).catch(() => false)) ready.add(pkg);
    else missing.push(pkg);
  }
  publish();

  let failed = false;
  const worker = async () => {
    for (let pkg = missing.shift(); pkg; pkg = missing.shift()) {
      try {
        for (const file of pkg.files) await ops.fetchFile(pkg, file.path);
        await ops.commit(pkg.id, pkg.hash, pkg.files.map((f) => f.path));
        ready.add(pkg);
        publish();
      } catch {
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker));
  if (!failed) await ops.prune(wanted.map((p) => ({ id: p.id, hash: p.hash }))).catch(() => {});
}

/** The page of a cached view, for the iframe. */
export const viewSrc = (pkg: ViewPackage): string => pluginFileUrl(convertFileSrc(pkg.id, "flowcode-plugin"), `${pkg.hash}/${pkg.entry}`);

/** The view's name in the UI language. */
export const viewLabel = (pkg: ViewPackage, language: string | undefined): string => (language && pkg.labels?.[language]) || pkg.label;

/** Whether a view is meant for this screen. */
export const viewFits = (pkg: ViewPackage, wide: boolean): boolean => pkg.devices.includes(wide ? "tablet" : "phone");

// ---- the app's wiring --------------------------------------------------------

const store = createStore<{ ready: ViewPackage[] }>({ ready: [] });
/** The views downloaded and ready to show. */
export const useReadyViews = (): ViewPackage[] => store.useSelector((s) => s.ready);

interface Download {
  /** Raw bytes received. */
  bytes: number;
  writes: Promise<unknown>[];
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (e: Error) => void;
}
const downloads = new Map<string, Download>();
const downloadKey = (id: string, hash: string, path: string) => `${id}/${hash}/${path}`;

/** Size in bytes of a base64 chunk. */
function decodedLength(data: string): number {
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - pad;
}

function fetchFile(pkg: ViewPackage, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const key = downloadKey(pkg.id, pkg.hash, path);
    const timeout = () => {
      downloads.delete(key);
      reject(new Error("timeout"));
    };
    downloads.set(key, { bytes: 0, writes: [], timer: setTimeout(timeout, CHUNK_TIMEOUT_MS), resolve, reject });
    send({ t: "viewfile", viewId: pkg.id, path });
  });
}

function onChunk(m: Extract<ServerMsg, { t: "viewfile" }>) {
  const key = downloadKey(m.viewId, m.hash, m.path);
  const d = downloads.get(key);
  if (!d) return;
  clearTimeout(d.timer);
  d.bytes += decodedLength(m.data);
  d.writes.push(invoke("view_cache_write", { id: m.viewId, hash: m.hash, path: m.path, offset: m.offset, total: m.total, data: m.data }));
  if (d.bytes < m.total) {
    d.timer = setTimeout(() => {
      downloads.delete(key);
      d.reject(new Error("timeout"));
    }, CHUNK_TIMEOUT_MS);
    return;
  }
  downloads.delete(key);
  Promise.all(d.writes).then(() => d.resolve(), d.reject);
}

const ops: ViewCacheOps = {
  has: (id, hash) => invoke<boolean>("view_cache_has", { id, hash }).then(Boolean),
  fetchFile,
  commit: (id, hash, files) => invoke("view_cache_commit", { id, hash, files }).then(() => {}),
  prune: (keep) => invoke("view_cache_prune", { keep }).then(() => {}),
};

const sameViews = (a: ViewPackage[], b: ViewPackage[]) => a.length === b.length && a.every((p, i) => p.id === b[i].id && p.hash === b[i].hash);
const publishReady = (ready: ViewPackage[]) => {
  if (!sameViews(store.get().ready, ready)) store.set({ ready });
};

/** One sync at a time; a `views` that arrives meanwhile is run right after. */
let syncing = false;
let nextPackages: ViewPackage[] | null = null;
function startSync(packages: ViewPackage[]) {
  nextPackages = packages;
  if (syncing) return;
  syncing = true;
  void (async () => {
    while (nextPackages) {
      const current = nextPackages;
      nextPackages = null;
      await syncViews(current, ops, publishReady).catch(() => {});
    }
    syncing = false;
  })();
}

onMessage((m) => {
  if (m.t === "views") startSync(m.views);
  else if (m.t === "viewfile") onChunk(m);
});
