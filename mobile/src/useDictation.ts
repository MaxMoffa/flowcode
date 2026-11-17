import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DictationState } from "../../src/chat/useDictation";
import { speechLocale, t, type Key } from "./i18n";
import { desktopDictationPref, desktopDictationUsable, useDesktopDictationPref } from "./dictationEngine";
import { useRemoteSelector } from "./remote";
import { startRemoteDictation, type RemoteSession } from "./remoteDictation";

// From the pure module: re-exporting the desktop hook would bundle the desktop i18n on the phone.
export { appendDictation } from "../../src/chat/dictationText";

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

/** Longest "transcribing" wait after a stop (the desktop gives up on its own after 20 s). */
const SETTLE_MAX_MS = 25_000;

/** Whether the phone can dictate; asked once. */
let supportedProbe: Promise<boolean> | null = null;
function probeSupported(): Promise<boolean> {
  supportedProbe ??= invoke<boolean>("speech_available").catch(() => false);
  return supportedProbe;
}

/** Voice dictation: the computer's Whisper when it is connected and willing
 * (src/remoteDictation.ts), else the phone's speech recognizer (see
 * src-tauri/src/speech.rs); a desktop that fails to start falls back to the
 * phone unnoticed. `onFinal` gets each phrase once it settles;
 * `partial` is the phrase still being heard, shown but never committed. The
 * session is dropped when `active` turns false, the app goes to the background
 * or the component unmounts. */
export function useDictation(onFinal: (text: string) => void, active: boolean) {
  const [phoneSupported, setPhoneSupported] = useState(false);
  const pref = useDesktopDictationPref();
  const hostHasCap = useRemoteSelector((s) => !!s.host?.caps.includes("dictation"));
  const online = useRemoteSelector((s) => s.status === "online");
  const desktopUsable = desktopDictationUsable({ pref, online, hostHasCap });
  const supported = phoneSupported || desktopUsable;
  const usableRef = useRef(desktopUsable);
  usableRef.current = desktopUsable;
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
  // The desktop session in use, if that engine is the one dictating.
  const remoteRef = useRef<RemoteSession | null>(null);
  // Bumped by every start and cancel, so a start that lost its race does not fall back.
  const startRef = useRef(0);
  // After `stop`, "transcribing" until the last phrase is in; this only guards against an end that never comes.
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settle = useCallback((next: DictationState) => {
    clearTimeout(settleTimer.current);
    setState(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    probeSupported().then((ok) => {
      if (!cancelled) setPhoneSupported(ok);
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
          settle("error");
        } else {
          settle("idle");
        }
      }),
    ]);
    return () => {
      cancelled = true;
      unlisten.then((fns) => fns.forEach((fn) => fn()));
      clearTimeout(settleTimer.current);
    };
  }, [settle]);

  const start = useCallback(async () => {
    droppedRef.current = false;
    setError(null);
    setPartial("");
    settle("listening");
    const token = ++startRef.current;
    // A stopped session still waiting for its last finals gives way to this one.
    remoteRef.current?.cancel();
    remoteRef.current = null;
    if (usableRef.current && desktopDictationPref()) {
      const session: RemoteSession = startRemoteDictation(speechLocale(), {
        onPartial: (text) => {
          if (remoteRef.current === session && !droppedRef.current) setPartial(text);
        },
        onFinal: (text) => {
          if (remoteRef.current !== session) return;
          setPartial("");
          if (!droppedRef.current) onFinalRef.current(text);
        },
        onEnd: (reason, code) => {
          if (remoteRef.current !== session) return;
          remoteRef.current = null;
          setPartial("");
          if (reason === "error") {
            setError(dictationError(code));
            settle("error");
          } else {
            settle("idle");
          }
        },
      });
      remoteRef.current = session;
      try {
        await session.ready;
        return;
      } catch (e) {
        console.debug("remote dictation unavailable, using the phone's recognizer:", String(e));
        if (remoteRef.current === session) remoteRef.current = null;
        // Stopped before the desktop was ready: no phrase will come, the wait is over.
        if (startRef.current === token && stateRef.current === "transcribing") settle("idle");
        // Stopped or cancelled meanwhile: nothing to fall back to.
        if (startRef.current !== token || stateRef.current !== "listening") return;
      }
    }
    try {
      await invoke("speech_start", { language: speechLocale() });
    } catch (e) {
      setError(String(e));
      settle("error");
    }
  }, [settle]);

  /** Ends the phrase; what was heard so far still arrives as final, while the state says "transcribing". */
  const stop = useCallback(() => {
    if (stateRef.current !== "listening") return;
    settle("transcribing");
    settleTimer.current = setTimeout(() => {
      if (stateRef.current === "transcribing") setState("idle");
    }, SETTLE_MAX_MS);
    setPartial("");
    if (remoteRef.current) remoteRef.current.stop();
    else invoke("speech_stop").catch(() => {});
  }, [settle]);

  /** Drops the session without a result - also the phrase a session already stopped may still deliver. */
  const cancel = useCallback(() => {
    droppedRef.current = true;
    startRef.current++;
    const remote = remoteRef.current;
    remoteRef.current = null;
    remote?.cancel();
    const was = stateRef.current;
    if (was !== "listening" && was !== "transcribing") return;
    settle("idle");
    setPartial("");
    if (!remote) invoke("speech_cancel").catch(() => {});
  }, [settle]);

  const toggle = useCallback(() => {
    if (stateRef.current === "listening") stop();
    // Still waiting for the last phrase: a tap must not drop it.
    else if (stateRef.current !== "transcribing") void start();
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
