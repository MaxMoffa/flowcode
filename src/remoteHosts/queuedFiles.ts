// A message queued for a chat of another PC carries files already uploaded there (`ChatAttachmentRef`, by id). The
// composer's own copies stay staged here until the message is sent, so pulling it back into the composer restores
// them as attachments that can be sent again (and uploaded again) instead of bare names.
import type { ChatAttachment } from "../chat/chatTypes";
import type { ChatAttachmentRef } from "../../shared/remote-types";

export type StagedFiles = Map<string, ChatAttachment>;

/** The attachments a queued message shows and gives back: the staged copy of each file, or just its name when none is kept. */
export function queuedAttachments(files: readonly ChatAttachmentRef[], staged: ReadonlyMap<string, ChatAttachment>): ChatAttachment[] {
  return files.map((f) => staged.get(f.id) ?? { name: f.name, mime: f.mime });
}

/** Forgets the staged copies of `files` and returns them: the caller discards them (the message went out) or hands them on (it went back to the composer). */
export function takeStaged(staged: StagedFiles, files: readonly ChatAttachmentRef[]): ChatAttachment[] {
  const taken: ChatAttachment[] = [];
  for (const f of files) {
    const a = staged.get(f.id);
    if (!a) continue;
    staged.delete(f.id);
    taken.push(a);
  }
  return taken;
}
