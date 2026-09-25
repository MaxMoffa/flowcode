import { parseFlow } from "@flowkit-io/core";
import flowcodeIcon from "../assets/flowcode-icon.svg";
import { currentLanguage, t } from "../i18n";

/** Shown once, on the very first launch (see WelcomeFlow.tsx / WELCOME_SEEN_KEY).
 * Content pulled from README.md/ROADMAP.md's actual feature list - kept in
 * sync with those by hand, since the flow config can't import markdown.
 * Emoji go through each step's own `image`/`emoji` field, never baked into
 * title text - that's the field flowkit actually renders as the step's icon.
 * Built on demand, in the current UI language. */
export function buildWelcomeFlow() {
  return parseFlow({
    id: "flowcode-welcome",
    title: t("welcome.title"),
    locale: currentLanguage(),
    disableBack: false,
    texts: {
      continue: t("welcome.continue"),
      submit: t("welcome.submit"),
    },
    steps: [
      {
        id: "intro",
        type: "intro",
        key: "welcome",
        title: t("welcome.title"),
        subtitle: t("welcome.intro.subtitle"),
        cta: t("welcome.intro.cta"),
        image: { kind: "image", value: flowcodeIcon },
      },
      {
        id: "about-tabs",
        type: "info",
        key: "about_tabs",
        title: t("welcome.tabs.title"),
        subtitle: t("welcome.tabs.subtitle"),
        image: { kind: "emoji", value: "🗂️" },
      },
      {
        id: "about-explorer",
        type: "info",
        key: "about_explorer",
        title: t("welcome.explorer.title"),
        subtitle: t("welcome.explorer.subtitle"),
        image: { kind: "emoji", value: "📁" },
      },
      {
        id: "about-shortcuts",
        type: "info",
        key: "about_shortcuts",
        title: t("welcome.shortcuts.title"),
        subtitle: t("welcome.shortcuts.subtitle"),
        image: { kind: "emoji", value: "⚡" },
      },
      {
        id: "about-agents",
        type: "info",
        key: "about_agents",
        title: t("welcome.agents.title"),
        subtitle: t("welcome.agents.subtitle"),
        image: { kind: "emoji", value: "🤖" },
      },
      {
        id: "about-editor",
        type: "info",
        key: "about_editor",
        title: t("welcome.editor.title"),
        subtitle: t("welcome.editor.subtitle"),
        image: { kind: "emoji", value: "✏️" },
      },
      {
        id: "theme",
        type: "select-cards",
        key: "theme",
        title: t("welcome.theme.title"),
        image: { kind: "emoji", value: "🎨" },
        subtitle: t("welcome.theme.subtitle"),
        options: [
          { value: "light", label: t("theme.light"), emoji: "☀️", description: t("welcome.theme.light") },
          { value: "dark", label: t("theme.dark"), emoji: "🌙", description: t("welcome.theme.dark") },
          { value: "auto", label: t("welcome.theme.auto.label"), emoji: "🖥️", description: t("welcome.theme.auto") },
        ],
      },
      {
        id: "done",
        type: "confirmation",
        key: "done",
        title: t("welcome.done.title"),
        message: t("welcome.done.message"),
        primaryCta: t("welcome.done.cta"),
        showRestartButton: false,
        emoji: "🚀",
      },
    ],
  });
}
