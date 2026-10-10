import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "spira-reconciler-test-"));
  process.env.DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
