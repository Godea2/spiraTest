import { afterEach, beforeEach, vi } from "vitest";

class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
}

const previousSecret = process.env.SESSION_SECRET;

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSecret;
});
