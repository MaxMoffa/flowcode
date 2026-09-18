import { useTheme, type ThemeMode } from "../themes/ThemeContext";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { useSettingsSection } from "./SettingsSectionContext";
import { FunzionalitaPage } from "./FunzionalitaPage";
import type { PluginDef, PluginManifest } from "../plugins/types";
import pkg from "../../package.json";
import "./settings-page.css";

export type SidebarMode = "auto" | "docked" | "floating";

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
  info: "Info",
};

const SECTION_DESCRIPTIONS: Record<keyof typeof SECTION_TITLES, string> = {
  generale: "Aspetto dell'app, comportamento del terminale integrato e della sidebar dei file.",
  funzionalita: "Attiva, disattiva, crea o installa le funzionalità (plugin) disponibili nella barra rapida.",
  info: "Versione installata di Flowcode.",
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
  const { mode, setMode } = useTheme();
  const { fontSize, zoomIn, zoomOut, resetZoom } = useTerminalSettings();
  const { section } = useSettingsSection();

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
              <h3>Terminale</h3>
              <p className="settings-block-desc">Regola la dimensione del testo nel terminale integrato.</p>
              <div className="settings-field">
                <span className="settings-field-label">Zoom testo</span>
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
            </section>

            <section className="settings-block">
              <h3>File explorer</h3>
              <p className="settings-block-desc">Decide come si comporta il pannello dei file quando esplori una cartella.</p>
              <div className="settings-field">
                <span className="settings-field-label">Modalità sidebar</span>
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

        {section === "info" && <div className="settings-info">Flowcode v{pkg.version}</div>}
      </div>
    </div>
  );
}
