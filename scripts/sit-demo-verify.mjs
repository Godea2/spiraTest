/**
 * Prove SIT Pass → Spira against a running server:
 * login → load SIT catalog → record one Passed run → undo.
 *
 *   BASE_URL=http://localhost:3004 node scripts/sit-demo-verify.mjs
 */
import { existsSync, readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3004";
const envFile = existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "";
const fromEnvFile = (name) => envFile.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
const password = process.env.APP_PASSWORD ?? fromEnvFile("APP_PASSWORD");

const jar = new Map();

async function call(method, path, body) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(BASE + path, {
    method,
    redirect: "manual",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const [name, ...value] = pair.split("=");
    if (value.join("=")) jar.set(name, value.join("="));
    else jar.delete(name);
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

if (!password) {
  console.error("APP_PASSWORD missing (.env.local or env).");
  process.exit(1);
}

const login = await call("POST", "/api/auth/login", { password });
if (login.status !== 200 || !jar.has("srs_session")) {
  console.error("Login failed", login.status, login.data);
  process.exit(1);
}

const catalogRes = await call("POST", "/api/week/catalog", {
  projectId: 24,
  releaseId: 157,
  releaseLabel: "1.0.0.0002 - Sprint3",
});
if (catalogRes.status !== 200 || !catalogRes.data?.modules?.length) {
  console.error("SIT catalog failed", catalogRes.status, catalogRes.data);
  process.exit(1);
}

const catalog = catalogRes.data;
const preferred =
  catalog.modules.find((m) => /transfer/i.test(m.module)) ||
  catalog.modules.find((m) => /payment/i.test(m.module)) ||
  catalog.modules[0];

const set = preferred.testSets.find((s) => s.cards.some((c) => !c.executed)) || preferred.testSets[0];
const card = set?.cards.find((c) => !c.executed) || set?.cards[0];
if (!set || !card) {
  console.error(`No cards in ${preferred.module}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      releaseLabel: catalog.releaseLabel,
      folderName: catalog.folderName,
      source: catalog.source,
      modules: catalog.modules.length,
      caseCount: catalog.caseCount,
      demo: { module: preferred.module, testSet: set.testSetName, tc: card.testCaseId, wasExecuted: card.executed },
    },
    null,
    2,
  ),
);

const record = await call("POST", "/api/execution/record", {
  context: { projectId: catalog.projectId, releaseId: catalog.releaseId, module: preferred.module },
  testSets: preferred.testSets,
  decisions: {},
  draftName: `${preferred.module} · ${catalog.releaseLabel}`,
  tester: "SIT demo verify",
  batch: {
    testSetId: set.testSetId,
    cases: [
      {
        testCaseId: card.testCaseId,
        testSetTestCaseId: card.testSetTestCaseId,
        status: "passed",
        comment: "SIT Cycle 2 demo verify — undo next",
        steps: [],
      },
    ],
  },
});

const results = record.data?.results ?? [];
const recorded = results.filter((r) => r.result === "recorded" && r.testRunId);
console.log(JSON.stringify({ status: record.status, results }, null, 2));

if (record.status !== 200 || recorded.length === 0) {
  process.exit(1);
}

const undo = await call("POST", "/api/workflow/undo-sign-off", {
  context: { projectId: catalog.projectId, releaseId: catalog.releaseId, module: preferred.module },
  runs: recorded.map((r) => ({ testRunId: r.testRunId, testCaseId: r.testCaseId })),
});
console.log(JSON.stringify({ undo: undo.data }, null, 2));

const ok = undo.status === 200 && (undo.data?.results ?? []).every((r) => r.ok);
if (!ok) process.exit(1);
console.log("SIT Pass → Spira verified (recorded and undone).");
