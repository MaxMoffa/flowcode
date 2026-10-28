import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t, type MessageKey } from "../i18n";
import { readEnum, readString, removeKey, writeString } from "../lib/storage";

/** A speech model as the backend lists it (see src-tauri/src/dictation.rs). */
export interface DictationModel {
  id: string;
  sizeBytes: number;
  installed: boolean;
  recommended: boolean;
}

export interface DownloadProgress {
  id: string;
  received: number;
  total: number;
}

/** The last `dictation://download` event of a download, as the backend sends it. */
export interface DownloadDone {
  id: string;
  done: "installed" | "cancelled" | "error";
  message?: string | null;
}

export interface ModelsState {
  models: DictationModel[];
  /** The absolute folder the models live in. */
  dir: string;
  /** The one download in flight, app-wide. */
  downloading: DownloadProgress | null;
  loaded: boolean;
  /** Why the last download failed (not a cancellation). */
  error: string | null;
  /** The model whose download failed, for "Riprova". */
  failedId: string | null;
  /** Bumped each time a download finishes, so views can announce it once. */
  readyTick: number;
}

export const INITIAL_MODELS: ModelsState = {
  models: [],
  dir: "",
  downloading: null,
  loaded: false,
  error: null,
  failedId: null,
  readyTick: 0,
};

/** Megabytes as shown in the UI: 1 MB = 1,000,000 bytes, rounded. */
export function formatMb(bytes: number): number {
  return Math.round(Math.max(0, bytes) / 1_000_000);
}

/** Download progress as a whole percent, 0 while the total is unknown. */
export function downloadPercent(received: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((received / total) * 100)));
}

/** The model preselected in the setup dialog: the recommended one. */
export function defaultModelId(models: DictationModel[]): string | null {
  return (models.find((m) => m.recommended) ?? models[0])?.id ?? null;
}

export const hasInstalledModel = (models: DictationModel[]): boolean => models.some((m) => m.installed);

/** The `dictation_models` answer folded into the state. A download that is no
 * longer running comes back null: that's how a window that only watched learns it ended. */
export function applyModels(
  state: ModelsState,
  payload: { models: DictationModel[]; dir?: string; downloading: DownloadProgress | null },
): ModelsState {
  return { ...state, models: payload.models, dir: payload.dir ?? state.dir, downloading: payload.downloading, loaded: true };
}

/** A download's end folded into the state: the download is cleared, a failure
 * keeps its message for the dialog, an install bumps `readyTick`. */
export function applyDone(state: ModelsState, end: DownloadDone): ModelsState {
  const next = { ...state, downloading: null };
  if (end.done === "installed") return { ...next, error: null, failedId: null, readyTick: state.readyTick + 1 };
  if (end.done === "error") return { ...next, error: end.message || "error", failedId: end.id };
  return { ...next, error: null, failedId: null };
}

/** `path` shortened in the middle to at most `max` characters. */
export function ellipsizeMiddle(path: string, max: number): string {
  if (path.length <= max || max < 5) return path;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${path.slice(0, head)}…${path.slice(path.length - (keep - head))}`;
}

/** A `dictation://download` progress event folded into the state. */
export function applyProgress(state: ModelsState, progress: DownloadProgress): ModelsState {
  return { ...state, downloading: progress, error: null };
}

/** The model a session should use: the chosen one if it is installed, else
 * null and the backend picks whichever is. */
export function modelForSession(models: DictationModel[], chosen: string | null): string | null {
  return models.some((m) => m.id === chosen && m.installed) ? chosen : null;
}

let state = INITIAL_MODELS;
const listeners = new Set<() => void>();

function setState(next: ModelsState) {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-reads the installed models and the running download from the backend. */
export async function refreshModels(): Promise<void> {
  try {
    const payload = await invoke<{ models: DictationModel[]; dir: string; downloading: DownloadProgress | null }>("dictation_models");
    setState(applyModels(state, payload));
  } catch {
    /* unsupported platform or backend not ready */
  }
}

// Whether the end of the current download was already handled: the promise of
// the window that started it and the broadcast event both report it.
let endHandled = true;

/** Settles a download once, whichever of the promise and the event comes first. */
async function finishDownload(end: DownloadDone) {
  if (endHandled) return;
  endHandled = true;
  setState(applyDone(state, end));
  await refreshModels();
  // An installed model becomes the one in use unless the chosen one is installed already.
  if (end.done === "installed" && !state.models.some((m) => m.id === selectedModel && m.installed)) setSelectedModel(end.id);
}

let wired = false;
/** Subscribes to download events and loads the list, once per window. */
export function ensureModelsLoaded() {
  if (wired) return;
  wired = true;
  void listen<DownloadProgress & Partial<DownloadDone>>("dictation://download", (e) => {
    const p = e.payload;
    if (p.done) {
      void finishDownload({ id: p.id, done: p.done, message: p.message });
    } else {
      endHandled = false;
      setState(applyProgress(state, p));
    }
  });
  void refreshModels();
}

/** Downloads `id`; resolves once it has ended. Shared by every chat's dialog and Settings. */
export async function downloadModel(id: string): Promise<void> {
  const model = state.models.find((m) => m.id === id);
  endHandled = false;
  setState({ ...state, error: null, failedId: null, downloading: { id, received: 0, total: model?.sizeBytes ?? 0 } });
  try {
    await invoke("dictation_download_model", { id });
    await finishDownload({ id, done: "installed" });
  } catch (e) {
    const message = String(e);
    await finishDownload(message === "cancelled" ? { id, done: "cancelled" } : { id, done: "error", message });
  }
}

export function cancelDownload() {
  invoke("dictation_cancel_download").catch(() => {});
}

export async function deleteModel(id: string): Promise<void> {
  await invoke("dictation_delete_model", { id });
  if (selectedModel === id) setSelectedModel(null);
  await refreshModels();
}

export function clearDownloadError() {
  if (state.error) setState({ ...state, error: null });
}

export const useDictationModels = (): ModelsState => useSyncExternalStore(subscribe, () => state);

// --- preferences (this computer only, like the default agent view) ---------

const MODEL_KEY = "flowcode.dictation.model";
const LANGUAGE_KEY = "flowcode.dictation.language";
export const DICTATION_LANGUAGES = ["auto", "it", "en"] as const;
export type DictationLanguage = (typeof DICTATION_LANGUAGES)[number];

let selectedModel: string | null = readString(MODEL_KEY) || null;
let language: DictationLanguage = readEnum(LANGUAGE_KEY, DICTATION_LANGUAGES, "auto");
const prefListeners = new Set<() => void>();

function notifyPrefs() {
  prefListeners.forEach((listener) => listener());
}

export const getSelectedModel = (): string | null => selectedModel;
export const getDictationLanguage = (): DictationLanguage => language;

export function setSelectedModel(id: string | null) {
  selectedModel = id;
  if (id) writeString(MODEL_KEY, id);
  else removeKey(MODEL_KEY);
  notifyPrefs();
}

export function setDictationLanguage(next: DictationLanguage) {
  language = next;
  writeString(LANGUAGE_KEY, next);
  notifyPrefs();
}

function subscribePrefs(listener: () => void) {
  prefListeners.add(listener);
  return () => {
    prefListeners.delete(listener);
  };
}

export const useSelectedModel = (): string | null => useSyncExternalStore(subscribePrefs, getSelectedModel);
export const useDictationLanguage = (): DictationLanguage => useSyncExternalStore(subscribePrefs, getDictationLanguage);

const MODEL_TEXT: Record<string, { name: MessageKey; desc: MessageKey }> = {
  base: { name: "chat.dictate.model.base.name", desc: "chat.dictate.model.base.desc" },
  "small-q5": { name: "chat.dictate.model.smallQ5.name", desc: "chat.dictate.model.smallQ5.desc" },
  small: { name: "chat.dictate.model.small.name", desc: "chat.dictate.model.small.desc" },
};

/** A model's display name; an id this build does not know shows as itself. */
export const modelName = (id: string): string => (MODEL_TEXT[id] ? t(MODEL_TEXT[id].name) : id);
export const modelDescription = (id: string): string => (MODEL_TEXT[id] ? t(MODEL_TEXT[id].desc) : "");
