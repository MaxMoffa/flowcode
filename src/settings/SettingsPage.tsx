import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { useTheme, type ThemeMode } from "../themes/ThemeContext";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { useSettingsSection } from "./SettingsSectionContext";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { FunzionalitaPage } from "./FunzionalitaPage";
import { DEFAULT_QUICK_ACTIONS } from "../plugins/registry";
import { SHOW_HIDDEN_KEY } from "../sidebar/FileTree";
import type { PluginDef, PluginManifest } from "../plugins/types";
import pkg from "../../package.json";
import "./settings-page.css";

/** Third-party libraries the app is built on, with what each is used for.
 * Kept in sync by hand with package.json / Cargo.toml - versions are not
 * repeated here since dependency ranges (`^`) already make a pinned number
 * misleading. */
const CREDITS: { name: string; use: string }[] = [
  { name: "React", use: "libreria per l'interfaccia utente." },
  { name: "Vite", use: "server di sviluppo e build del frontend." },
  { name: "TypeScript", use: "tipizzazione statica per il codice frontend." },
  { name: "Tauri", use: "guscio nativo dell'app, ponte tra frontend e sistema operativo." },
  { name: "CodeMirror", use: "editor di codice integrato, con evidenziazione sintattica per i vari linguaggi." },
  { name: "xterm.js", use: "emulatore di terminale nel pannello del terminale integrato." },
  { name: "portable-pty", use: "avvio e gestione degli pseudo-terminali del sistema operativo, lato Rust." },
  { name: "sysinfo", use: "rilevamento dei processi (agenti CLI) in esecuzione nei terminali, lato Rust." },
  { name: "uuid", use: "identificativi univoci per le sessioni di terminale, lato Rust." },
];

export type SidebarMode = "auto" | "docked" | "floating";

interface ShellOption {
  id: string;
  label: string;
}

interface SettingsPageProps {
  quickActionIds: string[];
  onToggleQuickAction: (id: string) => void;
  sidebarMode: SidebarMode;
  onSetSidebarMode: (mode: SidebarMode) => void;
  plugins: PluginDef[];
  onAddPlugin: (manifest: PluginManifest) => void;
  onDeletePlugin: (id: string) => void;
}

const SECTION_TITLES = {
  generale: "Generali",
  funzionalita: "Funzionalità",
  info: "Informazioni",
};

const SECTION_DESCRIPTIONS: Record<keyof typeof SECTION_TITLES, string> = {
  generale: "Aspetto dell'app, comportamento del terminale integrato e della sidebar dei file.",
  funzionalita: "Attiva, disattiva, crea o installa le funzionalità (plugin) disponibili nella barra rapida.",
  info: "Versione installata, manutenzione e librerie open source su cui è costruito Flowcode.",
};

export function SettingsPage({
  quickActionIds,
  onToggleQuickAction,
  sidebarMode,
  onSetSidebarMode,
  plugins,
  onAddPlugin,
  onDeletePlugin,
}: SettingsPageProps) {
  const { mode, setMode, glassOpacity, setGlassOpacity } = useTheme();
  const {
    fontSize,
    zoomIn,
    zoomOut,
    resetZoom,
    bannerEnabled,
    setBannerEnabled,
    shellId,
    setShellId,
    startPath,
    setStartPath,
  } = useTerminalSettings();
  const { section } = useSettingsSection();
  const confirm = useConfirmDialog();
  const [versionCopied, setVersionCopied] = useState(false);
  const versionCopiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Which of the two "Cartella di avvio" choices is selected - kept as its
  // own bit of state rather than derived from `startPath !== ""`, because
  // that derivation is exactly what made the "Personalizzata" button look
  // broken: with a fresh/empty draft, `startPath` stayed "" even after
  // picking it, so the button never visually activated and the input box
  // (which was only rendered when a draft already existed) never appeared.
  const [customPathMode, setCustomPathMode] = useState(startPath !== "");
  const [startPathDraft, setStartPathDraft] = useState(startPath);
  const [startPathValid, setStartPathValid] = useState<boolean | null>(null);
  const startPathCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-validates on every keystroke (debounced) - `null` while unchecked, so
  // the commit effect below never mistakes "haven't verified yet" for
  // "verified valid".
  useEffect(() => {
    setStartPathValid(null);
    if (!startPathDraft) return;
    if (startPathCheckTimer.current) clearTimeout(startPathCheckTimer.current);
    startPathCheckTimer.current = setTimeout(() => {
      invoke<boolean>("is_directory", { path: startPathDraft })
        .then((ok) => setStartPathValid(ok))
        .catch(() => setStartPathValid(false));
    }, 300);
    return () => {
      if (startPathCheckTimer.current) clearTimeout(startPathCheckTimer.current);
    };
  }, [startPathDraft]);

  // Commits the draft to the real setting only once it's confirmed to exist -
  // an invalid/half-typed draft is shown in the field (with the error hint
  // below) but never becomes `startPath`, so App.tsx can trust it outright.
  // Switching back to "Home utente" clears it immediately either way.
  useEffect(() => {
    if (!customPathMode) {
      if (startPath !== "") setStartPath("");
      return;
    }
    if (startPathValid === true && startPathDraft && startPathDraft !== startPath) {
      setStartPath(startPathDraft);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customPathMode, startPathDraft, startPathValid]);
  // Which shells make sense to offer is OS-specific (see pty.rs's
  // `list_shell_options`) - fetched once rather than hardcoded here, so this
  // list can never drift from what `pty_spawn` will actually accept.
  const [shellOptions, setShellOptions] = useState<ShellOption[]>([]);

  useEffect(() => {
    invoke<ShellOption[]>("list_shell_options")
      .then(setShellOptions)
      .catch(() => setShellOptions([]));
  }, []);

  async function handleCopyVersionInfo() {
    const text = `${pkg.name} v${pkg.version} - ${pkg.description}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setVersionCopied(true);
    if (versionCopiedTimer.current) clearTimeout(versionCopiedTimer.current);
    versionCopiedTimer.current = setTimeout(() => setVersionCopied(false), 1200);
  }

  async function handleOpenConfigDir() {
    try {
      const dir = await invoke<string>("config_dir");
      await openPath(dir);
    } catch (e) {
      window.alert(`Impossibile aprire la cartella di configurazione: ${e}`);
    }
  }

  /** Resets everything that makes up "how the terminal looks and behaves
   * today" back to what a fresh install would have: theme, text zoom,
   * sidebar mode, quick-action pins and the hidden-files toggle. Deliberately
   * leaves custom plugins, the plugins directory and keyboard-shortcut
   * overrides untouched - deleting a plugin the user wrote is real, silent
   * data loss, and there's no UI yet to customize shortcuts in the first
   * place, so "resetting" them would silently change a file with no visible
   * effect until the app restarts. */
  async function handleResetTerminal() {
    const ok = await confirm({
      title: "Ripristina terminale",
      message:
        "Riporta tema, zoom del testo, banner all'apertura, shell predefinita, cartella di avvio, modalità della sidebar, azioni rapide nella barra e visibilità dei file nascosti ai valori predefiniti. I plugin personalizzati non vengono toccati. L'operazione non può essere annullata.",
      confirmLabel: "Ripristina",
      danger: true,
    });
    if (!ok) return;

    setMode("auto");
    resetZoom();
    setBannerEnabled(true);
    setShellId("system");
    setCustomPathMode(false);
    setStartPathDraft("");
    onSetSidebarMode("auto");

    const toRemove = quickActionIds.filter((id) => !DEFAULT_QUICK_ACTIONS.includes(id));
    const toAdd = DEFAULT_QUICK_ACTIONS.filter((id) => !quickActionIds.includes(id));
    for (const id of [...toRemove, ...toAdd]) onToggleQuickAction(id);

    try {
      localStorage.setItem(SHOW_HIDDEN_KEY, "0");
    } catch {
      /* storage unavailable */
    }
  }

  return (
    <div className="settings-page">
      <div className="settings-page-inner">
        <h1 className="settings-title">{SECTION_TITLES[section]}</h1>
        <p className="settings-page-desc">{SECTION_DESCRIPTIONS[section]}</p>

        {section === "generale" && (
          <>
            <section className="settings-block">
              <h3>Tema</h3>
              <p className="settings-block-desc">Scegli se l'aspetto dell'app deve seguire il sistema operativo oppure restare sempre chiaro o scuro.</p>
              <div className="settings-field">
                <span className="settings-field-label">Modalità tema</span>
                <p className="settings-field-desc">"Automatico" segue il tema chiaro/scuro impostato nel sistema operativo e cambia da solo se lo cambi lì.</p>
                <div className="settings-choice-row">
                  {(["auto", "light", "dark"] as ThemeMode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={"settings-choice" + (mode === m ? " is-active" : "")}
                      onClick={() => setMode(m)}
                    >
                      {m === "auto" ? "Automatico (sistema)" : m === "light" ? "Chiaro" : "Scuro"}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="settings-block">
              <h3>Trasparenza</h3>
              <p className="settings-block-desc">
                Regola quanto sono trasparenti i pannelli dell'app (barra laterale, terminale, finestre). Su Windows
                e Linux il sistema operativo non applica una sfocatura reale dietro la finestra, quindi un valore
                troppo basso rende il testo difficile da leggere.
              </p>
              <div className="settings-field">
                <span className="settings-field-label">Opacità pannelli</span>
                <p className="settings-field-desc">Valori più bassi rendono i pannelli più trasparenti; più alti li avvicinano a uno sfondo pieno.</p>
                <div className="settings-zoom-row">
                  <input
                    type="range"
                    min={0.3}
                    max={1}
                    step={0.01}
                    value={glassOpacity}
                    onChange={(e) => setGlassOpacity(Number(e.target.value))}
                    className="settings-opacity-slider"
                    aria-label="Opacità pannelli"
                  />
                  <span className="settings-zoom-value">{Math.round(glassOpacity * 100)}%</span>
                </div>
              </div>
            </section>

            <section className="settings-block">
              <h3>Terminale</h3>
              <p className="settings-block-desc">
                Regola la dimensione del testo e la shell usata dal terminale integrato. Il cambio di shell si
                applica alle schede aperte da questo momento in poi, non a quelle già aperte.
              </p>
              <div className="settings-field">
                <span className="settings-field-label">Zoom testo</span>
                <p className="settings-field-desc">Dimensione del carattere nel pannello del terminale integrato.</p>
                <div className="settings-zoom-row">
                  <button type="button" className="settings-zoom-btn" aria-label="Riduci zoom" onClick={zoomOut}>
                    −
                  </button>
                  <span className="settings-zoom-value">{fontSize}px</span>
                  <button type="button" className="settings-zoom-btn" aria-label="Aumenta zoom" onClick={zoomIn}>
                    +
                  </button>
                  <button type="button" className="settings-choice" onClick={resetZoom}>
                    Reimposta
                  </button>
                </div>
              </div>
              {shellOptions.length > 0 && (
                <div className="settings-field">
                  <span className="settings-field-label">Shell predefinita</span>
                  <p className="settings-field-desc">
                    Programma avviato in una nuova scheda di terminale. Il cambio si applica solo alle schede aperte
                    da questo momento in poi.
                  </p>
                  <div className="settings-choice-row">
                    {shellOptions.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={"settings-choice" + (shellId === opt.id ? " is-active" : "")}
                        onClick={() => setShellId(opt.id)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="settings-field">
                <span className="settings-field-label">Banner Flowcode all'apertura</span>
                <p className="settings-field-desc">Scritta ASCII "Flowcode" mostrata all'inizio di ogni scheda di terminale, prima dell'output della shell.</p>
                <div className="settings-choice-row">
                  <button
                    type="button"
                    className={"settings-choice" + (bannerEnabled ? " is-active" : "")}
                    onClick={() => setBannerEnabled(true)}
                  >
                    Mostra
                  </button>
                  <button
                    type="button"
                    className={"settings-choice" + (!bannerEnabled ? " is-active" : "")}
                    onClick={() => setBannerEnabled(false)}
                  >
                    Nascondi
                  </button>
                </div>
              </div>
              <div className="settings-field">
                <span className="settings-field-label">Cartella di avvio</span>
                <p className="settings-field-desc">
                  La cartella in cui si apre una nuova scheda di terminale quando non ce n'è già una aperta da cui
                  ereditare la posizione (es. il primo avvio dell'app).
                </p>
                <div className="settings-choice-row">
                  <button
                    type="button"
                    className={"settings-choice" + (!customPathMode ? " is-active" : "")}
                    onClick={() => setCustomPathMode(false)}
                  >
                    Home utente
                  </button>
                  <button
                    type="button"
                    className={"settings-choice" + (customPathMode ? " is-active" : "")}
                    onClick={() => setCustomPathMode(true)}
                  >
                    Personalizzata
                  </button>
                </div>
                {customPathMode && (
                  <>
                    <input
                      type="text"
                      className="settings-text-input"
                      value={startPathDraft}
                      placeholder="Es. C:\Progetti oppure /home/utente/progetti"
                      onChange={(e) => setStartPathDraft(e.target.value)}
                    />
                    {startPathValid === false && (
                      <span className="settings-field-hint is-error">Cartella non trovata.</span>
                    )}
                    {startPathValid === true && (
                      <span className="settings-field-hint is-success">Cartella valida, in uso.</span>
                    )}
                  </>
                )}
              </div>
            </section>

            <section className="settings-block">
              <h3>File explorer</h3>
              <p className="settings-block-desc">Decide come si comporta il pannello dei file quando esplori una cartella.</p>
              <div className="settings-field">
                <span className="settings-field-label">Modalità sidebar</span>
                <p className="settings-field-desc">
                  "Automatica" passa da fissata a flottante in base alla larghezza della finestra; le altre due la
                  bloccano sempre in uno dei due modi.
                </p>
                <div className="settings-choice-row">
                  <button
                    type="button"
                    className={"settings-choice" + (sidebarMode === "auto" ? " is-active" : "")}
                    onClick={() => onSetSidebarMode("auto")}
                  >
                    Automatica (larghezza)
                  </button>
                  <button
                    type="button"
                    className={"settings-choice" + (sidebarMode === "docked" ? " is-active" : "")}
                    onClick={() => onSetSidebarMode("docked")}
                  >
                    Fissato
                  </button>
                  <button
                    type="button"
                    className={"settings-choice" + (sidebarMode === "floating" ? " is-active" : "")}
                    onClick={() => onSetSidebarMode("floating")}
                  >
                    Flottante
                  </button>
                </div>
              </div>
            </section>
          </>
        )}

        {section === "funzionalita" && (
          <FunzionalitaPage
            plugins={plugins}
            enabledIds={quickActionIds}
            onToggleEnabled={onToggleQuickAction}
            onAdd={onAddPlugin}
            onDelete={onDeletePlugin}
          />
        )}

        {section === "info" && (
          <>
            <section className="settings-block">
              <h3>Versione</h3>
              <p className="settings-block-desc">{pkg.description}</p>
              <div className="settings-field">
                <span className="settings-field-label">
                  {pkg.name} v{pkg.version}
                </span>
                <p className="settings-field-desc">Copia nome, versione e descrizione dell'app negli appunti - utile per segnalare un problema.</p>
                <div className="settings-choice-row">
                  <button type="button" className="settings-choice" onClick={handleCopyVersionInfo}>
                    {versionCopied ? "Copiato" : "Copia informazioni versione"}
                  </button>
                </div>
              </div>
            </section>

            <section className="settings-block">
              <h3>Manutenzione</h3>
              <div className="settings-field">
                <span className="settings-field-label">Cartella di configurazione</span>
                <p className="settings-field-desc">
                  Apre la cartella su disco dove sono salvate le funzionalità personalizzate e le altre impostazioni
                  dell'app.
                </p>
                <div className="settings-choice-row">
                  <button type="button" className="settings-choice" onClick={handleOpenConfigDir}>
                    Apri cartella di configurazione
                  </button>
                </div>
              </div>
              <div className="settings-field">
                <span className="settings-field-label">Ripristina impostazioni</span>
                <p className="settings-field-desc">
                  Riporta tema, terminale, sidebar e azioni rapide ai valori predefiniti. I plugin personalizzati non
                  vengono toccati.
                </p>
                <div className="settings-choice-row">
                  <button type="button" className="settings-choice" onClick={handleResetTerminal}>
                    Ripristina terminale
                  </button>
                </div>
              </div>
            </section>

            <section className="settings-block">
              <h3>Crediti</h3>
              <p className="settings-block-desc">Le librerie open source su cui è costruito Flowcode.</p>
              <ul className="settings-credits-list">
                {CREDITS.map((c) => (
                  <li key={c.name} className="settings-credits-item">
                    <span className="settings-credits-name">{c.name}</span> — {c.use}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
