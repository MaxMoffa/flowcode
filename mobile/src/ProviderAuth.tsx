import { useEffect, useState } from "react";
import { ProviderAuthDialog } from "../../shared/ProviderAuthDialog";
import { isAgentCli } from "../../shared/agentRegistry";
import { isProviderAuthError, type AuthProvider, type ProviderAuthTarget } from "../../shared/providerAuth";
import { useBackHandler } from "./back";
import { t } from "./i18n";
import { onMessage, profileAction, sendChecked, showToast, useRemoteSelector, useSupports } from "./remote";
import { createProviderAuthRequests } from "./providerAuthRequests";
import { openLink } from "./TermLink";
import { agentName } from "./common";
import "./provider-auth.css";

const requests = createProviderAuthRequests(sendChecked);
onMessage(message => {
  requests.receive(message);
  if (message.t === "ready" || (message.t === "error" && message.fatal)) requests.disconnect();
});

export function authProvider(value: string): AuthProvider | null {
  return isAgentCli(value) ? value : null;
}

/** One entry point from profiles, usage popups and provider errors. */
export function openProviderAuth(cli: AuthProvider, profile?: string | null, profileName?: string) {
  window.dispatchEvent(new CustomEvent<ProviderAuthTarget>("flowcode:provider-auth", { detail: { cli, profile: profile || null, profileName: profileName || (profile ? profile : t("defaultProfile")) } }));
}

export function ProviderAuthHost() {
  const [target, setTarget] = useState<ProviderAuthTarget | null>(null);
  const [required, setRequired] = useState<ProviderAuthTarget | null>(null);
  const status = useRemoteSelector(state => state.status);
  const host = useRemoteSelector(state => state.host);
  const profiles = useRemoteSelector(state => state.profiles);
  const resolvedLanguage = useRemoteSelector(state => state.settings?.resolvedLanguage);
  useEffect(() => onMessage(message => {
    if (message.t !== "providerauthrequired") return;
    const cli = authProvider(message.cli);
    if (!cli) return;
    setRequired({ cli, profile: message.profile, profileName: message.profile ? profiles?.find(profile => profile.id === message.profile)?.name || message.profile : t("defaultProfile") });
  }), [profiles]);
  useEffect(() => {
    const open = (event: Event) => {
      const requested = (event as CustomEvent<ProviderAuthTarget>).detail;
      if (!requested || !authProvider(requested.cli)) return;
      if (!host?.caps.includes("providerAuth")) {
        // Legacy desktops can only launch their terminal login. Say so explicitly.
        if (host?.caps.includes("profileLogin")) {
          profileAction({ op: "login", id: requested.profile || "", cli: requested.cli });
          showToast(t("providerAuthLegacy"));
        } else showToast(t("providerAuthUpgrade"));
        return;
      }
      const name = requested.profile ? profiles?.find(profile => profile.id === requested.profile)?.name || requested.profileName : t("defaultProfile");
      setTarget({ ...requested, profileName: name });
    };
    window.addEventListener("flowcode:provider-auth", open);
    return () => window.removeEventListener("flowcode:provider-auth", open);
  }, [host, profiles]);
  useEffect(() => {
    if (status === "online") return;
    requests.disconnect();
    setTarget(null);
    setRequired(null);
  }, [status]);
  useBackHandler(target !== null, () => setTarget(null));
  if (status !== "online") return null;
  return <>{required && !target && <div className="provider-auth-required-banner" role="alert"><strong>{t("providerAuthRequired")} · {agentName(required.cli)}</strong><span>{required.profileName}</span><button type="button" className="btn primary" onClick={() => setTarget(required)}>{t("providerAuthSignin")}</button><button type="button" className="btn ghost" onClick={() => setRequired(null)} aria-label={t("closeViewer")}>×</button></div>}{target && <ProviderAuthDialog key={`${target.cli}:${target.profile || ""}`} target={target} transport={requests.request} remote language={resolvedLanguage === "it" ? "it" : "en"} onClose={() => setTarget(null)} onSuccess={() => {
    if (required?.cli === target.cli && required.profile === target.profile) setRequired(null);
    window.dispatchEvent(new CustomEvent("flowcode:provider-authenticated", { detail: { cli: target.cli, profile: target.profile } }));
  }} onOpenUrl={openLink} />}</>;
}

/** Authentication is classified only at the chat's provider-error boundary. */
export function ProviderAuthNotice({ cli, profile, error, errorId }: { cli: string; profile?: string; error?: string | null; errorId?: string }) {
  const canAuth = useSupports("providerAuth");
  const canLegacy = useSupports("profileLogin");
  const profiles = useRemoteSelector(state => state.profiles);
  const [resolvedError, setResolvedError] = useState<string | null>(null);
  const signature = `${cli}:${profile || ""}:${errorId || ""}:${error || ""}`;
  const provider = authProvider(cli);
  useEffect(() => {
    const success = (event: Event) => {
      const detail = (event as CustomEvent<{ cli: string; profile: string | null }>).detail;
      if (detail?.cli === cli && detail.profile === (profile || null)) setResolvedError(signature);
    };
    window.addEventListener("flowcode:provider-authenticated", success);
    return () => window.removeEventListener("flowcode:provider-authenticated", success);
  }, [cli, profile, signature]);
  if (!provider || !error || signature === resolvedError || !isProviderAuthError(error)) return null;
  const profileName = profile ? profiles?.find(item => item.id === profile)?.name || profile : t("defaultProfile");
  return <div className="provider-auth-notice" role="alert"><span className="provider-auth-symbol" aria-hidden="true">!</span><div><strong>{t("providerAuthRequired")} · {agentName(cli)}</strong><p>{profileName}. {t("providerAuthHint")}</p>{(canAuth || canLegacy) && <button type="button" className="btn primary" onClick={() => openProviderAuth(provider, profile, profileName)}>{t("providerAuthSignin")}</button>}</div></div>;
}
