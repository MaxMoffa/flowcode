import { describe, expect, it } from "vitest";
import { encodeKey, encodeText, type Active } from "./termModifiers";

const none: Active = { ctrl: false, alt: false, shift: false };
const mod = (m: Partial<Active>): Active => ({ ...none, ...m });

describe("encodeKey", () => {
  it("sends plain and application-cursor arrows", () => {
    expect(encodeKey("up", none, false)).toBe("\x1b[A");
    expect(encodeKey("left", none, true)).toBe("\x1bOD");
  });
  it("uses xterm modifier bits for arrows", () => {
    expect(encodeKey("up", mod({ ctrl: true }), false)).toBe("\x1b[1;5A");
    expect(encodeKey("right", mod({ shift: true }), false)).toBe("\x1b[1;2C");
    expect(encodeKey("down", mod({ alt: true, ctrl: true }), false)).toBe("\x1b[1;7B");
  });
  it("ignores application-cursor mode when a modifier is armed", () => {
    expect(encodeKey("up", mod({ ctrl: true }), true)).toBe("\x1b[1;5A");
  });
  it("encodes tab and esc", () => {
    expect(encodeKey("tab", none, false)).toBe("\t");
    expect(encodeKey("tab", mod({ shift: true }), false)).toBe("\x1b[Z");
    expect(encodeKey("tab", mod({ alt: true }), false)).toBe("\x1b\t");
    expect(encodeKey("esc", none, false)).toBe("\x1b");
    expect(encodeKey("esc", mod({ alt: true }), false)).toBe("\x1b\x1b");
  });
});

describe("encodeText", () => {
  it("passes text through without modifiers", () => {
    expect(encodeText("a", none)).toBe("a");
    expect(encodeText("hello", none)).toBe("hello");
  });
  it("turns ctrl+letter into a control code", () => {
    expect(encodeText("c", mod({ ctrl: true }))).toBe("\x03");
    expect(encodeText("C", mod({ ctrl: true }))).toBe("\x03");
    expect(encodeText(" ", mod({ ctrl: true }))).toBe("\x00");
  });
  it("prefixes alt with ESC", () => {
    expect(encodeText("b", mod({ alt: true }))).toBe("\x1bb");
    expect(encodeText("c", mod({ alt: true, ctrl: true }))).toBe("\x1b\x03");
  });
  it("shift uppercases a letter", () => {
    expect(encodeText("a", mod({ shift: true }))).toBe("A");
  });
  it("leaves multi-character data alone under ctrl", () => {
    expect(encodeText("ls", mod({ ctrl: true }))).toBe("ls");
  });
});
