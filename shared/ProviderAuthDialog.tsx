import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { AGENT_LOGOS } from "./agentLogos";
import { AGENT_CAPS } from "./agentRegistry";
import type { AuthMethod, ProviderAuthRequest, ProviderAuthState, ProviderAuthTarget, ProviderAuthTransport } from "./providerAuth";
import "./provider-auth.css";

const NAMES = { claude: "Claude Code", codex: "Codex CLI", gemini: "Gemini CLI", vibe: "Mistral Vibe" };
const COPY = {
  it: {
    title: "Accesso provider", profile: "Profilo", close: "Chiudi", cancel: "Annulla", loading: "Controllo dei metodi di accesso…",
    intro: "Collega il tuo account.", body: "Scegli come accedere. Il collegamento riguarda solo questo provider e questo profilo.",
    browser: "Account nel browser", browserHint: "Usa il tuo account e il tuo piano.", key: "Chiave API", keyHint: "Usa una chiave con fatturazione API separata.",
    continue: "Continua nel browser", save: "Verifica e collega", apiLabel: "Chiave API", apiPlaceholder: "Incolla la chiave del provider",
    secret: "La chiave viene inviata al PC collegato e conservata nella configurazione privata del profilo. Non viene salvata sul telefono.",
    localSecret: "La chiave viene verificata e conservata nella configurazione privata del profilo. Non viene inserita nella chat.",
    waiting: "Completa l’accesso.", waitingBody: "Apri la pagina del provider e autorizza l’accesso. Flowcode verifica il risultato prima di ricollegare il profilo.",
    preparing: "Preparazione dell’accesso…", open: "Apri pagina di accesso", code: "Codice dispositivo", manual: "Codice di autorizzazione o URL di ritorno",
    manualHint: "Se il browser mostra un codice, incollalo qui. Se il ritorno a localhost non riesce, incolla l’URL completo dalla barra degli indirizzi.",
    submit: "Invia codice", details: "Passaggi del provider", nativeHint: "Completa eventuali scelte richieste dal provider. Puoi usare il terminale o i pulsanti qui sotto.",
    enter: "Conferma", up: "Su", down: "Giù", checking: "Verifica in corso…", success: "Accesso completato.",
    successBody: "Il provider è pronto per questo profilo. Puoi riprendere il lavoro; nessun messaggio viene inviato automaticamente.",
    done: "Torna al lavoro", retry: "Riprova", error: "Accesso non completato", missing: "Il provider non è installato sul PC. Installalo, poi riprova.",
    expired: "L’accesso è scaduto. Riprova per generare un nuovo collegamento.", network: "Il provider non è raggiungibile. Controlla la connessione e riprova.",
    invalid: "La chiave non è valida o non consente l’accesso. Controlla chiave e permessi.", unsupported: "Questa versione del provider non supporta il login guidato. Aggiorna la CLI oppure usa una chiave API.",
    busy: "È già in corso un accesso a questo provider e profilo. Completa o annulla l’altro accesso.", failed: "Il provider non ha confermato l’accesso. Riprova o scegli un altro metodo.",
    disconnected: "Collegamento con il PC interrotto. Riconnettiti e riprova.", session: "La sessione di accesso non è più disponibile. Riprova.",
    copy: "Copia link", copied: "Link copiato", noAuto: "Conversazione e bozza restano disponibili.", keyUnsupported: "Metodo non disponibile per questa configurazione.",
  },
  en: {
    title: "Provider sign-in", profile: "Profile", close: "Close", cancel: "Cancel", loading: "Checking sign-in methods…",
    intro: "Connect your account.", body: "Choose how to sign in. This connection applies only to this provider and profile.",
    browser: "Account in browser", browserHint: "Use your account and subscription.", key: "API key", keyHint: "Use a key with separate API billing.",
    continue: "Continue in browser", save: "Verify and connect", apiLabel: "API key", apiPlaceholder: "Paste the provider’s API key",
    secret: "The key is sent to the connected PC and stored in the profile’s private configuration. It is not saved on your phone.",
    localSecret: "The key is verified and stored in the profile’s private configuration. It is not added to the chat.",
    waiting: "Complete sign-in.", waitingBody: "Open the provider’s page and authorize access. Flowcode verifies the result before reconnecting the profile.",
    preparing: "Preparing sign-in…", open: "Open sign-in page", code: "Device code", manual: "Authorization code or return URL",
    manualHint: "If the browser shows a code, paste it here. If the return to localhost fails, paste the complete URL from the address bar.",
    submit: "Submit code", details: "Provider steps", nativeHint: "Complete any choices requested by the provider. Use the terminal or the buttons below.",
    enter: "Confirm", up: "Up", down: "Down", checking: "Verifying…", success: "You’re connected.",
    successBody: "The provider is ready for this profile. Resume your work; no message is sent automatically.",
    done: "Back to work", retry: "Try again", error: "Sign-in incomplete", missing: "This provider is not installed on the PC. Install it, then try again.",
    expired: "Sign-in expired. Try again to generate a new link.", network: "The provider is unreachable. Check your connection and try again.",
    invalid: "The key is invalid or does not allow access. Check the key and its permissions.", unsupported: "This provider version does not support guided sign-in. Update the CLI or use an API key.",
    busy: "Another sign-in is in progress for this provider and profile. Complete or cancel it first.", failed: "The provider did not confirm sign-in. Try again or choose another method.",
    disconnected: "The connection to the PC was lost. Reconnect and try again.", session: "This sign-in session is no longer available. Try again.",
    copy: "Copy link", copied: "Link copied", noAuto: "Your conversation and draft remain available.", keyUnsupported: "This method is unavailable for this configuration.",
  },
};

interface Props {
  target: ProviderAuthTarget;
  transport: ProviderAuthTransport;
  remote?: boolean;
  language: "it" | "en";
  onClose: () => void;
  onSuccess: (state: ProviderAuthState) => void;
  onOpenUrl: (url: string) => Promise<void> | void;
}

/** One modal and lifecycle for desktop and paired phones. No secrets in storage or events. */
export function ProviderAuthDialog({ target, transport, remote = false, language, onClose, onSuccess, onOpenUrl }: Props) {
  const text = COPY[language];
  const [snapshot, setSnapshot] = useState<ProviderAuthState | null>(null);
  const [method, setMethod] = useState<AuthMethod>("browser");
  const [key, setKey] = useState("");
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [details, setDetails] = useState(false);
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const previousOutput = useRef("");
  const latest = useRef({ transport, onSuccess, onClose });
  latest.current = { transport, onSuccess, onClose };
  const active = useRef(true);
  const currentSession = useRef<string | null>(null);
  const notified = useRef(false);
  const generation = useRef(0);
  const waiting = snapshot?.phase === "waiting";
  const success = snapshot?.phase === "success";
  const logo = AGENT_LOGOS[target.cli];
  const base = { cli: target.cli, profile: target.profile, remote };

  function errorMessage(error: string) {
    if (/timeout|expired/i.test(error)) return text.expired;
    if (/network|unreachable|connection.*failed|provider_unavailable|provider_rate_limited/i.test(error)) return text.network;
    if (/invalid_key|key_invalid|forbidden|unauthorized/i.test(error)) return text.invalid;
    if (/not_installed/i.test(error)) return text.missing;
    if (/unsupported/i.test(error)) return text.unsupported;
    if (/busy/i.test(error)) return text.busy;
    if (/disconnect|not connected|not_connected/i.test(error)) return text.disconnected;
    if (/session|owner/i.test(error)) return text.session;
    return text.failed;
  }

  function accept(next: ProviderAuthState, revision: number) {
    if (!active.current || revision !== generation.current) {
      if (next.sessionId && next.sessionId !== currentSession.current) void latest.current.transport({ ...base, op: "cancel", sessionId: next.sessionId }).catch(() => {});
      return;
    }
    if (notified.current && next.phase !== "success") return;
    currentSession.current = next.sessionId;
    setSnapshot(next);
    if (next.phase === "error") setFailure(next.error || "auth_failed");
    if (next.phase === "success" && !notified.current) {
      notified.current = true;
      latest.current.onSuccess(next);
    }
  }

  async function request(request: ProviderAuthRequest) {
    const revision = generation.current;
    setBusy(true);
    setFailure("");
    try { accept(await latest.current.transport(request), revision); }
    catch (error) { if (active.current && revision === generation.current) setFailure(String(error)); }
    finally { if (active.current && revision === generation.current) setBusy(false); }
  }

  useEffect(() => {
    active.current = true;
    const revision = generation.current;
    let live = true;
    const previousFocus = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    void latest.current.transport({ ...base, op: "status" }).then(next => {
      if (!live || revision !== generation.current) return;
      accept(next, revision);
      setMethod(next.method || (next.canBrowser ? "browser" : "apiKey"));
    }).catch(error => { if (live) setFailure(String(error)); });
    return () => {
      live = false;
      active.current = false;
      generation.current++;
      document.body.style.overflow = originalOverflow;
      const sessionId = currentSession.current;
      void latest.current.transport({ ...base, op: "cancel", sessionId: sessionId || undefined }).catch(() => {});
      previousFocus?.isConnected && previousFocus.focus();
    };
    // Host keys this component by provider/profile, keeping every request scoped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!waiting || !snapshot.sessionId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const sessionId = snapshot.sessionId;
    const revision = generation.current;
    async function poll() {
      try {
        const next = await latest.current.transport({ ...base, op: "poll", sessionId });
        if (!live) return;
        accept(next, revision);
        if (next.phase === "waiting") timer = setTimeout(poll, 1000);
      } catch (error) { if (live) setFailure(String(error)); }
    }
    timer = setTimeout(poll, 500);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, snapshot?.sessionId]);

  const inputRef = useRef<(input: string) => void>(() => {});
  inputRef.current = input => {
    const sessionId = currentSession.current;
    if (!sessionId || !waiting) return;
    const revision = generation.current;
    void latest.current.transport({ ...base, op: "input", sessionId, input }).then(next => accept(next, revision)).catch(error => { if (active.current && revision === generation.current) setFailure(String(error)); });
  };
  useEffect(() => {
    if (!details || !waiting || !terminalRef.current) return;
    const instance = new Terminal({ cols: 78, rows: 12, fontSize: 12, fontFamily: "Consolas, monospace", cursorBlink: true, scrollback: 100, theme: { background: "#17130f", foreground: "#e7d8c5" } });
    const fit = new FitAddon();
    instance.loadAddon(fit);
    instance.open(terminalRef.current);
    terminal.current = instance;
    previousOutput.current = "";
    const observer = new ResizeObserver(() => { try { fit.fit(); } catch { /* The dialog may be closing. */ } });
    observer.observe(terminalRef.current);
    const data = instance.onData(value => inputRef.current(value));
    try { fit.fit(); } catch { /* First layout follows in ResizeObserver. */ }
    return () => { observer.disconnect(); data.dispose(); instance.dispose(); terminal.current = null; };
  }, [details, waiting]);
  useEffect(() => {
    const instance = terminal.current;
    if (!instance) return;
    const output = snapshot?.output || "";
    if (output.startsWith(previousOutput.current)) instance.write(output.slice(previousOutput.current.length));
    else { instance.reset(); instance.write(output); }
    previousOutput.current = output;
  }, [snapshot?.output, details, waiting]);

  function close() { setKey(""); setManual(""); latest.current.onClose(); }
  function restart() {
    const sessionId = currentSession.current;
    generation.current++;
    // Only a browser session needs cancelling here: no key verification is in
    // flight once retry is shown, and a session-less cancel would abort the next one.
    if (sessionId) void latest.current.transport({ ...base, op: "cancel", sessionId }).catch(() => {});
    currentSession.current = null;
    setSnapshot(previous => previous ? { ...previous, phase: "idle", sessionId: null, output: "", error: undefined, url: undefined, code: undefined } : null);
    setFailure(""); setKey(""); setManual(""); setBusy(false); setDetails(false); setCopied(false); notified.current = false;
    if (!snapshot) void request({ ...base, op: "status" });
  }

  return createPortal(
    <div className="provider-auth-backdrop" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key !== "Tab") return;
      const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') || []).filter(node => node.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panelRef.current)) { event.preventDefault(); first?.focus(); }
    }}>
      <div className="provider-auth-panel" role="dialog" aria-modal="true" aria-labelledby="provider-auth-title" tabIndex={-1} ref={panelRef}>
        <header className="provider-auth-top"><span>{text.title}</span><button type="button" onClick={close} aria-label={text.close}>×</button></header>
        <div className="provider-auth-content">
          <div className="provider-auth-identity"><span className="provider-auth-mark"><svg viewBox={logo.viewBox} aria-hidden="true"><path d={logo.path} fill="currentColor" /></svg></span><div><strong>{NAMES[target.cli]}</strong><span>{text.profile}: {target.profileName}</span></div></div>
          <h2 id="provider-auth-title">{success ? text.success : waiting ? text.waiting : text.intro}</h2>
          <p className="provider-auth-intro">{success ? text.successBody : waiting ? text.waitingBody : text.body}</p>
          <div role="status" aria-live="polite">{busy && <p className="provider-auth-progress"><span className="provider-auth-spinner" />{text.checking}</p>}</div>
          {failure && <div className="provider-auth-error" role="alert"><strong>{text.error}</strong><p>{errorMessage(failure)}</p><button type="button" className="provider-auth-link" onClick={restart}>{text.retry}</button></div>}
          {success ? <><div className="provider-auth-success" aria-hidden="true">✓</div><button type="button" className="provider-auth-button is-primary" onClick={close}>{text.done}</button></> : !snapshot && !failure ? <p className="provider-auth-progress"><span className="provider-auth-spinner" />{text.loading}</p> : snapshot && !snapshot.installed ? <div className="provider-auth-error" role="alert">{text.missing}</div> : waiting ? <>
            {snapshot.code && <div className="provider-auth-code"><span>{text.code}</span><strong>{snapshot.code}</strong></div>}
            {snapshot.url ? <div className="provider-auth-browser-actions"><button type="button" className="provider-auth-button is-primary" onClick={() => void Promise.resolve(onOpenUrl(snapshot.url!)).catch(() => setFailure("browser_open_failed"))}>{text.open} ↗</button><button type="button" className="provider-auth-link" onClick={() => void navigator.clipboard.writeText(snapshot.url!).then(() => setCopied(true)).catch(() => setFailure("clipboard_failed"))}>{copied ? text.copied : text.copy}</button></div> : <p className="provider-auth-progress"><span className="provider-auth-spinner" />{text.preparing}</p>}
            {AGENT_CAPS[target.cli].authManualCode && <form className="provider-auth-manual" onSubmit={event => { event.preventDefault(); const value = manual.trim(); if (value) { inputRef.current(value + "\r"); setManual(""); } }}><label htmlFor="provider-auth-code-input">{text.manual}</label><p>{text.manualHint}</p><input id="provider-auth-code-input" value={manual} autoComplete="off" spellCheck={false} onChange={event => setManual(event.target.value)} /><button type="submit" className="provider-auth-button" disabled={!manual.trim()}>{text.submit}</button></form>}
            {AGENT_CAPS[target.cli].authNativeTerminal && <><button type="button" className="provider-auth-link" aria-expanded={details} onClick={() => setDetails(value => !value)}>{text.details} {details ? '−' : '+'}</button>{details && <div className="provider-auth-native"><p>{text.nativeHint}</p><div className="provider-auth-terminal" ref={terminalRef} /><div className="provider-auth-native-buttons"><button type="button" onClick={() => inputRef.current("\u001b[A")}>{text.up}</button><button type="button" onClick={() => inputRef.current("\u001b[B")}>{text.down}</button><button type="button" onClick={() => inputRef.current("\r")}>{text.enter}</button></div></div>}</>}
          </> : snapshot && snapshot.installed ? <>
            <div className="provider-auth-methods" role="radiogroup" aria-label={text.title}>{(["browser", "apiKey"] as const).map(value => <button type="button" role="radio" aria-checked={method === value} disabled={busy || (value === "browser" ? !snapshot.canBrowser : !snapshot.canApiKey)} className={"provider-auth-method" + (method === value ? " is-selected" : "")} key={value} onClick={() => { setMethod(value); setFailure(""); setKey(""); }}><span className="provider-auth-radio" /><span><strong>{value === "browser" ? text.browser : text.key}</strong><small>{value === "browser" ? text.browserHint : text.keyHint}</small></span></button>)}</div>
            <form onSubmit={event => { event.preventDefault(); if (busy) return; if (method === "apiKey") { const apiKey = key.trim(); if (!apiKey) return; setKey(""); void request({ ...base, op: "key", method, apiKey }); } else void request({ ...base, op: "start", method }); }}>
              {method === "apiKey" && <label className="provider-auth-key-label">{text.apiLabel}<input type="password" value={key} placeholder={text.apiPlaceholder} onChange={event => setKey(event.target.value)} autoComplete="off" spellCheck={false} disabled={busy} /></label>}
              <button type="submit" className="provider-auth-button is-primary" disabled={busy || (method === "apiKey" && !key.trim())}>{method === "apiKey" ? text.save : text.continue}</button>
            </form>
            <p className="provider-auth-assurance">{method === "apiKey" ? remote ? text.secret : text.localSecret : text.noAuto}</p>
          </> : null}
        </div>
        <footer className="provider-auth-footer"><span>{target.profileName} · {NAMES[target.cli]}</span><button type="button" onClick={close}>{success ? text.close : text.cancel}</button></footer>
      </div>
    </div>, document.body,
  );
}
