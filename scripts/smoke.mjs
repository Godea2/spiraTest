// HTTP smoke test against a running server. It never changes Spira: the only workflow
// requests it sends are ones the server must reject before contacting Spira.
//
//   BASE_URL=http://localhost:3004 APP_PASSWORD=... node scripts/smoke.mjs
//
// APP_PASSWORD falls back to the value in .env.local so it never needs to be typed or printed.
import { existsSync, readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3004";
const envFile = existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "";
const fromEnvFile = (name) => envFile.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
const password = process.env.APP_PASSWORD ?? fromEnvFile("APP_PASSWORD");
const apiKey = fromEnvFile("SPIRA_API_KEY") || "__none__";

const jar = new Map();
let failures = 0;

function check(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${!condition && detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

async function call(method, path, body, headers = {}) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(BASE + path, {
    method,
    redirect: "manual",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const [name, ...value] = pair.split("=");
    if (value.join("=")) jar.set(name, value.join("="));
    else jar.delete(name);
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

check("healthz returns 200", (await call("GET", "/api/healthz")).status === 200);
check("Spira status requires a session", (await call("GET", "/api/spira")).status === 401);
check("workflow requires a session", (await call("POST", "/api/workflow/apply", {})).status === 401);
const page = await fetch(`${BASE}/settings`, { redirect: "manual" });
check("protected pages redirect to /login", page.status === 307 && page.headers.get("location")?.includes("/login"));

check("wrong password is rejected", (await call("POST", "/api/auth/login", { password: "definitely-wrong" })).status === 401);
const login = await call("POST", "/api/auth/login", { password });
check("correct password signs in", login.status === 200 && jar.has("srs_session"));

const crossSite = await call("POST", "/api/workflow/apply", {}, { Origin: "https://evil.example.com" });
check("cross-site writes are blocked", crossSite.status === 403);

const status = await call("GET", "/api/spira");
check("Spira status loads", status.status === 200 && typeof status.data?.configured === "boolean");
check("Spira status never includes the API key", !JSON.stringify(status.data).includes(apiKey));
console.log(`      Spira is ${status.data?.configured ? `configured (${status.data.host})` : "not configured on this server"}.`);

const context = { projectId: 24, releaseId: 157, module: "Onboarding" };
const card = (n) => ({
  key: `125:${12318 + n}`,
  testSetId: 125,
  testCaseId: 3519 + n,
  testSetTestCaseId: 12318 + n,
  name: `Case ${n}`,
  tcId: null,
  executionStatus: "Not Run",
  executed: false,
  suggestion: "outOfScope",
  reason: "",
});
const forged = {
  testSetId: 125,
  testSetName: "Onboarding-IOS",
  platform: "iOS",
  comparedAt: new Date().toISOString(),
  cards: Array.from({ length: 30 }, (_, n) => card(n)),
  missingFromSpira: [],
  baselineMembership: Array.from({ length: 30 }, (_, n) => 12318 + n),
  seal: "forged",
};
const actions = forged.cards.map((c) => ({ testCaseId: c.testCaseId, testSetTestCaseId: c.testSetTestCaseId }));
const apply = (batch) =>
  call("POST", "/api/workflow/apply", { context, testSets: [forged], decisions: {}, removed: {}, preflight: null, batch });

const tooMany = await apply({ testSetId: 125, dryRun: true, actions: actions.slice(0, 26) });
check("batches over 25 are rejected", tooMany.status === 400 && /at most 25/.test(tooMany.data?.error));
const unsigned = await apply({ testSetId: 125, dryRun: false, confirmModule: "ONBOARDING", actions: actions.slice(0, 1) });
check("an unsigned comparison is rejected before Spira is contacted", unsigned.status === 400 && /could not be verified/.test(unsigned.data?.error));
const preflight = await call("POST", "/api/workflow/preflight", { context, testSets: [forged], decisions: {}, removed: {} });
check("a membership check needs a signed comparison", preflight.status === 400);

await call("POST", "/api/auth/logout");
check("signed out", (await call("GET", "/api/spira")).status === 401);

console.log(`\n${failures ? `${failures} check(s) failed` : "All smoke checks passed"}`);
process.exit(failures ? 1 : 0);
