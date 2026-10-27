import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DictationState } from "../../src/chat/useDictation";
import { speechLocale, t, type Key } from "./i18n";

export { appendDictation } from "../../src/chat/useDictation";

interface DictationEnd {
  reason: "stopped" | "silence" | "error";
  /** For an error, the code the Kotlin `SpeechPlugin` gives. */
  message?: string | null;
}

const ERRORS: Record<string, Key> = {
  permission: "dictateErrPermission",
  network: "dictateErrNetwork",
  busy: "dictateErrBusy",
  language: "dictateErrLanguage",
};

/** The words for an error code of the speech plugin. */
export function dictationError(code: string | null | undefined): string {
  return t((code && ERRORS[code]) || "dictateErrUnknown");
}

/** Whether the phone can dictate; asked once. */
let supportedProbe: Promise<boolean> | null = null;
function probeSupported(): Promise<boolean> {
  supportedProbe ??= invoke<boolean>("speech_available").catch(() => false);
  return supportedProbe;
}

/** Voice dictation through the phone's speech recognizer (see
 * src-tauri/src/speech.rs). `onFinal` gets each phrase once it settles;
 * `partial` is the phrase still being heard, shown but never committed. The
 * session is dropped when `active` turns false, the app goes to the background
 * or the component unmounts. */
export function useDictation(onFinal: (text: string) => void, active: boolean) {
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<DictationState>("idle");
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
  // Set by `cancel` until the next `start`: a phrase the recognizer still
  // flushes after it (e.g. right after the message was sent) is dropped instead
  // of landing in the next, empty draft.
  const droppedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    probeSupported().then((ok) => {
      if (!cancelled) setSupported(ok);
    });
    const unlisten = Promise.all([
      listen<{ text: string }>("speech://partial", (e) => {
        if (!droppedRef.current) setPartial(e.payload.text);
      }),
      listen<{ text: string }>("speech://final", (e) => {
        setPartial("");
        if (!droppedRef.current) onFinalRef.current(e.payload.text);
      }),
      listen<DictationEnd>("speech://end", (e) => {
        setPartial("");
        if (e.payload.reason === "error") {
          setError(dictationError(e.payload.message));
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
    droppedRef.current = false;
    setError(null);
    setPartial("");
    setState("listening");
    try {
      await invoke("speech_start", { language: speechLocale() });
    } catch (e) {
      setError(String(e));
      setState("error");
    }
  }, []);

  /** Ends the phrase; what was heard so far still arrives as final. */
  const stop = useCallback(() => {
    if (stateRef.current !== "listening") return;
    setState("idle");
    setPartial("");
    invoke("speech_stop").catch(() => {});
  }, []);

  /** Drops the session without a result - also the phrase a session already stopped may still deliver. */
  const cancel = useCallback(() => {
    droppedRef.current = true;
    if (stateRef.current !== "listening") return;
    setState("idle");
    setPartial("");
    invoke("speech_cancel").catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    if (stateRef.current === "listening") stop();
    else void start();
  }, [start, stop]);

  const dismissError = useCallback(() => {
    setError(null);
    setState((s) => (s === "error" ? "idle" : s));
  }, []);

  // A hidden view stops listening, and so does a closed one or a backgrounded app.
  useEffect(() => {
    if (!active) cancel();
  }, [active, cancel]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) cancel();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [cancel]);
  useEffect(() => cancel, [cancel]);

  return { supported, state, partial, error, start, stop, cancel, toggle, dismissError };
}
