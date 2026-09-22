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
 * (settings, theme preference, ...) exists yet.
 *
 * Every step carries an `image` (flowkit's standard emoji/icon/image slot -
 * see StepImage/StepTitle in @flowkit-io/react) plus a title/subtitle, so
 * each screen reads clearly on its own rather than relying on progress dots
 * alone. "location" uses the custom "directory" step type registered in
 * ./steps/directoryStepType.ts (a native folder-picker dialog) instead of
 * flowkit's bare `text` step - typing a Windows path by hand isn't how a
 * real installer's destination-folder screen works. "components" uses
 * flowkit's `multi-select` (classic checkbox list, zero-or-more) instead of
 * `select-cards`, which required at least one pick. */
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
        "Configura Flowcode su questo computer. Nei prossimi passaggi puoi scegliere dove installarlo e quali funzionalità extra aggiungere.",
      cta: "Avanti",
      image: { kind: "image", value: flowcodeIcon },
    },
    {
      id: "location",
      type: "directory",
      key: "location",
      title: "Cartella di installazione",
      subtitle: "Flowcode verrà installato qui. Usa \"Sfoglia...\" per scegliere un'altra cartella.",
      image: { kind: "emoji", value: "📁" },
      placeholder: "C:\\Utenti\\...\\Programs\\Flowcode",
      required: true,
    },
    {
      id: "shortcut",
      type: "checkbox",
      key: "desktop_shortcut",
      title: "Collegamenti",
      subtitle: "Il collegamento nel menu Start viene creato comunque.",
      label: "Crea un collegamento sul Desktop",
      image: { kind: "emoji", value: "🖥️" },
      required: false,
    },
    {
      id: "components",
      type: "multi-select",
      key: "components",
      min: 0,
      title: "Funzionalità extra",
      subtitle:
        "Flowcode di base viene sempre installato. Seleziona zero o più CLI da installare adesso - puoi farlo comunque in seguito dalle Impostazioni.",
      image: { kind: "emoji", value: "🧩" },
      required: false,
      options: [
        {
          value: "claude" satisfies InstallableComponent,
          label: "Claude Code CLI",
          description: "CLI ufficiale di Anthropic per programmare con Claude nel terminale.",
        },
        {
          value: "codex" satisfies InstallableComponent,
          label: "Codex CLI",
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
      subtitle: "Controlla le scelte fatte prima di procedere.",
      image: { kind: "emoji", value: "✅" },
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
