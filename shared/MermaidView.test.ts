import { describe, expect, it } from "vitest";
import { mermaidTheme } from "./MermaidView";

describe("mermaidTheme", () => {
  it("follows data-theme=light even over a transparent body", () => {
    expect(mermaidTheme("light", "rgba(0, 0, 0, 0)")).toBe("default");
  });

  it("follows data-theme=dark", () => {
    expect(mermaidTheme("dark", "rgb(250, 250, 250)")).toBe("dark");
  });

  it("treats a transparent body as light without data-theme", () => {
    expect(mermaidTheme(null, "rgba(0, 0, 0, 0)")).toBe("default");
  });

  it("reads a dark body background as dark without data-theme", () => {
    expect(mermaidTheme(null, "rgb(20, 20, 20)")).toBe("dark");
  });

  it("reads a light body background as light without data-theme", () => {
    expect(mermaidTheme(null, "rgb(250, 250, 250)")).toBe("default");
  });
});
