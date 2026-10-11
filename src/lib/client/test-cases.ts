import type { TestCaseDetail } from "@/lib/domain/types";
import { api } from "./api";

const cache = new Map<string, Promise<TestCaseDetail>>();

/** A test case with its steps, read from Spira through the server. Kept for the session; failures are not cached. */
export function readTestCase(projectId: number, testCaseId: number, refresh = false): Promise<TestCaseDetail> {
  const key = `${projectId}:${testCaseId}`;
  const cached = cache.get(key);
  if (cached && !refresh) return cached;
  const request = api<TestCaseDetail>("/api/spira/test-case", { method: "POST", body: { projectId, testCaseId } });
  cache.set(key, request);
  request.catch(() => cache.delete(key));
  return request;
}
