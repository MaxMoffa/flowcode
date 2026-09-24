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

/** A Flowcode already on this machine (`installer_existing_install` on the
 * Rust side) - `version` is missing where the platform records none. */
export interface ExistingInstall {
  dir: string;
  version: string | null;
}


/** Answer of the "existing" step that picks the one-click update path. */
export const UPDATE_ACTION = "update";

/** Id of the step the wizard opens on when Flowcode is already installed. */
export const EXISTING_STEP_ID = "existing";

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
 * `select-cards`, which required at least one pick.
 *
 * With Flowcode already installed (`existing`), the setup questions become a
 * conditional subflow: the wizard opens on the "existing" choice
 * (InstallerFlow.tsx passes it as `initialStep`), and a branch either skips
 * straight to the review - a one-click update, same folder and shortcut, the
 * integrations left alone - or runs the "setup" subflow for a customized
 * reinstall. flowkit allows a single intro (first), final review and
 * confirmation (last), so both paths share those instead of each having
 * their own. A fresh install gets the plain linear wizard. */
export function buildInstallerFlow(existing: ExistingInstall | null, installerVersion: string) {
  const setupSteps = [
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
  ];

  const sameVersion = !!existing?.version && existing.version === installerVersion;
  const installed = existing?.version ? `Flowcode ${existing.version}` : "Flowcode";
  const verb = sameVersion ? "Reinstalla" : "Aggiorna";

  const updateSteps = existing
    ? [
        {
          id: EXISTING_STEP_ID,
          type: "select-cards",
          key: "action",
          title: "Flowcode è già installato",
          subtitle: sameVersion
            ? `${installed} si trova già in ${existing.dir}. Vuoi reinstallarlo così com'è o scegliere di nuovo le opzioni?`
            : `${installed} si trova in ${existing.dir}. Vuoi aggiornarlo alla versione ${installerVersion}?`,
          image: { kind: "image", value: flowcodeIcon },
          required: true,
          options: [
            {
              value: UPDATE_ACTION,
              label: sameVersion ? "Reinstalla" : `Aggiorna alla ${installerVersion}`,
              description: "Stessa cartella e stessi collegamenti. Impostazioni, preferiti e integrazioni restano come sono.",
            },
            {
              value: "custom",
              label: "Installazione personalizzata",
              description: "Scegli di nuovo cartella, collegamenti e integrazioni.",
            },
          ],
        },
        {
          id: "route",
          type: "branch",
          rules: [{ when: { key: "action", op: "eq", value: UPDATE_ACTION }, goTo: "review" }],
          fallback: "setup",
        },
        { id: "setup", type: "subflow", title: "Installazione personalizzata", steps: setupSteps },
      ]
    : setupSteps;

  return parseFlow({
    id: "flowcode-installer",
    title: "Installazione di Flowcode",
    locale: "it",
    disableBack: false,
    texts: {
      continue: "Avanti",
      submit: existing ? verb : "Installa",
      // flowkit's fallback when a submit fails without its own message - its
      // stock wording is about a failed payment, which makes no sense here.
      paymentFailed: "Installazione non riuscita, riprova.",
    },
    steps: [
      {
        id: "intro",
        type: "intro",
        key: "welcome",
        title: existing ? `${verb} Flowcode` : "Installa Flowcode",
        subtitle: existing
          ? `${installed} è già installato su questo computer.`
          : "Configura Flowcode su questo computer. Nei prossimi passaggi puoi scegliere dove installarlo e quali integrazioni attivare.",
        cta: "Avanti",
        image: { kind: "image", value: flowcodeIcon },
      },
      ...updateSteps,
      {
        id: "review",
        type: "review",
        key: "review",
        mode: "final",
        title: existing ? `Pronto per ${sameVersion ? "reinstallare" : "aggiornare"}` : "Pronto per installare",
        subtitle: existing
          ? `Flowcode ${installerVersion} verrà installato in ${existing.dir}, sostituendo ${installed}.`
          : "Controlla le scelte fatte prima di procedere.",
        image: { kind: "emoji", value: "✅" },
        submitLabel: existing ? verb : "Installa",
      },
      {
        id: "done",
        type: "confirmation",
        key: "done",
        title: existing ? `${sameVersion ? "Reinstallazione" : "Aggiornamento"} completato` : "Installazione completata",
        message: existing ? `Flowcode ${installerVersion} è pronto all'uso.` : "Flowcode è pronto all'uso.",
        primaryCta: "Apri Flowcode",
        showRestartButton: false,
        emoji: "🚀",
      },
    ],
  });
}
