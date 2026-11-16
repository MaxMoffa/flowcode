import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ChatAttachmentRef } from "../../shared/remote-types";
import { extOf, formatSize, MAX_ATTACHMENTS, MAX_ATTACH_BYTES, uploadAttachment } from "./attachUpload";
import { onChatGone } from "./chatGone";
import { t } from "./i18n";
import { CloseIcon } from "./icons";
import { showToast } from "./remote";

export interface AttachItem {
  key: string;
  name: string;
  mime: string;
  size: number;
  preview?: string;
  status: "uploading" | "done" | "error";
  ref?: ChatAttachmentRef;
}

const MAX_PARALLEL = 3;
let counter = 0;

interface Entry {
  items: AttachItem[];
  files: Map<string, File>;
  queue: string[];
  running: number;
}

/** The files picked per chat live here, not in the composer: leaving a chat and coming back keeps them (like the draft text), and uploads go on meanwhile. */
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const NONE: AttachItem[] = [];

const notify = (chatId: string) => listeners.get(chatId)?.forEach((l) => l());
const subscribeTo = (chatId: string) => (listener: () => void) => {
  let set = listeners.get(chatId);
  if (!set) listeners.set(chatId, (set = new Set()));
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0 && listeners.get(chatId) === set) listeners.delete(chatId);
  };
};

/** An entry with nothing in it and nothing uploading is not kept. */
function prune(chatId: string, entry: Entry) {
  if (entries.get(chatId) === entry && entry.items.length === 0 && entry.running === 0) entries.delete(chatId);
}

function patch(chatId: string, entry: Entry, key: string, p: Partial<AttachItem>) {
  if (entries.get(chatId) !== entry) return;
  entry.items = entry.items.map((i) => (i.key === key ? { ...i, ...p } : i));
  notify(chatId);
}

function drain(chatId: string, entry: Entry) {
  while (entry.running < MAX_PARALLEL && entry.queue.length > 0) {
    const key = entry.queue.shift()!;
    const file = entry.files.get(key);
    if (!file) continue;
    entry.running++;
    // Started for this chat: the result lands in this chat's entry whatever screen is showing now.
    uploadAttachment(chatId, file)
      .then((ref) => entry.files.has(key) && patch(chatId, entry, key, { status: "done", ref }))
      .catch(() => entry.files.has(key) && patch(chatId, entry, key, { status: "error" }))
      .finally(() => {
        entry.running--;
        if (entries.get(chatId) === entry) {
          drain(chatId, entry);
          prune(chatId, entry);
        }
      });
  }
}

function forget(entry: Entry, item: AttachItem) {
  entry.files.delete(item.key);
  if (item.preview) URL.revokeObjectURL(item.preview);
}

function entryFor(chatId: string): Entry {
  let e = entries.get(chatId);
  if (!e) entries.set(chatId, (e = { items: [], files: new Map(), queue: [], running: 0 }));
  return e;
}

function addFiles(chatId: string, picked: File[]) {
  let room = MAX_ATTACHMENTS - (entries.get(chatId)?.items.length ?? 0);
  const files: [string, File][] = [];
  for (const file of picked) {
    if (file.size > MAX_ATTACH_BYTES) {
      showToast(t("attachTooBig", { name: file.name }));
      continue;
    }
    if (room <= 0) {
      showToast(t("attachTooMany"));
      break;
    }
    room--;
    files.push([`a${++counter}`, file]);
  }
  if (files.length === 0) return;
  const entry = entryFor(chatId);
  const added = files.map(([key, file]): AttachItem => {
    entry.files.set(key, file);
    entry.queue.push(key);
    return { key, name: file.name, mime: file.type, size: file.size, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined, status: "uploading" };
  });
  entry.items = [...entry.items, ...added];
  notify(chatId);
  drain(chatId, entry);
}

function restoreRefs(chatId: string, refs: ChatAttachmentRef[]) {
  const room = Math.max(0, MAX_ATTACHMENTS - (entries.get(chatId)?.items.length ?? 0));
  if (refs.length > room) showToast(t("attachTooMany"));
  const added = refs.slice(0, room).map((ref): AttachItem => ({ key: `a${++counter}`, name: ref.name, mime: ref.mime, size: 0, status: "done", ref }));
  if (added.length === 0) return;
  const entry = entryFor(chatId);
  entry.items = [...entry.items, ...added];
  notify(chatId);
}

function removeItem(chatId: string, key: string) {
  const entry = entries.get(chatId);
  if (!entry) return;
  const item = entry.items.find((i) => i.key === key);
  if (item) forget(entry, item);
  entry.queue = entry.queue.filter((k) => k !== key);
  entry.items = entry.items.filter((i) => i.key !== key);
  notify(chatId);
  prune(chatId, entry);
}

function retryItem(chatId: string, key: string) {
  const entry = entries.get(chatId);
  if (!entry) return;
  patch(chatId, entry, key, { status: "uploading" });
  entry.queue.push(key);
  drain(chatId, entry);
}

/** Drops every item of the chat (after a send, or when the chat is gone). Uploads still running are ignored when they finish. */
function clearChatAttachments(chatId: string) {
  const entry = entries.get(chatId);
  if (!entry) return;
  entry.items.forEach((i) => forget(entry, i));
  entry.files.clear();
  entry.queue = [];
  entry.items = [];
  notify(chatId);
  prune(chatId, entry);
  // Still uploading: leave the entry so its running count stays right, but nothing of it is shown; a later add reuses it.
}

onChatGone((chatId) => {
  const entry = entries.get(chatId);
  if (!entry) return;
  entry.items.forEach((i) => forget(entry, i));
  entry.files.clear();
  entry.queue = [];
  entry.items = [];
  entries.delete(chatId);
  notify(chatId);
});

/** Test hooks: the store without React. */
export const attachStore = { add: addFiles, restore: restoreRefs, remove: removeItem, retry: retryItem, clear: clearChatAttachments, items: (chatId: string) => entries.get(chatId)?.items ?? NONE, has: (chatId: string) => entries.has(chatId) };

/** The files picked for the next message, uploading as soon as they are picked (a few at a time). They stay with the chat when the composer unmounts. */
export function useAttachments(chatId: string) {
  const subscribe = useMemo(() => subscribeTo(chatId), [chatId]);
  const items = useSyncExternalStore(subscribe, () => attachStore.items(chatId));

  const add = useCallback((picked: File[]) => addFiles(chatId, picked), [chatId]);
  const restore = useCallback((refs: ChatAttachmentRef[]) => restoreRefs(chatId, refs), [chatId]);
  const remove = useCallback((key: string) => removeItem(chatId, key), [chatId]);
  const retry = useCallback((key: string) => retryItem(chatId, key), [chatId]);
  const clear = useCallback(() => clearChatAttachments(chatId), [chatId]);

  const ready = items.length > 0 && items.every((i) => i.status === "done");
  const blocked = items.some((i) => i.status !== "done");
  return { items, add, restore, remove, retry, clear, ready, blocked };
}

/** The strip of picked files at the top of the composer card. */
export function AttachStrip({ items, onRemove, onRetry }: { items: AttachItem[]; onRemove: (key: string) => void; onRetry: (key: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="chat-attach-strip">
      {items.map((i) => {
        const cls = "chat-attach-tile" + (i.preview ? " is-img" : " is-file") + (i.status === "uploading" ? " is-uploading" : "") + (i.status === "error" ? " is-error" : "");
        return (
          <div key={i.key} className={cls} title={i.status === "error" ? t("attachRetry") : i.name} onClick={i.status === "error" ? () => onRetry(i.key) : undefined}>
            {i.preview ? (
              <img src={i.preview} alt={i.name} draggable={false} />
            ) : (
              <>
                <span className="chat-attach-ext">{extOf(i.name)}</span>
                <span className="chat-attach-meta">
                  <b>{i.name}</b>
                  {i.size > 0 && <small>{formatSize(i.size)}</small>}
                </span>
              </>
            )}
            {i.status === "uploading" && <span className="chat-spinner chat-attach-spin" aria-hidden="true" />}
            <button
              type="button"
              className="chat-attach-x"
              aria-label={t("attachRemove")}
              onPointerDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(i.key);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
    </div>
  );
}
