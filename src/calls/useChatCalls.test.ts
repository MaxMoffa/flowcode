import { beforeEach, expect, it, vi } from "vitest";
import { parseAskQuestions } from "../chat/askQuestions";
import { addCall, type NewCall } from "./callStore";
import { useChatCalls } from "./useChatCalls";

// Run mount effects to inspect the actual bubble callbacks without a DOM renderer.
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => unknown) => { effect(); },
  useRef: (current: unknown) => ({ current }),
  useId: () => "pane",
}));
vi.mock("./callStore", () => ({ addCall: vi.fn(), removeCallByKey: vi.fn(), useCallsEnabled: () => true }));

beforeEach(() => vi.clearAllMocks());

function bubble(properties: Record<string, unknown>) {
  const ask = vi.fn();
  useChatCalls("opencode", "tab", [{ type: "ask", id: "ask", requestId: "request", message: "Questions", questions: parseAskQuestions({ properties }, "Questions") }],
    { ask, permission: vi.fn() }, false, { parked: false });
  const call = vi.mocked(addCall).mock.calls[0][0] as NewCall;
  return { call, ask };
}

it("keeps closed-form bubble options but never offers an invalid free-text answer", () => {
  const { call, ask } = bubble({ pm: { type: "string", oneOf: [{ const: "bun", title: "Bun" }] } });
  expect(call.onReply).toBeUndefined();
  expect(call.options?.[0].label).toBe("Bun");
  call.onOption?.("0");
  expect(ask).toHaveBeenCalledWith("request", "accept", { pm: "bun" });
});

it("sends a declared OpenCode custom answer under its original companion key", () => {
  const { call, ask } = bubble({ q0: { type: "string", oneOf: [{ const: "A", title: "A" }] }, q0_custom: { type: "string" } });
  call.onReply?.("Another direction");
  expect(ask).toHaveBeenCalledWith("request", "accept", { q0_custom: "Another direction" });
});
