import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ProviderAuthDialog } from "../../shared/ProviderAuthDialog";
import type { ProviderAuthState, ProviderAuthTransport } from "../../shared/providerAuth";
import { useI18n } from "../i18n";
import { AGENT_CLIS, CLI_INFO, invalidateCliStatus } from "../agents/cliInfo";
import { refreshProviderUsage } from "../plugins/useUsageState";
import { refreshProfiles, useProfiles } from "./profiles";
import { completeProviderAuthentication, PROVIDER_AUTH_OPEN, type ProviderAuthenticated, type ProviderAuthOpen } from "./providerAuth";

const transport: ProviderAuthTransport = (request) => invoke<ProviderAuthState>("provider_auth", { request });

/** One dialog handles chat, usage popups and profile settings, without opening a terminal tab. */
export function ProviderAuthHost() {
  const { language, t } = useI18n();
  const { profiles } = useProfiles();
  const [request, setRequest] = useState<ProviderAuthOpen | null>(null);
  const activeRef = useRef<ProviderAuthOpen | null>(null);
  const revisionRef = useRef(0);
  const finishedRef = useRef(false);
  const lastSuccessRef = useRef(new Map<string, number>());
  const authenticated = useCallback(({ cli, profile }: ProviderAuthenticated) => {
    if (!(AGENT_CLIS as readonly string[]).includes(cli)) return;
    const key = `${cli}\0${profile ?? ""}`;
    if (Date.now() - (lastSuccessRef.current.get(key) ?? 0) < 1000) return;
    lastSuccessRef.current.set(key, Date.now());
    invalidateCliStatus(cli);
    completeProviderAuthentication(cli, profile);
    refreshProviderUsage(CLI_INFO[cli].pluginId, profile ?? undefined);
    void refreshProfiles();
  }, []);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const next = (event as CustomEvent<ProviderAuthOpen>).detail;
      if (!next || !(AGENT_CLIS as readonly string[]).includes(next.cli)) return;
      activeRef.current?.complete(false);
      activeRef.current = next;
      revisionRef.current++;
      finishedRef.current = false;
      setRequest(next);
    };
    window.addEventListener(PROVIDER_AUTH_OPEN, onOpen);
    const unlisten = listen<ProviderAuthenticated>("provider-authenticated", (event) => authenticated(event.payload));
    return () => {
      window.removeEventListener(PROVIDER_AUTH_OPEN, onOpen);
      unlisten.then((off) => off()).catch(() => {});
      activeRef.current?.complete(false);
    };
  }, [authenticated]);
  const close = () => {
    activeRef.current?.complete(false);
    activeRef.current = null;
    setRequest(null);
  };
  if (!request) return null;
  const target = { cli: request.cli, profile: request.profile, profileName: profiles.find((profile) => profile.id === request.profile)?.name ?? t("agents.profile.default") };
  return createPortal(<ProviderAuthDialog key={`${request.cli}:${request.profile ?? ""}:${revisionRef.current}`} target={target} transport={transport} language={language} onClose={close} onOpenUrl={openUrl} onSuccess={(state: ProviderAuthState) => {
    if (activeRef.current !== request || finishedRef.current || !state.authenticated || state.cli !== request.cli || state.profile !== request.profile) return;
    finishedRef.current = true;
    authenticated({ cli: state.cli, profile: state.profile });
    request.complete(true);
  }} />, document.body);
}
