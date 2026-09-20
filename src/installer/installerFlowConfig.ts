import { parseFlow } from "@flowkit-io/core";
import flowcodeIcon from "../assets/flowcode-icon.svg";

/** IDs of the optional CLIs offered on the "components" step - kept as a
 * named list (not re-derived from the flow config) so InstallerFlow.tsx's
 * install logic and this step's `options` can't silently drift apart. */
export const INSTALLABLE_COMPONENTS = ["claude", "codex"] as const;
export type InstallableComponent = (typeof INSTALLABLE_COMPONENTS)[number];

/** The installer's own wizard, separate from `welcomeFlowConfig.ts` (shown
 * once inside the running app) - this one is meant to run standalone, before
 * Flowcode itself is set up, so it never assumes the app's own state
 * (settings, theme preference, ...) exists yet. */
export const installerFlow = parseFlow({
  id: "flowcode-installer",
  title: "Installazione di Flowcode",
  locale: "it",
  disableBack: false,
  texts: {
    continue: "Avanti",
    submit: "Installa",
  },
  steps: [
    {
      id: "intro",
      type: "intro",
      key: "welcome",
      title: "Installa Flowcode",
      subtitle:
        "Configura Flowcode su questo computer. Nel passaggio successivo puoi scegliere quali funzionalità extra installare insieme al programma base.",
      cta: "Avanti",
      image: { kind: "image", value: flowcodeIcon },
    },
    {
      id: "components",
      type: "select-cards",
      key: "components",
      multiple: true,
      title: "Funzionalità extra",
      subtitle:
        "Flowcode di base viene sempre installato. Seleziona in più cosa installare adesso - puoi farlo comunque in seguito dalle Impostazioni.",
      image: { kind: "emoji", value: "🧩" },
      options: [
        {
          value: "claude" satisfies InstallableComponent,
          label: "Claude Code CLI",
          emoji: "🤖",
          description: "CLI ufficiale di Anthropic per programmare con Claude nel terminale.",
        },
        {
          value: "codex" satisfies InstallableComponent,
          label: "Codex CLI",
          emoji: "🧠",
          description: "CLI ufficiale di OpenAI per programmare con Codex nel terminale.",
        },
      ],
    },
    {
      id: "review",
      type: "review",
      key: "review",
      mode: "final",
      title: "Pronto per installare",
      submitLabel: "Installa",
    },
    {
      id: "done",
      type: "confirmation",
      key: "done",
      title: "Installazione completata",
      message: "Flowcode è pronto all'uso.",
      primaryCta: "Apri Flowcode",
      showRestartButton: false,
      emoji: "🚀",
    },
  ],
});
