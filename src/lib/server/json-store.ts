import "server-only";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export function dataDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR || path.join(process.cwd(), "data"));
}

export function dataPath(...segments: string[]): string {
  return path.join(/*turbopackIgnore: true*/ dataDir(), ...segments);
}

const locks = new Map<string, Promise<unknown>>();

/** Serialises read-modify-write cycles per file within this server process. */
export async function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(file) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  locks.set(file, run);
  try {
    return await run;
  } finally {
    if (locks.get(file) === run) locks.delete(file);
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value), "utf8");
  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

export async function appendLine(file: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${line}\n`, "utf8");
}
