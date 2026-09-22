import { parseFlow } from "@flowkit-io/core";
import flowcodeIcon from "../assets/flowcode-icon.svg";

/** Shown once, on the very first launch (see WelcomeFlow.tsx / WELCOME_SEEN_KEY).
 * Content pulled from README.md/ROADMAP.md's actual feature list - kept in
 * sync with those by hand, since the flow config can't import markdown.
 * Emoji go through each step's own `image`/`emoji` field, never baked into
 * title text - that's the field flowkit actually renders as the step's icon. */
export const welcomeFlow = parseFlow({
  id: "flowcode-welcome",
  title: "Benvenuto in Flowcode",
  locale: "it",
  disableBack: false,
  texts: {
    continue: "Avanti",
    submit: "Inizia a usare Flowcode",
  },
  steps: [
    {
      id: "intro",
      type: "intro",
      key: "welcome",
      title: "Benvenuto in Flowcode",
      subtitle: "Un terminale desktop moderno, con file explorer integrato, shortcut personalizzabili e temi chiaro/scuro.",
      cta: "Inizia",
      image: { kind: "image", value: flowcodeIcon },
    },
    {
      id: "about-tabs",
      type: "info",
      key: "about_tabs",
      title: "Terminale a schede",
      subtitle: "Più sessioni in parallelo, raggruppate automaticamente in una cartella quando non entrano più nella barra.",
      image: { kind: "emoji", value: "🗂️" },
    },
    {
      id: "about-explorer",
      type: "info",
      key: "about_explorer",
      title: "File explorer laterale",
      subtitle:
        "Naviga, cerca ricorsivamente e gestisci i file della cartella del terminale attivo — ora anche con i ⭐ Preferiti per le cartelle che usi più spesso.",
      image: { kind: "emoji", value: "📁" },
    },
    {
      id: "about-shortcuts",
      type: "info",
      key: "about_shortcuts",
      title: "Funzionalità e shortcut",
      subtitle: "Scorciatoie personalizzabili nella barra in alto per azioni rapide (nuovo terminale, comandi, notifiche...).",
      image: { kind: "emoji", value: "⚡" },
    },
    {
      id: "about-agents",
      type: "info",
      key: "about_agents",
      title: "Agenti",
      subtitle: "Monitora Claude Code e Codex CLI, con l'utilizzo delle sessioni sempre a portata di sguardo.",
      image: { kind: "emoji", value: "🤖" },
    },
    {
      id: "about-editor",
      type: "info",
      key: "about_editor",
      title: "Editor integrato",
      subtitle: "Apri e modifica file senza uscire dal terminale.",
      image: { kind: "emoji", value: "✏️" },
    },
    {
      id: "theme",
      type: "select-cards",
      key: "theme",
      title: "Scegli il tuo tema",
      image: { kind: "emoji", value: "🎨" },
      subtitle: "Puoi cambiarlo in qualsiasi momento dalle impostazioni.",
      options: [
        { value: "light", label: "Chiaro", emoji: "☀️", description: "Chrome ambrato, ideale con tanta luce." },
        { value: "dark", label: "Scuro", emoji: "🌙", description: "Chrome quasi nero, comodo di sera." },
        { value: "auto", label: "Automatico", emoji: "🖥️", description: "Segue il tema del sistema operativo." },
      ],
    },
    {
      id: "done",
      type: "confirmation",
      key: "done",
      title: "Tutto pronto!",
      message: "Puoi sempre rivedere temi e preferenze dalle Impostazioni. Buon lavoro con Flowcode.",
      primaryCta: "Vai a Flowcode",
      showRestartButton: false,
      emoji: "🚀",
    },
  ],
});
