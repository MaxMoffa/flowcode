import { useSyncExternalStore } from "react";
import type { AuthProvider } from "../../shared/providerAuth";

export const PROVIDER_AUTH_OPEN = "flowcode:provider-auth-open";
export const PROVIDER_AUTHENTICATED = "flowcode:provider-authenticated";
export const PROVIDER_AUTH_REQUIRED = "flowcode:provider-auth-required";
export interface ProviderAuthOpen {
  cli: AuthProvider;
  profile: string | null;
  complete: (success: boolean) => void;
}
export interface ProviderAuthenticated { cli: AuthProvider; profile: string | null }
const required = new Set<string>();
const listeners = new Set<() => void>();
const keyOf = (cli: AuthProvider, profile?: string | null) => `${cli}\0${profile || ""}`;

/** Opens the dedicated provider dialog. It resolves only after verification or cancellation. */
export function openProviderAuth(cli: AuthProvider, profile?: string | null): Promise<boolean> {
  return new Promise((complete) => {
    window.dispatchEvent(new CustomEvent<ProviderAuthOpen>(PROVIDER_AUTH_OPEN, { detail: { cli, profile: profile || null, complete } }));
  });
}

export function providerAuthRequired(cli: AuthProvider, profile?: string | null): boolean {
  return required.has(keyOf(cli, profile));
}
export function markProviderAuthRequired(cli: AuthProvider, profile?: string | null): void {
  const key = keyOf(cli, profile);
  if (required.has(key)) return;
  required.add(key);
  listeners.forEach((listener) => listener());
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<ProviderAuthenticated>(PROVIDER_AUTH_REQUIRED, { detail: { cli, profile: profile || null } }));
}
export function completeProviderAuthentication(cli: AuthProvider, profile?: string | null): void {
  required.delete(keyOf(cli, profile));
  listeners.forEach((listener) => listener());
  window.dispatchEvent(new CustomEvent<ProviderAuthenticated>(PROVIDER_AUTHENTICATED, { detail: { cli, profile: profile || null } }));
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useProviderAuthRequired(cli: AuthProvider | undefined, profile?: string | null): boolean {
  return useSyncExternalStore(subscribe, () => cli ? providerAuthRequired(cli, profile) : false);
}
