import { beforeEach, describe, expect, it, vi } from "vitest";

const up = vi.hoisted(() => ({ pending: [] as { chatId: string; resolve: (r: unknown) => void; reject: (e: unknown) => void }[] }));
vi.mock("./attachUpload", () => ({
  extOf: () => "",
  formatSize: () => "",
  MAX_ATTACHMENTS: 6,
  MAX_ATTACH_BYTES: 1_000_000,
  uploadAttachment: (chatId: string) => new Promise((resolve, reject) => up.pending.push({ chatId, resolve, reject })),
}));
vi.mock("./i18n", () => ({ t: (k: string) => k }));
vi.mock("./icons", () => ({ CloseIcon: () => null }));
vi.mock("./remote", () => ({ showToast: () => {} }));

import { chatGone, onChatGone } from "./chatGone";
import { attachStore } from "./useAttachments";

const file = (name: string, type = "image/png") => ({ name, type, size: 10 }) as File;
const flush = () => new Promise((r) => setTimeout(r, 0));
const revoked: string[] = [];

beforeEach(() => {
  up.pending.length = 0;
  revoked.length = 0;
  let n = 0;
  vi.stubGlobal("URL", { createObjectURL: () => `blob:${++n}`, revokeObjectURL: (u: string) => void revoked.push(u) });
  for (const id of ["a", "b"]) {
    attachStore.clear(id);
    chatGone(id);
  }
  up.pending.length = 0;
  revoked.length = 0;
});

describe("chatGone", () => {
  it("calls every listener until unsubscribed", () => {
    const fn = vi.fn();
    const off = onChatGone(fn);
    chatGone("x");
    off();
    chatGone("y");
    expect(fn.mock.calls).toEqual([["x"]]);
  });
});

describe("attachment store", () => {
  it("keeps items per chat without a mounted composer and finishes uploads into the right chat", async () => {
    attachStore.add("a", [file("1.png")]);
    attachStore.add("b", [file("2.png")]);
    expect(attachStore.items("a")).toHaveLength(1);
    expect(attachStore.items("b")).toHaveLength(1);
    up.pending[0].resolve({ id: "r1", name: "1.png", mime: "image/png" });
    await flush();
    expect(attachStore.items("a")[0].status).toBe("done");
    expect(attachStore.items("b")[0].status).toBe("uploading");
    expect(up.pending[0].chatId).toBe("a");
  });

  it("limits uploads in parallel per chat", () => {
    attachStore.add("a", [file("1.png"), file("2.png"), file("3.png"), file("4.png")]);
    expect(up.pending).toHaveLength(3);
  });

  it("clear and remove revoke previews and drop the entry when nothing runs", async () => {
    attachStore.add("a", [file("1.png")]);
    up.pending[0].resolve({ id: "r", name: "1.png", mime: "image/png" });
    await flush();
    attachStore.remove("a", attachStore.items("a")[0].key);
    expect(revoked).toEqual(["blob:1"]);
    expect(attachStore.has("a")).toBe(false);
  });

  it("chatGone drops the entry and ignores a result arriving later", async () => {
    attachStore.add("a", [file("1.png")]);
    chatGone("a");
    expect(attachStore.has("a")).toBe(false);
    expect(revoked).toEqual(["blob:1"]);
    up.pending[0].resolve({ id: "r", name: "1.png", mime: "image/png" });
    await flush();
    expect(attachStore.has("a")).toBe(false);
    expect(attachStore.items("a")).toHaveLength(0);
  });
});
