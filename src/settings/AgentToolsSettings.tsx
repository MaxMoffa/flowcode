import { useI18n } from "../i18n";
import { AGENT_CLIS, CLI_INFO, type AgentCli } from "../agents/cliInfo";
import { MAX_PARALLEL_RANGE, setAgentToolsSetting, useAgentToolsSettings } from "../agents/agentToolsSettings";
import { useAvailableClis } from "../agents/useAvailableClis";
import { Segmented, SettingRow, SettingsGroup, Switch } from "./SettingsControls";

const PARALLEL_OPTIONS = Array.from({ length: MAX_PARALLEL_RANGE.max - MAX_PARALLEL_RANGE.min + 1 }, (_, i) => String(MAX_PARALLEL_RANGE.min + i));

/** "Strumenti agenti": what chat agents may do through Flowcode's own MCP server. Read when a chat starts, so a change reaches new chats only. */
export function AgentToolsSettings() {
  const { t } = useI18n();
  const settings = useAgentToolsSettings();
  const installed = useAvailableClis(undefined);
  const onOff: [string, string] = [t("settings.on"), t("settings.off")];
  const { enabled } = settings;
  // The agents ticked: the saved choice, or all of them while it was never changed.
  const allowed = settings.delegateAgents ?? AGENT_CLIS;
  const toggleAgent = (cli: AgentCli, on: boolean) => {
    const next = on ? [...allowed, cli] : allowed.filter((c) => c !== cli);
    setAgentToolsSetting("delegateAgents", AGENT_CLIS.filter((c) => next.includes(c)));
  };

  return (
    <>
      <SettingsGroup title={t("settings.agentTools.group.server")} desc={t("settings.agentTools.appliesNew")}>
        <SettingRow id="agentToolsEnabled" label={t("settings.agentTools.enabled.label")} desc={t("settings.agentTools.enabled.desc")}>
          <Switch checked={enabled} onChange={(on) => setAgentToolsSetting("enabled", on)} label={t("settings.agentTools.enabled.label")} stateLabels={onOff} />
        </SettingRow>
      </SettingsGroup>

      {enabled && (
        <>
          <SettingsGroup title={t("settings.agentTools.open.label")}>
            <SettingRow id="agentToolsOpen" label={t("settings.agentTools.open.label")} desc={t("settings.agentTools.open.desc")}>
              <Switch checked={settings.open} onChange={(on) => setAgentToolsSetting("open", on)} label={t("settings.agentTools.open.label")} stateLabels={onOff} />
            </SettingRow>
            {settings.open && (
              <SettingRow id="agentToolsOpenAuto" label={t("settings.agentTools.openAuto.label")} desc={t("settings.agentTools.openAuto.desc")}>
                <Switch checked={settings.openAutoAllow} onChange={(on) => setAgentToolsSetting("openAutoAllow", on)} label={t("settings.agentTools.openAuto.label")} stateLabels={onOff} />
              </SettingRow>
            )}
          </SettingsGroup>

          <SettingsGroup title={t("settings.agentTools.call.label")}>
            <SettingRow id="agentToolsCall" label={t("settings.agentTools.call.label")} desc={t("settings.agentTools.call.desc")}>
              <Switch checked={settings.call} onChange={(on) => setAgentToolsSetting("call", on)} label={t("settings.agentTools.call.label")} stateLabels={onOff} />
            </SettingRow>
          </SettingsGroup>

          <SettingsGroup title={t("settings.agentTools.delegate.label")}>
            <SettingRow id="agentToolsDelegate" label={t("settings.agentTools.delegate.label")} desc={t("settings.agentTools.delegate.desc")}>
              <Switch checked={settings.delegate} onChange={(on) => setAgentToolsSetting("delegate", on)} label={t("settings.agentTools.delegate.label")} stateLabels={onOff} />
            </SettingRow>
            {settings.delegate && (
              <>
                {AGENT_CLIS.filter((cli) => installed.includes(cli)).map((cli) => (
                  <SettingRow key={cli} id={`agentToolsAgent-${cli}`} label={CLI_INFO[cli].label} desc={t("settings.agentTools.agent.desc", { agent: CLI_INFO[cli].name })}>
                    <Switch checked={allowed.includes(cli)} onChange={(on) => toggleAgent(cli, on)} label={CLI_INFO[cli].label} />
                  </SettingRow>
                ))}
                <SettingRow id="agentToolsParallel" label={t("settings.agentTools.parallel.label")} desc={t("settings.agentTools.parallel.desc")}>
                  <Segmented
                    ariaLabel={t("settings.agentTools.parallel.label")}
                    value={String(settings.maxParallel)}
                    options={PARALLEL_OPTIONS.map((value) => ({ value, label: value }))}
                    onChange={(value) => setAgentToolsSetting("maxParallel", Number(value))}
                  />
                </SettingRow>
              </>
            )}
          </SettingsGroup>
        </>
      )}
    </>
  );
}
