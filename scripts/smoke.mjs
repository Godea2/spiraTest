// End-to-end smoke test against a running server. Mock mode only: every workflow request
// is sent with context.mock=true, so the server never calls n8n or Spira.
//
//   BASE_URL=http://localhost:3004 APP_PASSWORD=... node scripts/smoke.mjs
//
// APP_PASSWORD falls back to the value in .env.local so it never needs to be typed or printed.
import { existsSync, readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3004";
const envFile = existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "";
const password = process.env.APP_PASSWORD ?? envFile.match(/^APP_PASSWORD=(.*)$/m)?.[1]?.trim();
const webhookSecret = envFile.match(/^WEBHOOK_SECRET=(.*)$/m)?.[1]?.trim() || "__none__";

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

const health = await call("GET", "/api/healthz");
check("healthz returns 200", health.status === 200);

check("endpoints require a session", (await call("GET", "/api/endpoints")).status === 401);
check(
  "workflow requires a session",
  (await call("POST", "/api/workflow/reconcile", {})).status === 401,
);
const page = await fetch(`${BASE}/settings`, { redirect: "manual" });
check("protected pages redirect to /login", page.status === 307 && page.headers.get("location")?.includes("/login"));

check("wrong password is rejected", (await call("POST", "/api/auth/login", { password: "definitely-wrong" })).status === 401);
const login = await call("POST", "/api/auth/login", { password });
check("correct password signs in", login.status === 200 && jar.has("srs_session"));

const crossSite = await call("PUT", "/api/endpoints", {}, { Origin: "https://evil.example.com" });
check("cross-site writes are blocked", crossSite.status === 403);

const endpoints = await call("GET", "/api/endpoints");
check("endpoint status loads", endpoints.status === 200 && !!endpoints.data?.endpoints?.reconcile);
const raw = JSON.stringify(endpoints.data);
check("endpoint status never includes full webhook URLs", !/https?:\/\/[^"]*\/webhook/i.test(raw));
check("endpoint status never includes the webhook secret value", !raw.includes(webhookSecret));

const badUrl = await call("PUT", "/api/endpoints", { reconcile: { url: "http://insecure.example.com/webhook" } });
check(
  "insecure webhook URL is rejected with a field error",
  badUrl.status === 400 && !!badUrl.data?.fieldErrors?.["endpoints.reconcile"],
);

const context = { projectId: 24, releaseId: 157, module: "Onboarding", mock: true };
const rows = [
  { sheet: "Phase 1 In-Scope", rowNumber: 4, scope: "inScope", values: { "TC ID": "ONB-001", "Test Scenario": "Sign up", Module: "Onboarding" } },
];
let mockState = { removed: {}, transientFailureUsed: {} };
const removed = {};

const compared = await call("POST", "/api/workflow/reconcile", {
  context,
  testSet: { testSetId: 125, testSetName: "Onboarding-IOS", platform: "iOS" },
  rows,
  mockState,
});
const set = compared.data?.comparison;
check("mock compare returns 211 signed cards", set?.cards?.length === 211 && !!set.seal, JSON.stringify(compared.data).slice(0, 200));
const count = (col) => set.cards.filter((c) => c.suggestion === col).length;
check("split is 142 / 64 / 5", count("inScope") === 142 && count("outOfScope") === 64 && count("needsReview") === 5);
check("two rows are missing from Spira", set.missingFromSpira.length === 2);

const out = set.cards
  .filter((c) => c.suggestion === "outOfScope")
  .map((c) => ({ testCaseId: c.testCaseId, testSetTestCaseId: c.testSetTestCaseId }));
const inScope = set.cards.find((c) => c.suggestion === "inScope");
let decisions = {};
let preflight = null;

const apply = (batch, overrides = {}) =>
  call("POST", "/api/workflow/apply", { context, testSets: [set], decisions, removed, preflight, batch, mockState, ...overrides });
const live = (actions, confirmModule = "ONBOARDING") => ({ testSetId: 125, dryRun: false, confirmModule, actions });

check("batches over 25 are rejected", (await apply({ testSetId: 125, dryRun: true, actions: out.slice(0, 26) })).status === 400);
const notOut = await apply({
  testSetId: 125,
  dryRun: true,
  actions: [{ testCaseId: inScope.testCaseId, testSetTestCaseId: inScope.testSetTestCaseId }],
});
check("removing an In Scope card is rejected", notOut.status === 400);

const tampered = { ...set, cards: set.cards.map((c) => (c.key === inScope.key ? { ...c, suggestion: "outOfScope" } : c)) };
const forged = await apply(
  { testSetId: 125, dryRun: true, actions: [{ testCaseId: inScope.testCaseId, testSetTestCaseId: inScope.testSetTestCaseId }] },
  { testSets: [tampered] },
);
check("an edited comparison is rejected", forged.status === 400 && /could not be verified/.test(forged.data?.error));
const asLive = await apply({ testSetId: 125, dryRun: true, actions: out.slice(0, 1) }, { context: { ...context, mock: false } });
check("a Mock mode comparison cannot be used against real Spira", asLive.status === 400);

const dry = await apply({ testSetId: 125, dryRun: true, actions: out.slice(0, 25) });
check("dry run reports wouldRemove", dry.status === 200 && dry.data.results.every((r) => r.status === "wouldRemove"));

const blockedLive = await apply(live(out.slice(0, 1)));
check("live apply blocked while Needs Review remains", blockedLive.status === 400 && /Needs Review/.test(blockedLive.data?.error));

decisions = Object.fromEntries(set.cards.filter((c) => c.suggestion === "needsReview").map((c) => [c.key, "inScope"]));
check("live apply needs exact uppercase module", (await apply(live(out.slice(0, 1), "Onboarding"))).status === 400);
check("live apply needs a membership check", (await apply(live(out.slice(0, 1)))).status === 409);

const preflightBody = () => ({ context, rows, testSets: [set], decisions, removed, mockState });
const pre = await call("POST", "/api/workflow/preflight", preflightBody());
preflight = pre.data?.preflight;
check("membership check passes and is signed", preflight?.ok === true && !!preflight.seal);

const changed = await apply(live(out.slice(0, 1)), { decisions: { ...decisions, [inScope.key]: "outOfScope" } });
check("membership check is bound to the reviewed decisions", changed.status === 409);

const results = [];
for (let i = 0; i < out.length; i += 25) {
  const r = await apply(live(out.slice(i, i + 25)));
  mockState = r.data?.mockState ?? mockState;
  for (const result of r.data?.results ?? []) {
    results.push(result);
    if (result.status === "removed") (removed["125"] ??= []).push(result.testSetTestCaseId);
  }
}
const failed = results.filter((r) => r.status === "failed");
check(
  "mock live apply: 63 removed, case 3661 fails once",
  results.length === 64 && failed.length === 1 && failed[0].testCaseId === 3661,
);

const verifyBody = () => ({ context, rows, testSets: [set], decisions, mockState });
const firstVerify = await call("POST", "/api/workflow/verify", verifyBody());
check("verify reports the case still present", firstVerify.data?.verification?.ok === false);

const again = await apply(live(out.filter((a) => a.testCaseId !== 3661).slice(0, 1)));
check("succeeded actions are never re-sent", again.data?.results?.[0]?.status === "skipped");

const retry = await apply(live(failed.map(({ testCaseId, testSetTestCaseId }) => ({ testCaseId, testSetTestCaseId }))));
mockState = retry.data?.mockState ?? mockState;
check(
  "retry sends only the failed case and succeeds",
  retry.data?.results?.length === 1 && retry.data.results[0].status === "removed",
);

const finalVerify = await call("POST", "/api/workflow/verify", verifyBody());
check("verify passes after the retry", finalVerify.data?.verification?.ok === true);

await call("POST", "/api/auth/logout");
check("signed out", (await call("GET", "/api/endpoints")).status === 401);

console.log(`\n${failures ? `${failures} check(s) failed` : "All smoke checks passed"}`);
process.exit(failures ? 1 : 0);
