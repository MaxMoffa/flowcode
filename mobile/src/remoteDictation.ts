import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { onMessage } from "./remote";
import { remoteErrorToSpeechCode } from "./dictationEngine";

/** How long the desktop gets to load its model before the phone gives up and falls back. */
const READY_TIMEOUT_MS = 8000;
/** After `stop`, how long to wait for the desktop's last finals before giving up. */
const END_TIMEOUT_MS = 20000;

export interface RemoteHandlers {
  onPartial(text: string): void;
  onFinal(text: string): void;
  /** The session is over after it was ready (or stopped); never called for a failed start. */
  onEnd(reason: "stopped" | "error", speechCode?: string): void;
}

export interface RemoteSession {
  /** Resolves once the desktop is transcribing; rejects (with the reason) if it could not start. */
  ready: Promise<void>;
  /** End of speech: the remaining finals still arrive, then `onEnd`. */
  stop(): void;
  /** Drops everything quietly. */
  cancel(): void;
}

let counter = 0;

/** Records on the phone and has the desktop's Whisper transcribe it (see docs/design/remote-dictation-protocol.md). The audio is captured and queued from the first moment, so a fallback to the phone's recognizer only loses a few words if the desktop was slow. */
export function startRemoteDictation(language: string | undefined, h: RemoteHandlers): RemoteSession {
  const session = `m${Date.now().toString(36)}${(counter++).toString(36)}`;
  let phase: "starting" | "ready" | "ended" = "starting";
  let stopped = false;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  const unlisten: Array<() => void> = [];
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  // The caller may never await it (a cancelled start).
  ready.catch(() => {});

  const isEnded = () => phase === "ended";
  const sendMsg = (msg: Record<string, unknown>) => invoke("send", { msg }).catch(() => {});
  const cleanup = () => {
    phase = "ended";
    clearTimeout(readyTimer);
    clearTimeout(endTimer);
    unlisten.splice(0).forEach((fn) => fn());
  };
  const track = (p: Promise<() => void>) => {
    void p.then((fn) => (phase === "ended" ? fn() : unlisten.push(fn))).catch(() => {});
  };
  /** Ends the session on our side: microphone off, stream reset, desktop told. */
  const abort = () => {
    invoke("dict_audio_cancel", { session }).catch(() => {});
    void sendMsg({ t: "dictcancel", session });
  };
  const failStart = (reason: string, tellDesktop = true) => {
    if (phase !== "starting") return;
    cleanup();
    if (tellDesktop) abort();
    rejectReady(new Error(reason));
  };
  const end = (reason: "stopped" | "error", code?: string, tellDesktop = false) => {
    if (phase === "ended") return;
    cleanup();
    // A session the desktop ended itself has nothing to cancel there, but the microphone may still run.
    if (tellDesktop) abort();
    else invoke("dict_audio_cancel", { session }).catch(() => {});
    h.onEnd(reason, code);
  };

  track(
    Promise.resolve(onMessage((m) => {
      if (phase === "ended") return;
      switch (m.t) {
        case "dictready":
          if (m.session === session && phase === "starting") {
            phase = "ready";
            clearTimeout(readyTimer);
            resolveReady();
          }
          break;
        case "dictpartial":
          if (m.session === session) h.onPartial(m.text);
          break;
        case "dictfinal":
          if (m.session === session) h.onFinal(m.text);
          break;
        case "dictend":
          if (m.session !== session) break;
          if (phase === "starting") failStart(m.code ?? "failed", false);
          else end(m.reason === "error" ? "error" : "stopped", m.reason === "error" ? remoteErrorToSpeechCode(m.code) : undefined);
          break;
      }
    })),
  );
  // Stream or capture trouble; once stopped the desktop's own `dictend` settles it.
  track(
    listen<{ session: string }>("dictaudio://error", (e) => {
      if (e.payload.session !== session || phase === "ended") return;
      if (phase === "starting") failStart("audio");
      else if (!stopped) end("error", "unknown", true);
    }),
  );
  track(
    listen<{ status: string }>("remote://state", (e) => {
      if (e.payload.status === "online" || phase === "ended") return;
      if (phase === "starting") failStart("offline", false);
      else end("error", "network");
    }),
  );

  void (async () => {
    try {
      await invoke("send", { msg: { t: "dictstart", session, ...(language ? { language } : {}) } });
      // Cancelled (or failed) while the start message was going out: never turn the microphone on.
      if (phase !== "starting") return;
      // May wait for the microphone permission dialog; the timeout starts after it.
      await invoke("dict_audio_start", { session });
    } catch (e) {
      failStart(String(e));
      return;
    }
    if (isEnded()) {
      // Cancelled during the dialog: the capture that just began has no session any more.
      invoke("dict_audio_cancel", { session }).catch(() => {});
      return;
    }
    if (phase === "starting") readyTimer = setTimeout(() => failStart("timeout"), READY_TIMEOUT_MS);
  })();

  return {
    ready,
    stop() {
      if (phase === "ended" || stopped) return;
      stopped = true;
      invoke("dict_audio_stop").catch(() => {});
      void sendMsg({ t: "dictstop", session });
      clearTimeout(endTimer);
      endTimer = setTimeout(() => end("stopped", undefined, true), END_TIMEOUT_MS);
    },
    cancel() {
      if (phase === "ended") return;
      const wasStarting = phase === "starting";
      cleanup();
      abort();
      if (wasStarting) rejectReady(new Error("cancelled"));
    },
  };
}
