import { useCallback, useState } from "react";

/** localStorage access that never throws - storage can be unavailable
 * (blocked, private mode, plain browser dev) and every caller just wants the
 * fallback in that case, not an exception. */
export function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export function removeKey(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/** A "1"/"0" flag, `fallback` when unset or unreadable. */
export function readBool(key: string, fallback: boolean): boolean {
  const stored = readString(key);
  if (stored === "1") return true;
  if (stored === "0") return false;
  return fallback;
}

export function writeBool(key: string, value: boolean) {
  writeString(key, value ? "1" : "0");
}

/** A finite number within [min, max], `fallback` otherwise. Checks for a
 * missing key first: `Number(null)` is 0, which would otherwise read as a
 * real stored value. */
export function readNumber(key: string, fallback: number, min = -Infinity, max = Infinity): number {
  const raw = readString(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/** One of `allowed`, `fallback` otherwise. */
export function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const stored = readString(key);
  return allowed.includes(stored as T) ? (stored as T) : fallback;
}

export function readJson<T>(key: string, validate: (value: unknown) => value is T, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(readString(key) ?? "null");
    return validate(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** `useState` that persists every update to localStorage under `key`.
 * `read`/`write` define the (de)serialization - see `readBool`/`writeBool`
 * and friends. The setter keeps the identity guarantees of React's own. */
export function usePersistentState<T>(
  key: string,
  read: (key: string) => T,
  write: (key: string, value: T) => void,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => read(key));
  const set = useCallback(
    (next: T | ((prev: T) => T)) =>
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
        if (resolved !== prev) write(key, resolved);
        return resolved;
      }),
    [key, write],
  );
  return [value, set];
}
