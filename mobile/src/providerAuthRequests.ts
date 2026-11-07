import type { ProviderAuthRequest, ProviderAuthState } from "../../shared/providerAuth";
import type { ClientMsg, ServerMsg } from "../../shared/remote-types";

/** Correlated, bounded requests. API keys are only held by the direct send call. */
export function createProviderAuthRequests(send: (message: ClientMsg) => Promise<boolean>, timeoutMs = 75_000) {
  const pending = new Map<string, { cli: ProviderAuthRequest["cli"]; profile: string | null; resolve: (state: ProviderAuthState) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let serial = 0;
  return {
    request(request: ProviderAuthRequest): Promise<ProviderAuthState> {
      const requestId = `provider-auth-${Date.now()}-${++serial}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("The computer did not answer the sign-in request. Try again."));
        }, timeoutMs);
        pending.set(requestId, { cli: request.cli, profile: request.profile, resolve, reject, timer });
        send({ t: "providerauth", requestId, request: { ...request, remote: true } }).then(ok => {
          if (ok) return;
          const entry = pending.get(requestId);
          if (!entry) return;
          clearTimeout(entry.timer);
          pending.delete(requestId);
          entry.reject(new Error("The computer is disconnected. Reconnect and try again."));
        }, () => {
          const entry = pending.get(requestId);
          if (!entry) return;
          clearTimeout(entry.timer);
          pending.delete(requestId);
          entry.reject(new Error("The sign-in request could not be sent. Try again."));
        });
      });
    },
    receive(message: ServerMsg) {
      if (message.t !== "providerauth") return;
      const entry = pending.get(message.requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(message.requestId);
      if (message.error || !message.state) entry.reject(new Error(message.error || "Invalid sign-in response."));
      else if (message.state.cli !== entry.cli || message.state.profile !== entry.profile) entry.reject(new Error("The sign-in response does not match the selected provider and profile."));
      else entry.resolve(message.state);
    },
    disconnect() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("The computer disconnected. Reopen sign-in after reconnecting."));
      }
      pending.clear();
    },
  };
}
