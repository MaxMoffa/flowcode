// DEV ONLY: exercises the real phone request/reply path without credentials or network access.
import { emit } from "@tauri-apps/api/event";
import type { ClientMsg, ServerMsg } from "../../shared/remote-types";
import type { ProviderAuthState } from "../../shared/providerAuth";

const sessions = new Map<string, ProviderAuthState>();
const connected = new Map<string, ProviderAuthState>();

export function providerAuthMock(message?: ClientMsg) {
  if (message?.t !== "providerauth") return;
  const { request, requestId } = message;
  const key = `${request.cli}:${request.profile || ""}`;
  let state: ProviderAuthState = { cli: request.cli, profile: request.profile, phase: "idle", method: null, sessionId: null, installed: true, authenticated: false, canApiKey: true, canBrowser: true, output: "" };
  if (request.op === "status") state = connected.get(key) || state;
  else if (request.op === "start") {
    state = { ...state, phase: "waiting", method: "browser", sessionId: `mock-${requestId}`, url: "https://example.invalid/flowcode-provider-auth", code: request.cli === "codex" ? "DEMO-4826" : undefined, output: "DEVELOPMENT MOCK\r\nNo real sign-in. Enter demo-complete to simulate authorization.\r\n" };
    sessions.set(state.sessionId!, state);
  } else if (request.op === "key") {
    const valid = request.apiKey?.startsWith("demo-");
    state = { ...state, phase: valid ? "success" : "error", method: "apiKey", authenticated: !!valid, error: valid ? undefined : "invalid_key" };
    if (valid) connected.set(key, state);
  } else {
    const active = request.sessionId ? sessions.get(request.sessionId) : null;
    if (!active) state = { ...state, phase: "error", error: "session_missing" };
    else if (request.op === "cancel") { sessions.delete(request.sessionId!); state = { ...active, phase: "cancelled" }; }
    else if (request.op === "input" && request.input?.includes("demo-complete")) {
      state = { ...active, phase: "success", authenticated: true };
      sessions.set(request.sessionId!, state);
      connected.set(key, state);
    } else state = active;
  }
  const response: ServerMsg = { t: "providerauth", requestId, state, error: null };
  setTimeout(() => void emit("remote://msgs", [response]), 30);
}
