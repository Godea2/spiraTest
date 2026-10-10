import type { MockState } from "@/lib/domain/types";
import { readItem, removeItem, writeItem } from "./storage";

const KEY = "mock-state";

export function loadMockState(): MockState {
  return readItem<MockState>(KEY) ?? { removed: {}, transientFailureUsed: {} };
}

export function saveMockState(state: MockState): void {
  writeItem(KEY, state);
}

export function resetMockState(): void {
  removeItem(KEY);
}
