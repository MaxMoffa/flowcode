import { parseFlow } from "@flowkit-io/core";
import flowcodeIcon from "../assets/flowcode-icon.svg";

/** Flowcode integrations offered on the "components" step - the ids of the
 * app's own example plugins (see plugins/registry.ts's EXAMPLE_PLUGINS).
 * Choosing one doesn't install the CLI itself: the installer only records
 * the choice, and the app enables and pins that plugin on first launch (the
 * plugin offers to install/log in to the CLI the first time it's clicked, if
 * it's missing). Kept as a named list so InstallerFlow.tsx and this step's
 * `options` can't silently drift apart. */
export const INSTALLABLE_COMPONENTS = ["claude-code", "codex-cli"] as const;
export type InstallableComponent = (typeof INSTALLABLE_COMPONENTS)[number];

/** Set by main.tsx before this lazily-loaded module is ever imported. The
 * same wizard ships on all three platforms (see src-tauri/installer/), only
 * the wording about where things end up differs. */
const platform = document.documentElement.dataset.platform;

const LOCATION_PLACEHOLDER =
  platform === "macos"
    ? "/Users/.../Applications"
    : platform === "linux"
      ? "/home/.../.local/share/flowcode"
      : "C:\\Utenti\\...\\Programs\\Flowcode";

const SHORTCUT_SUBTITLE =
  platform === "macos"
    ? "Flowcode.app viene comunque aggiunto alla cartella Applicazioni."
    : platform === "linux"
      ? "La voce nel menu delle applicazioni viene creata comunque."
      : "Il collegamento nel menu Start viene creato comunque.";

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
    // flowkit's fallback when a submit fails without its own message - its
    // stock wording is about a failed payment, which makes no sense here.
    paymentFailed: "Installazione non riuscita, riprova.",
  },
  steps: [
    {
      id: "intro",
      type: "intro",
      key: "welcome",
      title: "Installa Flowcode",
      subtitle:
        "Configura Flowcode su questo computer. Nei prossimi passaggi puoi scegliere dove installarlo e quali integrazioni attivare.",
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
      placeholder: LOCATION_PLACEHOLDER,
      required: true,
    },
    {
      id: "shortcut",
      type: "checkbox",
      key: "desktop_shortcut",
      title: "Collegamenti",
      subtitle: SHORTCUT_SUBTITLE,
      label: "Crea un collegamento sul Desktop",
      image: { kind: "emoji", value: "🖥️" },
      required: false,
    },
    {
      id: "components",
      type: "multi-select",
      key: "components",
      min: 0,
      title: "Integrazioni",
      subtitle:
        "Scegli quali integrazioni attivare in Flowcode: ognuna aggiunge un pulsante alla barra degli shortcut. Puoi cambiarle in seguito da Impostazioni > Funzionalità.",
      image: { kind: "emoji", value: "🧩" },
      required: false,
      options: [
        {
          value: "claude-code" satisfies InstallableComponent,
          label: "Claude Code",
          description:
            "Avvia Claude Code con un clic e mostra lo stato dell'account. Se la CLI non c'è, Flowcode ti propone di installarla al primo uso.",
        },
        {
          value: "codex-cli" satisfies InstallableComponent,
          label: "Codex",
          description:
            "Avvia Codex con un clic e mostra lo stato dell'account. Se la CLI non c'è, Flowcode ti propone di installarla al primo uso.",
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
