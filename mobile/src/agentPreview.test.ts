import { describe, expect, it } from "vitest";
import { agentPreviewPage, relativeArtifactPath } from "./agentPreview";
import { pageSrc, parseTyped, sandboxFor, type Page } from "./browserUrl";

describe("chat file previews", () => {
  it("opens relative files without a terminal and keeps chat precedence", () => {
    const page: Page = { kind: "chatFile", chatId: "c1", path: "docs/my report.html" };
    expect(parseTyped("docs/my report.html", null, "c1")).toEqual(page);
    expect(parseTyped("docs/my report.html", "p1", "c1")).toEqual(page);
    expect(pageSrc(page, (prefix) => `scheme://host/${prefix}`)).toBe("scheme://host/c/c1/docs/my%20report.html");
    expect(sandboxFor(page)).toBe("allow-scripts");
    expect(parseTyped("../secret.html", null, "c1")).toBeNull();
    expect(parseTyped("C:\\secret.html", null, "c1")).toBeNull();
  });
  it("scopes Windows absolute openers and changed working folders to the chat", () => {
    expect(relativeArtifactPath("C:\\repo\\docs\\report.html", "C:\\repo", "C:\\repo")).toBe("docs/report.html");
    expect(relativeArtifactPath("c:/REPO/docs/report.html", "C:/repo", "C:/repo/")).toBe("docs/report.html");
    expect(relativeArtifactPath("report.html", "/repo/docs", "/repo")).toBe("docs/report.html");
    expect(relativeArtifactPath("../report.html", "/repo/docs", "/repo")).toBe("report.html");
  });
  it("refuses files outside the project and sibling folders with the same prefix", () => {
    expect(relativeArtifactPath("../secret.html", "/repo", "/repo")).toBeNull();
    expect(relativeArtifactPath("/repo-other/report.html", "/repo", "/repo")).toBeNull();
    expect(relativeArtifactPath("C:/secret.html", "C:/repo", "C:/repo")).toBeNull();
  });
  it("maps native WSL paths, UNC paths and mounted Windows drives", () => {
    const root = "\\\\wsl.localhost\\Ubuntu\\home\\me\\repo";
    expect(relativeArtifactPath("/home/me/repo/report.html", root, root)).toBe("report.html");
    expect(relativeArtifactPath(root + "\\report.html", root, root)).toBe("report.html");
    expect(relativeArtifactPath("report.html", "/home/me/repo/docs", root)).toBe("docs/report.html");
    expect(relativeArtifactPath("/home/Me/repo/report.html", root, root)).toBeNull();
    expect(relativeArtifactPath("/mnt/c/repo/report.html", "C:/repo", "C:/repo")).toBe("report.html");
  });
  it("uses only loopback HTTP targets and the negotiated chat capability", () => {
    const open = (target: string) => ({ target, cwd: "/repo" });
    expect(agentPreviewPage(open("http://0.0.0.0:5173/a"), "c1", "/repo", false)).toEqual({ kind: "port", port: 5173, path: "/a" });
    expect(agentPreviewPage(open("https://example.com"), "c1", "/repo", true)).toBeNull();
    expect(agentPreviewPage(open("report.html"), "c1", "/repo", false)).toBeNull();
    expect(agentPreviewPage(open("report.html"), "c1", "/repo", true)).toEqual({ kind: "chatFile", chatId: "c1", path: "report.html" });
  });
});
