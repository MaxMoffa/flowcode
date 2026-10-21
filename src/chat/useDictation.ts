import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type DictationState = "idle" | "listening" | "error";

interface DictationEnd {
  reason: "stopped" | "silence" | "error";
  message?: string | null;
}

/** `text` appended to `draft`, a space between them unless one is already there. */
export function appendDictation(draft: string, text: string): string {
  const spoken = text.trim();
  if (!spoken) return draft;
  if (!draft || /\s$/.test(draft)) return draft + spoken;
  return `${draft} ${spoken}`;
}

/** Whether the backend can dictate on this platform; asked once. */
let supportedProbe: Promise<boolean> | null = null;
function probeSupported(): Promise<boolean> {
  supportedProbe ??= invoke<boolean>("dictation_supported").catch(() => false);
  return supportedProbe;
}

/** Voice dictation through the backend's speech recognizer (see
 * src-tauri/src/dictation.rs). `onFinal` gets each phrase once it settles;
 * `partial` is the phrase still being heard, shown but never committed. The
 * session ends when `active` turns false or the component unmounts. */
export function useDictation(onFinal: (text: string) => void, active: boolean) {
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<DictationState>("idle");
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    let cancelled = false;
    probeSupported().then((ok) => {
      if (!cancelled) setSupported(ok);
    });
    const unlisten = Promise.all([
      listen<{ text: string }>("dictation://partial", (e) => setPartial(e.payload.text)),
      listen<{ text: string }>("dictation://final", (e) => {
        setPartial("");
        onFinalRef.current(e.payload.text);
      }),
      listen<DictationEnd>("dictation://end", (e) => {
        setPartial("");
        if (e.payload.reason === "error") {
          setError(e.payload.message ?? null);
          setState("error");
        } else {
          setState("idle");
        }
      }),
    ]);
    return () => {
      cancelled = true;
      unlisten.then((fns) => fns.forEach((fn) => fn()));
    };
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setPartial("");
    setState("listening");
    try {
      await invoke("dictation_start", {});
    } catch (e) {
      setError(String(e));
      setState("error");
    }
  }, []);

  const stop = useCallback(() => {
    if (stateRef.current !== "listening") return;
    setState("idle");
    setPartial("");
    invoke("dictation_stop").catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    if (stateRef.current === "listening") stop();
    else void start();
  }, [start, stop]);

  const dismissError = useCallback(() => {
    setError(null);
    setState((s) => (s === "error" ? "idle" : s));
  }, []);

  // A hidden view stops listening, and so does a closed one.
  useEffect(() => {
    if (!active) stop();
  }, [active, stop]);
  useEffect(() => stop, [stop]);

  return { supported, state, partial, error, start, stop, toggle, dismissError };
}
