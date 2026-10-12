const PREFIX = "srs:";

export class StorageFullError extends Error {
  constructor() {
    super("This browser's storage is full. Delete drafts you no longer need, then try again.");
  }
}

function store(): Storage {
  const storage = globalThis.localStorage;
  if (!storage) throw new Error("Browser storage is not available.");
  return storage;
}

let changeListener: ((key: string) => void) | null = null;

/** Called after every write or removal made by the app, so it can be saved to shared storage. */
export function onLocalChange(listener: ((key: string) => void) | null): void {
  changeListener = listener;
}

export function readItem<T>(key: string): T | null {
  const raw = store().getItem(PREFIX + key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeItem(key: string, value: unknown): void {
  writeRaw(key, JSON.stringify(value));
  changeListener?.(key);
}

export function removeItem(key: string): void {
  removeRaw(key);
  changeListener?.(key);
}

/** Keys (without the app prefix) that start with `prefix`. */
export function keysWithPrefix(prefix: string): string[] {
  const storage = store();
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key?.startsWith(PREFIX + prefix)) keys.push(key.slice(PREFIX.length));
  }
  return keys;
}

/** The stored JSON text, without parsing or notifying. */
export function readRaw(key: string): string | null {
  return store().getItem(PREFIX + key);
}

/** Stores JSON text without notifying, for values that came from shared storage. */
export function writeRaw(key: string, raw: string): void {
  try {
    store().setItem(PREFIX + key, raw);
  } catch (error) {
    if (error instanceof DOMException && (error.name === "QuotaExceededError" || error.code === 22)) {
      throw new StorageFullError();
    }
    throw error;
  }
}

export function removeRaw(key: string): void {
  store().removeItem(PREFIX + key);
}
