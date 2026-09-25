import { parseFlow } from "@flowkit-io/core";
import flowcodeIcon from "../assets/flowcode-icon.svg";
import { currentLanguage, t } from "../i18n";

/** Flowcode integrations offered on the "components" step - the ids of the
 * app's own example plugins (see plugins/registry.ts's examplePlugins()).
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
      : "C:\\Users\\...\\Programs\\Flowcode";

function shortcutSubtitle(): string {
  if (platform === "macos") return t("installer.shortcut.subtitle.macos");
  if (platform === "linux") return t("installer.shortcut.subtitle.linux");
  return t("installer.shortcut.subtitle.windows");
}

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
      title: t("installer.location.title"),
      subtitle: t("installer.location.subtitle"),
      image: { kind: "emoji", value: "📁" },
      placeholder: LOCATION_PLACEHOLDER,
      required: true,
    },
    {
      id: "shortcut",
      type: "checkbox",
      key: "desktop_shortcut",
      title: t("installer.shortcut.title"),
      subtitle: shortcutSubtitle(),
      label: t("installer.shortcut.label"),
      image: { kind: "emoji", value: "🖥️" },
      required: false,
    },
    {
      id: "components",
      type: "multi-select",
      key: "components",
      min: 0,
      title: t("installer.components.title"),
      subtitle: t("installer.components.subtitle"),
      image: { kind: "emoji", value: "🧩" },
      required: false,
      options: [
        {
          value: "claude-code" satisfies InstallableComponent,
          label: "Claude Code",
          description: t("installer.components.cli", { name: "Claude Code" }),
        },
        {
          value: "codex-cli" satisfies InstallableComponent,
          label: "Codex",
          description: t("installer.components.cli", { name: "Codex" }),
        },
      ],
    },
  ];

  const sameVersion = !!existing?.version && existing.version === installerVersion;
  const installed = existing?.version ? `Flowcode ${existing.version}` : "Flowcode";
  const verb = sameVersion ? t("installer.reinstall") : t("installer.update");

  const updateSteps = existing
    ? [
        {
          id: EXISTING_STEP_ID,
          type: "select-cards",
          key: "action",
          title: t("installer.existing.title"),
          subtitle: sameVersion
            ? t("installer.existing.same", { installed, dir: existing.dir })
            : t("installer.existing.older", { installed, dir: existing.dir, version: installerVersion }),
          image: { kind: "image", value: flowcodeIcon },
          required: true,
          options: [
            {
              value: UPDATE_ACTION,
              label: sameVersion ? t("installer.reinstall") : t("installer.updateTo", { version: installerVersion }),
              description: t("installer.existing.update.desc"),
            },
            {
              value: "custom",
              label: t("installer.custom"),
              description: t("installer.custom.desc"),
            },
          ],
        },
        {
          id: "route",
          type: "branch",
          rules: [{ when: { key: "action", op: "eq", value: UPDATE_ACTION }, goTo: "review" }],
          fallback: "setup",
        },
        { id: "setup", type: "subflow", title: t("installer.custom"), steps: setupSteps },
      ]
    : setupSteps;

  return parseFlow({
    id: "flowcode-installer",
    title: t("installer.title"),
    locale: currentLanguage(),
    disableBack: false,
    texts: {
      continue: t("welcome.continue"),
      submit: existing ? verb : t("installer.install"),
      // flowkit's fallback when a submit fails without its own message - its
      // stock wording is about a failed payment, which makes no sense here.
      paymentFailed: t("installer.failed"),
    },
    steps: [
      {
        id: "intro",
        type: "intro",
        key: "welcome",
        title: `${existing ? verb : t("installer.install")} Flowcode`,
        subtitle: existing ? t("installer.intro.existing", { installed }) : t("installer.intro.fresh"),
        cta: t("welcome.continue"),
        image: { kind: "image", value: flowcodeIcon },
      },
      ...updateSteps,
      {
        id: "review",
        type: "review",
        key: "review",
        mode: "final",
        title: existing
          ? t(sameVersion ? "installer.review.reinstall" : "installer.review.update")
          : t("installer.review.install"),
        subtitle: existing
          ? t("installer.review.existing", { version: installerVersion, dir: existing.dir, installed })
          : t("installer.review.fresh"),
        image: { kind: "emoji", value: "✅" },
        submitLabel: existing ? verb : t("installer.install"),
      },
      {
        id: "done",
        type: "confirmation",
        key: "done",
        title: t(existing ? (sameVersion ? "installer.done.reinstall" : "installer.done.update") : "installer.done.install"),
        message: t("installer.done.message", { name: existing ? `Flowcode ${installerVersion}` : "Flowcode" }),
        primaryCta: t("installer.done.cta"),
        showRestartButton: false,
        emoji: "🚀",
      },
    ],
  });
}
