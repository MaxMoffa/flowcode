import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  downloadPercent,
  ensureModelsLoaded,
  getDictationLanguage,
  getSelectedModel,
  hasInstalledModel,
  modelForSession,
  useDictationModels,
} from "./dictationModels";

export type DictationState = "idle" | "listening" | "error";

interface DictationEnd {
  reason: "stopped" | "silence" | "error";
  message?: string | null;
}

/** The "partial" text the backend sends while a phrase is being transcribed:
 * not words to keep, only a sign that it's working. */
export const TRANSCRIBING_MARKER = "…";

/** `text` appended to `draft`, a space between them unless one is already there. */
export function appendDictation(draft: string, text: string): string {
  const spoken = text.trim();
  if (!spoken) return draft;
  if (!draft || /\s$/.test(draft)) return draft + spoken;
  return `${draft} ${spoken}`;
}

/** The microphone level (0..1) after a new peak reading: speech peaks sit low
 * so they're lifted, a rise shows at once and a fall decays. */
export function nextLevel(prev: number, peak: number): number {
  const lifted = Math.min(1, Math.sqrt(Math.max(0, peak)) * 1.4);
  return Math.max(lifted, prev * 0.7);
}

/** Whether an event belongs to the session `current` (a chat consumes only
 * the events of the session it started). */
export function isOwnEvent(current: string | null, payload: { session?: string | null }): boolean {
  return current !== null && payload.session === current;
}

/** Whether the backend can dictate on this platform; asked once. */
let supportedProbe: Promise<boolean> | null = null;
function probeSupported(): Promise<boolean> {
  supportedProbe ??= invoke<boolean>("dictation_supported").catch(() => false);
  return supportedProbe;
}

function newSessionToken(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Voice dictation through the backend's speech recognizer (see
 * src-tauri/src/dictation.rs). `onFinal` gets each phrase once it settles;
 * `partial` is the phrase still being heard, shown but not committed until it
 * settles (or, when the session ends first, at its end). `level` follows the
 * microphone. After a stop the session lingers invisibly until its "end" so
 * the flushed last phrase still lands. The session ends when `active` turns
 * false or the component unmounts. */
export function useDictation(onFinal: (text: string) => void, active: boolean) {
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<DictationState>("idle");
  const [partial, setPartial] = useState("");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The setup dialog (model choice and download) open over this chat.
  const [setupOpen, setSetupOpen] = useState(false);
  const [readyNotice, setReadyNotice] = useState(false);
  const [noVoice, setNoVoice] = useState(false);
  const models = useDictationModels();
  const modelsRef = useRef(models);
  modelsRef.current = models;
  const activeRef = useRef(active);
  activeRef.current = active;
  const stateRef = useRef(state);
  stateRef.current = state;
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
  // The session this chat started and hasn't seen end yet.
  const sessionRef = useRef<string | null>(null);
  // The phrase being heard, not yet settled.
  const pendingRef = useRef("");
  // Whether the session heard anything, to tell a silent one from one that just ran out.
  const heardRef = useRef(false);

  /** Commits the unsettled phrase, if any. */
  const flushPending = useCallback(() => {
    const text = pendingRef.current;
    pendingRef.current = "";
    setPartial("");
    if (text.trim()) onFinalRef.current(text);
  }, []);

  useEffect(() => {
    let cancelled = false;
    probeSupported().then((ok) => {
      if (cancelled) return;
      setSupported(ok);
      if (ok) ensureModelsLoaded();
    });
    type Own = { session?: string | null };
    const unlisten = Promise.all([
      listen<Own & { text: string }>("dictation://partial", (e) => {
        if (!isOwnEvent(sessionRef.current, e.payload)) return;
        heardRef.current = true;
        // The marker only says a phrase is being transcribed: nothing to commit.
        pendingRef.current = e.payload.text === TRANSCRIBING_MARKER ? "" : e.payload.text;
        if (stateRef.current === "listening") setPartial(e.payload.text);
      }),
      listen<Own & { text: string }>("dictation://final", (e) => {
        if (!isOwnEvent(sessionRef.current, e.payload)) return;
        heardRef.current = true;
        pendingRef.current = "";
        setPartial("");
        onFinalRef.current(e.payload.text);
      }),
      listen<Own & { value: number }>("dictation://level", (e) => {
        if (!isOwnEvent(sessionRef.current, e.payload) || stateRef.current !== "listening") return;
        setLevel((prev) => nextLevel(prev, e.payload.value));
      }),
      listen<Own & DictationEnd>("dictation://end", (e) => {
        if (!isOwnEvent(sessionRef.current, e.payload)) return;
        sessionRef.current = null;
        flushPending();
        setLevel(0);
        if (e.payload.reason === "error") {
          setError(e.payload.message ?? null);
          setState("error");
        } else {
          setState("idle");
          if (e.payload.reason === "silence" && !heardRef.current) setNoVoice(true);
        }
      }),
    ]);
    return () => {
      cancelled = true;
      unlisten.then((fns) => fns.forEach((fn) => fn()));
    };
  }, [flushPending]);

  const start = useCallback(async () => {
    // A session still winding down gives up what it heard first.
    flushPending();
    // Known to have no model: ask for one rather than start and fail.
    const known = modelsRef.current;
    if (known.loaded && !hasInstalledModel(known.models)) {
      setSetupOpen(true);
      return;
    }
    const token = newSessionToken();
    sessionRef.current = token;
    heardRef.current = false;
    setError(null);
    setNoVoice(false);
    setLevel(0);
    setState("listening");
    try {
      await invoke("dictation_start", {
        session: token,
        language: getDictationLanguage(),
        model: modelForSession(modelsRef.current.models, getSelectedModel()),
      });
    } catch (e) {
      if (sessionRef.current === token) sessionRef.current = null;
      if (String(e) === "model-missing") {
        setLevel(0);
        setState("idle");
        setSetupOpen(true);
        return;
      }
      setError(String(e));
      setState("error");
    }
  }, [flushPending]);

  const stop = useCallback(() => {
    if (stateRef.current !== "listening") return;
    const token = sessionRef.current;
    setState("idle");
    setPartial("");
    setLevel(0);
    // The session stays ours until its "end": the flushed phrase arrives first.
    invoke("dictation_stop")
      .catch(() => {})
      .then(() => {
        // The end event should be in by now; if it never came, keep the phrase.
        setTimeout(() => {
          if (sessionRef.current === token) {
            sessionRef.current = null;
            flushPending();
          }
        }, 1000);
      });
  }, [flushPending]);

  /**
   * For a message being sent: ends the session at once and disowns it, so
   * nothing it still flushes lands in the next (empty) draft, and hands back
   * the phrase heard but not yet settled - the caller adds it to what it sends,
   * so the words on screen are the words sent. (Waiting for the final flush
   * instead would hold the send for up to a second.)
   */
  const discard = useCallback((): string => {
    const heard = pendingRef.current;
    pendingRef.current = "";
    // Only a session still listening is stopped: one already winding down stops on its own, and the recognizer may meanwhile serve another chat.
    const listening = stateRef.current === "listening" && sessionRef.current !== null;
    sessionRef.current = null;
    setPartial("");
    setLevel(0);
    setState((s) => (s === "listening" ? "idle" : s));
    if (listening) invoke("dictation_stop").catch(() => {});
    return heard;
  }, []);

  const toggle = useCallback(() => {
    if (stateRef.current === "listening") stop();
    else void start();
  }, [start, stop]);

  const dismissNoVoice = useCallback(() => setNoVoice(false), []);
  const dismissReady = useCallback(() => setReadyNotice(false), []);
  const closeSetup = useCallback(() => setSetupOpen(false), []);

  // A finished download closes the dialog and says so, without starting to listen.
  const seenReady = useRef(models.readyTick);
  useEffect(() => {
    if (models.readyTick === seenReady.current) return;
    seenReady.current = models.readyTick;
    setSetupOpen(false);
    if (activeRef.current) setReadyNotice(true);
  }, [models.readyTick]);
  useEffect(() => {
    if (!readyNotice) return;
    const timer = setTimeout(() => setReadyNotice(false), 8000);
    return () => clearTimeout(timer);
  }, [readyNotice]);

  // The download a mic without a model is waiting on, for its progress ring.
  const waiting = models.downloading && !hasInstalledModel(models.models) ? models.downloading : null;
  const downloadProgress = waiting ? downloadPercent(waiting.received, waiting.total) : null;

  const dismissError = useCallback(() => {
    setError(null);
    setState((s) => (s === "error" ? "idle" : s));
  }, []);

  // A hidden view stops listening, and so does a closed one.
  useEffect(() => {
    if (!active) stop();
  }, [active, stop]);
  useEffect(() => stop, [stop]);

  return {
    supported,
    state,
    partial,
    level,
    error,
    start,
    stop,
    discard,
    toggle,
    dismissError,
    setupOpen,
    closeSetup,
    /** Percent of the download a model-less mic is waiting on, else null. */
    downloadProgress,
    readyNotice,
    dismissReady,
    noVoice,
    dismissNoVoice,
  };
}
