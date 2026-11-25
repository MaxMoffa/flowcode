import { describe, expect, it } from "vitest";
import { looksLikeHost, pathSegments, startsWithCommand, wholeCodePath } from "./pathLinks";

describe("pathLinks", () => {
  it("keeps plain text as one piece", () => {
    expect(pathSegments("nothing here")).toEqual([{ text: "nothing here" }]);
  });
  it("cuts a path out of text", () => {
    const parts = pathSegments("see ./docs/a.html now");
    expect(parts.map((p) => p.text)).toEqual(["see ", "./docs/a.html", " now"]);
    expect(parts[1].match?.path).toBe("./docs/a.html");
    expect(parts[1].index).toBe(0);
  });
  it("drops matches the app rejects", () => {
    expect(pathSegments("see ./docs/a.html", { accept: () => false })).toEqual([{ text: "see ./docs/a.html" }]);
  });
  it("tells hosts from folders", () => {
    expect(looksLikeHost("example.com/logo.png")).toBe(true);
    expect(looksLikeHost("./example.com/logo.png")).toBe(false);
  });
  it("spots a command prefix and a whole path", () => {
    expect(startsWithCommand("open docs/a.html")).toBe(true);
    expect(startsWithCommand("docs/a.html")).toBe(false);
    expect(wholeCodePath("docs/my report.html")?.path).toBe("docs/my report.html");
  });
});
