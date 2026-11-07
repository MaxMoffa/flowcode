import { t } from "./i18n";
import { authProvider, openProviderAuth } from "./ProviderAuth";
import { useSupports, type UsageItem } from "./remote";

const providerOf: Record<string, string> = { "claude-code": "claude", "codex-cli": "codex", "gemini-cli": "gemini", "mistral-vibe": "vibe" };

export function ProviderUsageAuth({ item }: { item: UsageItem }) {
  const canAuth = useSupports("providerAuth");
  const canLegacy = useSupports("profileLogin");
  const provider = authProvider(providerOf[item.pluginId] || "");
  const needsAuth = item.metrics.some(metric => metric.kind === "reauth" || metric.kind === "loggedOut" || metric.kind === "noApiKey");
  if (!provider || !needsAuth || (!canAuth && !canLegacy)) return null;
  return <button type="button" className="btn primary provider-auth-usage-action" onClick={() => openProviderAuth(provider, item.profile, item.profileName)}>{t("providerAuthSignin")}</button>;
}
