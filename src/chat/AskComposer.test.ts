import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AskComposer } from "./AskComposer";
import { parseAskQuestions } from "./askQuestions";
import type { ChatItem } from "./chatModel";

const schema = { properties: {
  q0: { type: "string", description: "How should we proceed?", oneOf: [{ const: "continue", title: "Continue" }] },
} };
const item = (form = schema): Extract<ChatItem, { type: "ask" }> => ({
  type: "ask", id: "ask-1", requestId: "1", message: "Questions", questions: parseAskQuestions(form, "Questions"),
});

describe("AskComposer agent forms", () => {
  it("identifies OpenCode and shows the real question and option", () => {
    const html = renderToStaticMarkup(createElement(AskComposer, { item: item(), agent: "OpenCode", autoFocus: false, onAnswer() {} }));
    expect(html).toContain("OpenCode");
    expect(html).not.toContain("Claude");
    expect(html).toContain("How should we proceed?");
    expect(html).toContain("Continue");
    expect(html).not.toContain("chat-ask-free");
  });

  it("identifies the agent in the multiple-question composer too", () => {
    const multiple = { properties: { ...schema.properties, q1: { ...schema.properties.q0, description: "Which component?" } } };
    const html = renderToStaticMarkup(createElement(AskComposer, { item: item(multiple), agent: "Codex", autoFocus: false, onAnswer() {} }));
    expect(html).toContain("Codex");
    expect(html).not.toContain("Claude");
    expect(html).not.toContain("chat-ask-free");
  });
});
