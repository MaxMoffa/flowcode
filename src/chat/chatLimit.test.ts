import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

import type { ChatItem } from "./chatModel";
import { limitOf } from "./chatLimit";

const user = (id: string): ChatItem => ({ type: "user", id, text: "hi" });
const agent = (id: string, text: string): ChatItem => ({ type: "agent", id, text });
const error = (id: string, message: string): ChatItem => ({ type: "error", id, message });
const NOW = new Date(2026, 9, 20, 10, 0, 0);

describe("limitOf", () => {
  it("finds a limit notice in the agent's text", () => {
    const hit = limitOf([user("u1"), agent("a1", "You've hit your limit · resets 3pm")], NOW);
    expect(hit?.id).toBe("a1");
    expect(hit?.at).toBe(new Date(2026, 9, 20, 15, 0, 0).getTime());
  });

  it("finds it in an error", () => {
    const hit = limitOf([user("u1"), error("e1", "You've hit your usage limit")], NOW);
    expect(hit).toEqual({ id: "e1", at: null });
  });

  it("ignores a notice before a newer user message", () => {
    expect(limitOf([agent("a1", "You've hit your limit"), user("u2"), agent("a2", "ok")], NOW)).toBeNull();
  });

  it("returns null when there is no limit", () => {
    expect(limitOf([user("u1"), agent("a1", "all good")], NOW)).toBeNull();
    expect(limitOf([], NOW)).toBeNull();
  });
});
