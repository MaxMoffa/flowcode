import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachmentRef } from "../../shared/remote-types";
import { extOf, formatSize, MAX_ATTACHMENTS, MAX_ATTACH_BYTES, uploadAttachment } from "./attachUpload";
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

/** The files picked for the next message, uploading as soon as they are picked (a few at a time). */
export function useAttachments(chatId: string) {
  const [items, setItems] = useState<AttachItem[]>([]);
  const files = useRef(new Map<string, File>());
  const queue = useRef<string[]>([]);
  const running = useRef(0);
  const alive = useRef(true);
  const chat = useRef(chatId);
  chat.current = chatId;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const patch = (key: string, p: Partial<AttachItem>) => setItems((cur) => cur.map((i) => (i.key === key ? { ...i, ...p } : i)));

  const drain = useCallback(() => {
    while (running.current < MAX_PARALLEL && queue.current.length > 0) {
      const key = queue.current.shift()!;
      const file = files.current.get(key);
      if (!file) continue;
      running.current++;
      uploadAttachment(chat.current, file)
        .then((ref) => alive.current && files.current.has(key) && patch(key, { status: "done", ref }))
        .catch(() => alive.current && files.current.has(key) && patch(key, { status: "error" }))
        .finally(() => {
          running.current--;
          drain();
        });
    }
  }, []);

  const add = useCallback(
    (picked: File[]) => {
      let room = MAX_ATTACHMENTS - itemsRef.current.length;
      const added: AttachItem[] = [];
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
        const key = `a${++counter}`;
        files.current.set(key, file);
        queue.current.push(key);
        added.push({ key, name: file.name, mime: file.type, size: file.size, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined, status: "uploading" });
      }
      if (added.length === 0) return;
      setItems((cur) => [...cur, ...added]);
      drain();
    },
    [drain],
  );

  /** Puts already-uploaded files back (a queued message taken back for editing). */
  const restore = useCallback((refs: ChatAttachmentRef[]) => {
    const room = Math.max(0, MAX_ATTACHMENTS - itemsRef.current.length);
    if (refs.length > room) showToast(t("attachTooMany"));
    const added = refs.slice(0, room).map((ref): AttachItem => ({ key: `a${++counter}`, name: ref.name, mime: ref.mime, size: 0, status: "done", ref }));
    if (added.length > 0) setItems((cur) => [...cur, ...added]);
  }, []);

  const forget = (item: AttachItem) => {
    files.current.delete(item.key);
    if (item.preview) URL.revokeObjectURL(item.preview);
  };
  const remove = useCallback((key: string) => {
    const item = itemsRef.current.find((i) => i.key === key);
    if (item) forget(item);
    queue.current = queue.current.filter((k) => k !== key);
    setItems((cur) => cur.filter((i) => i.key !== key));
  }, []);
  const retry = useCallback(
    (key: string) => {
      patch(key, { status: "uploading" });
      queue.current.push(key);
      drain();
    },
    [drain],
  );
  /** Drops every item (after a send): the uploads belong to the message now. */
  const clear = useCallback(() => {
    itemsRef.current.forEach(forget);
    queue.current = [];
    setItems([]);
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      itemsRef.current.forEach(forget);
    };
  }, []);

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
