import { describe, expect, it } from "vitest";
import { askSummary, buildAskContent, parseAskQuestions } from "./askQuestions";

const opt = (label: string, description?: string) => ({ const: label, title: label, ...(description ? { description } : {}) });

// OpenCode's question tool uses qN keys and the generic form message "Questions".
const openCodeSchema = {
  type: "object",
  properties: {
    q0: { type: "string", title: "Direction", description: "How should we proceed?", oneOf: [opt("A (Recommended)"), opt("B")] },
    q0_custom: { type: "string", title: "Direction (other)", description: "Type your own answer" },
    q1: { type: "array", title: "Components", description: "Which components?", items: { anyOf: [{ const: "api", title: "API" }, { const: "ui", title: "Interface" }] } },
    q1_custom: { type: "string" },
  },
};

describe("OpenCode forms", () => {
  it("shows the actual questions and excludes their companion free-text fields", () => {
    const qs = parseAskQuestions(openCodeSchema, "Questions");
    expect(qs.map((q) => [q.key, q.header, q.text, q.multi])).toEqual([
      ["q0", "Direction", "How should we proceed?", false],
      ["q1", "Components", "Which components?", true],
    ]);
    expect(qs[0].options[0]).toMatchObject({ label: "A", recommended: true });
  });

  it("sends original keys and const values, keeping custom answers separate", () => {
    const qs = parseAskQuestions(openCodeSchema, "Questions");
    const content = buildAskContent(qs, [{ picked: [0], custom: "" }, { picked: [1, 0], custom: " docs " }]);
    expect(content).toEqual({ q0: "A (Recommended)", q1: ["api", "ui"], q1_custom: "docs" });
    expect(askSummary(qs, content)).toBe("A · API, Interface, docs");
    expect(buildAskContent(qs, [{ picked: [], custom: "Another direction" }])).toEqual({ q0_custom: "Another direction" });
  });

  it("supports arbitrary field names and distinct display labels without inventing a custom field", () => {
    const qs = parseAskQuestions({ properties: { pm: { type: "string", oneOf: [{ const: "bun", title: "Bun" }] } } }, "Which package manager?");
    expect(qs).toMatchObject([{ key: "pm", text: "Which package manager?", customKey: null, options: [{ label: "Bun", value: "bun" }] }]);
    expect(buildAskContent(qs, [{ picked: [0], custom: "" }])).toEqual({ pm: "bun" });
    expect(buildAskContent(qs, [{ picked: [], custom: "unsupported" }])).toEqual({});
  });

  it("sends plain text under its declared field and keeps arbitrary fields in schema order", () => {
    const qs = parseAskQuestions({ properties: {
      reason_custom: { type: "string", description: "Why?" },
      q10: { type: "string", oneOf: [opt("Yes")] },
      q2: { type: "string", oneOf: [opt("No")] },
    } }, "Questions");
    expect(qs.map((q) => q.key)).toEqual(["reason_custom", "q10", "q2"]);
    const content = buildAskContent(qs, [{ picked: [], custom: " because " }]);
    expect(content).toEqual({ reason_custom: "because" });
    expect(askSummary(qs, content)).toBe("because");
  });
});

it("answers permission options by id even when their labels match", () => {
  const question = { key: "question_0", text: "Allow?", multi: false, options: [
    { label: "Allow", value: "once", recommended: true },
    { label: "Allow", value: "always", recommended: false },
    { label: "Allow (2)", value: "other", recommended: false },
  ] };
  expect(buildAskContent([question], [{ picked: [1], custom: "" }])).toEqual({ question_0: "always" });
  expect(buildAskContent([question], [{ picked: [2], custom: "" }])).toEqual({ question_0: "other" });
});

describe("parseAskQuestions", () => {
  it("reads a single question, using the message as its text and stripping (Recommended)", () => {
    const schema = {
      type: "object",
      properties: {
        question_0: { type: "string", title: "Storage", oneOf: [opt("JSON (Recommended)", "simple"), opt("SQLite")] },
        question_0_custom: { type: "string", title: "Other" },
      },
    };
    const qs = parseAskQuestions(schema, "Where to store?");
    expect(qs).toEqual([
      {
        key: "question_0",
        header: "Storage",
        text: "Where to store?",
        multi: false,
        options: [
          { label: "JSON", value: "JSON (Recommended)", description: "simple", recommended: true },
          { label: "SQLite", recommended: false },
        ],
      },
    ]);
    expect(buildAskContent(qs, [{ picked: [0], custom: "" }])).toEqual({ question_0: "JSON (Recommended)" });
  });

  it("reads several questions in order, multi-select ones too, with per-question text", () => {
    const schema = {
      properties: {
        question_1: { type: "array", title: "Platforms", description: "Which?", items: { anyOf: [opt("Win"), opt("Mac")] } },
        question_0: { type: "string", description: "Approach?", oneOf: [opt("A"), opt("B")] },
      },
    };
    const qs = parseAskQuestions(schema, "generic");
    expect(qs.map((q) => [q.key, q.text, q.multi, q.options.length])).toEqual([
      ["question_0", "Approach?", false, 2],
      ["question_1", "Which?", true, 2],
    ]);
  });

  it("copes with junk", () => {
    expect(parseAskQuestions(null, "x")).toEqual([]);
    expect(parseAskQuestions({ properties: { question_0: 3 } }, "x")).toEqual([]);
  });
});

describe("buildAskContent", () => {
  const qs = parseAskQuestions(
    { properties: { question_0: { type: "string", oneOf: [opt("A"), opt("B")] }, question_1: { type: "array", items: { anyOf: [opt("X"), opt("Y")] } } } },
    "m",
  );
  it("sends labels, lists for multi, custom text, and omits unanswered", () => {
    expect(buildAskContent(qs, [{ picked: [1], custom: "" }, { picked: [1, 0], custom: " more " }])).toEqual({
      question_0: "B",
      question_1: ["X", "Y"],
      question_1_custom: "more",
    });
    expect(buildAskContent(qs, [{ picked: [], custom: "mine" }, { picked: [], custom: "" }])).toEqual({ question_0_custom: "mine" });
  });
  it("summarizes", () => {
    expect(askSummary(qs, { question_0: "B", question_1: ["X", "Y"], question_1_custom: "z" })).toBe("B · X, Y, z");
    expect(askSummary(qs, undefined)).toBe("");
  });
});
