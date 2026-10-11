import "server-only";
import { z } from "zod";
import { ApplyValidationError } from "@/lib/domain/apply-rules";
import { hasSession } from "./auth";
import { AiError } from "./gemini";
import { SealError } from "./seal";
import { SpiraError } from "./spira";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
  }
}

export function jsonError(status: number, error: string, fieldErrors?: Record<string, string>) {
  return Response.json({ error, ...(fieldErrors ? { fieldErrors } : {}) }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function ok<T>(body: T, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function parseBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "_";
      fieldErrors[key] ??= issue.message;
    }
    const batchError = fieldErrors["batch.actions"];
    throw new HttpError(400, batchError ?? "Some fields are not valid.", fieldErrors);
  }
  return parsed.data;
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return jsonError(error.status, error.message, error.fieldErrors);
  if (error instanceof ApplyValidationError) return jsonError(error.status, error.message);
  if (error instanceof SealError) return jsonError(error.status, error.message);
  if (error instanceof SpiraError) return jsonError(error.status, error.message);
  if (error instanceof AiError) return jsonError(error.status, error.message);
  console.error("Unhandled API error", error);
  return jsonError(500, "Something went wrong on the server. Check the server logs.");
}

/**
 * Wraps a route handler with a session check (defence in depth behind the proxy)
 * and maps domain errors to JSON responses.
 */
export function handler<Args extends unknown[]>(
  fn: (...args: Args) => Promise<Response>,
  options: { public?: boolean } = {},
) {
  return async (...args: Args): Promise<Response> => {
    try {
      if (!options.public && !(await hasSession())) return jsonError(401, "Sign in to continue.");
      return await fn(...args);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
