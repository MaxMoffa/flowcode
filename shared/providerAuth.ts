import type { AgentCli } from "./agentRegistry";

/** Shared desktop/phone contract. Secrets travel only in a direct request. */
export type AuthProvider = AgentCli;
export type AuthMethod = "browser" | "apiKey";
export interface ProviderAuthRequest {
  op: "status" | "start" | "poll" | "input" | "cancel" | "key";
  cli: AuthProvider;
  profile: string | null;
  method?: AuthMethod;
  sessionId?: string;
  input?: string;
  apiKey?: string;
  /** Remote browser login must avoid a callback to the phone's localhost. */
  remote?: boolean;
}
export interface ProviderAuthState {
  cli: AuthProvider;
  profile: string | null;
  method: AuthMethod | null;
  phase: "idle" | "waiting" | "success" | "error" | "cancelled";
  sessionId: string | null;
  installed: boolean;
  authenticated: boolean;
  canBrowser: boolean;
  canApiKey: boolean;
  /** CLI output contains no API-key input. Bounded, ephemeral, never persisted. */
  output: string;
  url?: string;
  code?: string;
  error?: string;
}
export type ProviderAuthTransport = (request: ProviderAuthRequest) => Promise<ProviderAuthState>;

export interface ProviderAuthTarget {
  cli: AuthProvider;
  profile: string | null;
  profileName: string;
}

/** Only provider errors qualify: call this on agent startup/prompt errors, never tool output. */
export function isProviderAuthError(error: string): boolean {
  return /auth_required:|\b(?:authentication|authorization)\s+(?:required|failed|expired|error)|\b(?:invalid|expired|revoked)\s+(?:api[ _-]?key|(?:oauth[ _-]?)?(?:access[ _-]?)?token|credentials?)|\b(?:not (?:logged|signed) in|please (?:log|sign) in|login required|unauthorized)\b|\b(?:claude auth login|codex login)\b/i.test(error);
}
