import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(), system: vi.fn(), focus: vi.fn((): Promise<void> | null => null),
  settings: { local: "app", external: "ask", artifacts: "app" },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.system }));
vi.mock("../lib/fileLinks", () => ({ checkPath: vi.fn() }));
vi.mock("../i18n", () => ({ t: (key: string) => key }));
vi.mock("./browserSettings", () => ({ getBrowserSettings: () => mocks.settings }));
vi.mock("./browserStore", () => ({
  isLocalUrl: (target: string) => new URL(target).hostname === "localhost",
  normalizeLocalUrl: (target: string) => target,
  openUrlInPreview: mocks.preview,
  openFileInPreview: vi.fn(),
  whenTabFocused: mocks.focus,
}));
import { routeAgentOpen, commandCwd, openCommandTarget, toolCommand } from "./agentOpen";

describe("agent browser permission", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.settings.external = "ask"; mocks.system.mockResolvedValue(undefined); });
  const request = { target: "https://example.com/?private=value", cwd: "/repo", direct: true };

  it("asks about a background tab's page only once that tab is on screen", async () => {
    let focus!: () => void;
    mocks.focus.mockReturnValueOnce(new Promise<void>((done) => { focus = done; }));
    const confirm = vi.fn(async () => true);
    const opening = routeAgentOpen(request, null, confirm, "tab-b");
    await Promise.resolve();
    expect(mocks.focus).toHaveBeenCalledWith("tab-b");
    expect(confirm).not.toHaveBeenCalled();
    focus();
    await opening;
    expect(confirm).toHaveBeenCalledOnce();
    expect(mocks.preview).toHaveBeenCalledWith(request.target, "tab-b");
  });

  it("does not make a network request while confirmation is pending", async () => {
    let resolve!: (allowed: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    const opening = routeAgentOpen(request, null, confirm);
    expect(confirm).toHaveBeenCalledOnce();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.system).not.toHaveBeenCalled();
    resolve(true);
    await opening;
    expect(mocks.preview).toHaveBeenCalledWith(request.target, undefined);
  });

  it("fails closed when the adapter bypasses permission and no confirmation handler exists", async () => {
    await routeAgentOpen(request, null);
    await routeAgentOpen(request, null, async () => false);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.system).not.toHaveBeenCalled();
  });

  it("also asks before opening the system browser", async () => {
    mocks.settings.external = "system";
    await routeAgentOpen(request, null, async () => false);
    expect(mocks.system).not.toHaveBeenCalled();
    await routeAgentOpen(request, null, async () => true);
    expect(mocks.system).toHaveBeenCalledWith(request.target);
  });

  it("opens a pdf from Flowcode's own tool in the panel even when the setting is system", async () => {
    mocks.settings.external = "system";
    const target = "https://example.com/paper.pdf";
    await routeAgentOpen({ ...request, target }, null, async () => true);
    expect(mocks.preview).toHaveBeenCalledWith(target, undefined);
    expect(mocks.system).not.toHaveBeenCalled();
  });

  it("keeps loopback previews automatic", async () => {
    await routeAgentOpen({ ...request, target: "http://localhost:3000" }, null);
    expect(mocks.preview).toHaveBeenCalledWith("http://localhost:3000", undefined);
  });
});

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

  it("ignores an opener word inside a quoted argument", () => {
    expect(openCommandTarget('git commit -m "open x.html"')).toBeNull();
    expect(openCommandTarget("echo 'start report.html'")).toBeNull();
  });
});

describe("commandCwd", () => {
  it("follows a leading cd", () => {
    expect(commandCwd("cd out && open a.html", "/p")).toBe("/p/out");
    expect(commandCwd('cd "/abs/dir"; open a.html', "/p")).toBe("/abs/dir");
    expect(commandCwd("open a.html", "/p")).toBe("/p");
  });
});

describe("toolCommand", () => {
  it("reads the command of a tool call's input", () => {
    expect(toolCommand({ rawInput: { command: "ls" } })).toBe("ls");
    expect(toolCommand({ rawInput: {} })).toBeNull();
    expect(toolCommand({})).toBeNull();
  });
});
