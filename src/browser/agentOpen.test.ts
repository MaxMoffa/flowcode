import { describe, expect, it } from "vitest";
import { openCommandTarget, toolCommand } from "./agentOpen";

describe("openCommandTarget", () => {
  it("finds the artifact a Windows start opens", () => {
    expect(openCommandTarget('start "" "C:\\proj\\out\\report.html"')).toBe("C:\\proj\\out\\report.html");
    expect(openCommandTarget("cmd /c start report.html")).toBe("report.html");
    expect(openCommandTarget('powershell -Command "Start-Process \'a.svg\'"')).toBe("a.svg");
  });

  it("finds open / xdg-open / explorer targets and URLs", () => {
    expect(openCommandTarget("open ./dist/index.html")).toBe("./dist/index.html");
    expect(openCommandTarget("xdg-open http://localhost:3000/")).toBe("http://localhost:3000/");
    expect(openCommandTarget("cd out && explorer.exe chart.pdf")).toBe("chart.pdf");
  });

  it("ignores commands that open nothing the panel can show", () => {
    expect(openCommandTarget("npm run build")).toBeNull();
    expect(openCommandTarget("start notepad.exe")).toBeNull();
    expect(openCommandTarget("cat report.html")).toBeNull();
    expect(openCommandTarget("restart report.html")).toBeNull();
  });
});

describe("toolCommand", () => {
  it("reads the command of a tool call's input", () => {
    expect(toolCommand({ rawInput: { command: "ls" } })).toBe("ls");
    expect(toolCommand({ rawInput: {} })).toBeNull();
    expect(toolCommand({})).toBeNull();
  });
});
