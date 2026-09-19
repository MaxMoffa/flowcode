import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** Chrome (gutters, selection, cursor, ...) themed with the app's own CSS
 * variables so it follows the light/dark theme automatically. */
export const cmChromeTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--term-fg)",
    backgroundColor: "transparent",
    fontSize: "13px",
  },
  ".cm-scroller": {
    fontFamily: "'JetBrains Mono', Menlo, Consolas, monospace",
    lineHeight: "1.55",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
    padding: "12px 0",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--accent)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--sidebar-selected-bg) !important",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--fg-muted)",
    border: "none",
    borderRight: "1px solid var(--border)",
    transition: "background-color 0.15s ease",
  },
  // The gutter is sticky (pinned left) while `.cm-content` scrolls under it
  // horizontally - staying transparent there let the code text show through
  // and overlap the line numbers. `cm-h-scrolled` (toggled in EditorView.tsx
  // on horizontal scroll) opaques it only while that's actually happening,
  // reverting once scrolled back to the left edge.
  "&.cm-h-scrolled .cm-gutters": {
    backgroundColor: "var(--bg-elevated)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--sidebar-hover)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--sidebar-hover)",
    color: "var(--fg)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 8px 0 6px",
  },
  ".cm-foldGutter": {
    color: "var(--fg-muted)",
  },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "var(--ctrl-hover-bg)",
    outline: "1px solid var(--border)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    color: "var(--fg)",
  },
  ".cm-tooltip-lint": {
    backgroundColor: "var(--bg-elevated)",
  },
  ".cm-diagnostic": {
    fontSize: "12px",
    borderLeftWidth: "3px",
  },
  ".cm-diagnostic-error": {
    borderLeftColor: "#d6544a",
  },
  ".cm-panels": {
    backgroundColor: "var(--bg-elevated)",
    color: "var(--fg)",
  },
});

/** Token colors via classes (not inline colors) so light/dark just falls
 * out of the app's existing [data-theme] CSS, defined in editor.css. */
export const cmHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], class: "cm-tok-keyword" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], class: "cm-tok-string" },
  { tag: [t.number, t.integer, t.float], class: "cm-tok-number" },
  { tag: [t.bool, t.atom, t.null], class: "cm-tok-bool" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "cm-tok-comment" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "cm-tok-function" },
  { tag: [t.typeName, t.className, t.namespace, t.macroName], class: "cm-tok-type" },
  { tag: [t.variableName, t.labelName], class: "cm-tok-variable" },
  { tag: t.propertyName, class: "cm-tok-property" },
  { tag: [t.operator, t.derefOperator, t.compareOperator, t.arithmeticOperator, t.logicOperator], class: "cm-tok-operator" },
  { tag: [t.punctuation, t.separator, t.bracket, t.squareBracket, t.paren, t.brace, t.angleBracket], class: "cm-tok-punctuation" },
  { tag: t.tagName, class: "cm-tok-tag" },
  { tag: t.attributeName, class: "cm-tok-attribute" },
  { tag: t.invalid, class: "cm-tok-invalid" },
  { tag: [t.meta, t.annotation], class: "cm-tok-comment" },
  { tag: t.heading, class: "cm-tok-heading" },
  { tag: t.link, class: "cm-tok-string" },
  { tag: t.strong, class: "cm-tok-keyword" },
]);
