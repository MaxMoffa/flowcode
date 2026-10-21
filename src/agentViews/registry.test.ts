import { describe, expect, it } from "vitest";
import "./builtins";
import { DEFAULT_ACP_VIEW, agentView, agentViews, createRegistry, resolveAcpView, viewLabel } from "./registry";
import type { AgentViewDef, ViewDevice, ViewTransport } from "./types";

const DESKTOP: readonly ViewDevice[] = ["desktop"];

function def(id: string, transport: ViewTransport = "acp", source: AgentViewDef["source"] = "builtin"): AgentViewDef {
  return { id, labelKey: "agentViews.chat", source, transport, devices: DESKTOP };
}

describe("agent view registry", () => {
  it("keeps registration order", () => {
    const r = createRegistry();
    r.register(def("chat"));
    r.register(def("terminal", "pty"));
    r.register(def("board"));
    expect(r.list().map((v) => v.id)).toEqual(["chat", "terminal", "board"]);
    expect(r.get("terminal")?.transport).toBe("pty");
    expect(r.get("nope")).toBeUndefined();
    expect(r.get(undefined)).toBeUndefined();
  });
  it("throws on a duplicate id", () => {
    const r = createRegistry();
    r.register(def("chat"));
    expect(() => r.register(def("chat"))).toThrow();
  });
  it("resolveAcp falls back to the default view", () => {
    const r = createRegistry();
    r.register(def("chat"));
    r.register(def("terminal", "pty"));
    r.register(def("board"));
    expect(r.resolveAcp("board").id).toBe("board");
    expect(r.resolveAcp("gone").id).toBe("chat");
    expect(r.resolveAcp(undefined).id).toBe("chat");
    expect(r.resolveAcp("terminal").id).toBe("chat");
  });
  it("unregisters a plugin view but never a built-in one", () => {
    const r = createRegistry();
    r.register(def("chat"));
    r.register(def("board", "acp", "plugin"));
    r.unregister("chat");
    r.unregister("nope");
    expect(r.list().map((v) => v.id)).toEqual(["chat", "board"]);
    r.unregister("board");
    expect(r.list().map((v) => v.id)).toEqual(["chat"]);
    expect(r.resolveAcp("board").id).toBe("chat");
  });
  it("notifies subscribers with a new snapshot on every change", () => {
    const r = createRegistry();
    let calls = 0;
    const stop = r.subscribe(() => calls++);
    const empty = r.list();
    r.register(def("chat"));
    r.register(def("board", "acp", "plugin"));
    expect(calls).toBe(2);
    expect(r.list()).not.toBe(empty);
    const snapshot = r.list();
    r.unregister("chat");
    expect(calls).toBe(2);
    expect(r.list()).toBe(snapshot);
    r.unregister("board");
    expect(calls).toBe(3);
    stop();
    r.register(def("again", "acp", "plugin"));
    expect(calls).toBe(3);
  });
  it("names a view from its translations, its label or its key", () => {
    const t = () => "Chat";
    expect(viewLabel(def("chat"), t, "it")).toBe("Chat");
    const plugin: AgentViewDef = { id: "board", label: "Board", labels: { it: "Lavagna" }, source: "plugin", transport: "acp", devices: DESKTOP };
    expect(viewLabel(plugin, t, "it")).toBe("Lavagna");
    expect(viewLabel(plugin, t, "en")).toBe("Board");
    expect(viewLabel({ ...plugin, label: undefined, labels: undefined }, t, "en")).toBe("board");
  });
  it("resolveAcp throws without the default view", () => {
    expect(() => createRegistry().resolveAcp()).toThrow();
  });
  it("registers the built-in views", () => {
    expect(agentViews().map((v) => v.id)).toEqual(["chat", "terminal"]);
    expect(agentView("terminal")?.component).toBeUndefined();
    expect(resolveAcpView("terminal").id).toBe(DEFAULT_ACP_VIEW);
    expect(resolveAcpView().component).toBeDefined();
  });
});
