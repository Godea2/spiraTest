export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError(0, "Cannot reach the server. Check your connection and try again.");
  }
  const data = await response.json().catch(() => null);
  if (response.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth/")) {
    const next = window.location.pathname + window.location.search;
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- hard navigation drops in-memory board state from the expired session
    window.location.href = `/login?next=${encodeURIComponent(next)}`;
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      (data && typeof data.error === "string" && data.error) || `Request failed (HTTP ${response.status}).`,
      (data && data.fieldErrors) || {},
    );
  }
  return data as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
