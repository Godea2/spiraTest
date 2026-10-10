// End-to-end smoke test against a running server. Mock mode only: it refuses to run
// any live step unless the server reports mockMode=true.
//
//   BASE_URL=http://localhost:3004 APP_PASSWORD=... node scripts/smoke.mjs
//
// APP_PASSWORD falls back to the value in .env.local so it never needs to be typed or printed.
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3004";
const password =
  process.env.APP_PASSWORD ??
  readFileSync(".env.local", "utf8").match(/^APP_PASSWORD=(.*)$/m)?.[1]?.trim();

let cookie = "";
let failures = 0;

function check(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${!condition && detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

async function call(method, path, body, headers = {}) {
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
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const data = await res.json().catch(() => null);
  return { status: res.status, data, headers: res.headers };
}

const health = await call("GET", "/api/healthz");
check("healthz returns 200", health.status === 200);

check("settings require a session", (await call("GET", "/api/settings")).status === 401);
const page = await fetch(`${BASE}/settings`, { redirect: "manual" });
check("protected pages redirect to /login", page.status === 307 && page.headers.get("location")?.includes("/login"));

check("wrong password is rejected", (await call("POST", "/api/auth/login", { password: "definitely-wrong" })).status === 401);
const login = await call("POST", "/api/auth/login", { password });
check("correct password signs in", login.status === 200 && cookie.startsWith("srs_session="));

const crossSite = await call("PUT", "/api/settings", {}, { Origin: "https://evil.example.com" });
check("cross-site writes are blocked", crossSite.status === 403);

const settings = (await call("GET", "/api/settings")).data;
check("settings load", settings && settings.projectId > 0);
const raw = JSON.stringify(settings);
check("settings never include full webhook URLs", !/https?:\/\/[^"]*\/webhook/i.test(raw));
check("settings never include the webhook secret value", !raw.includes(readFileSync(".env.local", "utf8").match(/^WEBHOOK_SECRET=(.*)$/m)?.[1] ?? "__none__"));

if (!settings?.mockMode) {
  console.log("\nMock mode is OFF on this server. Stopping before any apply step.");
  process.exit(failures ? 1 : 0);
}

await call("POST", "/api/mock/reset");

const badUrl = await call("PUT", "/api/settings", {
  ...settings,
  endpoints: { reconcile: { url: "http://insecure.example.com/webhook" } },
});
check("insecure webhook URL is rejected with a field error", badUrl.status === 400 && !!badUrl.data?.fieldErrors?.["endpoints.reconcile"]);

const rows = [
  { sheet: "Phase 1 In-Scope", rowNumber: 4, scope: "inScope", values: { "TC ID": "ONB-001", "Test Scenario": "Sign up", Module: "Onboarding" } },
];
const created = await call("POST", "/api/drafts", {
  name: "Smoke test",
  module: "Onboarding",
  source: { fileName: "smoke.xlsx", inScopeSheet: "Phase 1 In-Scope", needsConfirmationSheet: null },
  rows,
  testSetIds: [125],
});
check("draft created", created.status === 201);
const id = created.data.draft.id;

const compared = await call("POST", `/api/drafts/${id}/compare`, { testSetId: 125 });
const set = compared.data?.draft?.testSets?.[0];
check("mock compare returns 211 cards", set?.cards?.length === 211, JSON.stringify(compared.data).slice(0, 200));
const count = (col) => set.cards.filter((c) => c.suggestion === col).length;
check("split is 142 / 64 / 5", count("inScope") === 142 && count("outOfScope") === 64 && count("needsReview") === 5);
check("two rows are missing from Spira", set.missingFromSpira.length === 2);

const out = set.cards.filter((c) => c.suggestion === "outOfScope").map((c) => ({ testCaseId: c.testCaseId, testSetTestCaseId: c.testSetTestCaseId }));
const inScope = set.cards.find((c) => c.suggestion === "inScope");

const tooMany = await call("POST", `/api/drafts/${id}/apply`, { testSetId: 125, dryRun: true, actions: out.slice(0, 26) });
check("batches over 25 are rejected", tooMany.status === 400);
const notOut = await call("POST", `/api/drafts/${id}/apply`, {
  testSetId: 125, dryRun: true, actions: [{ testCaseId: inScope.testCaseId, testSetTestCaseId: inScope.testSetTestCaseId }],
});
check("removing an In Scope card is rejected", notOut.status === 400);

const dry = await call("POST", `/api/drafts/${id}/apply`, { testSetId: 125, dryRun: true, actions: out.slice(0, 25) });
check("dry run reports wouldRemove", dry.status === 200 && dry.data.results.every((r) => r.status === "wouldRemove"));

const blockedLive = await call("POST", `/api/drafts/${id}/apply`, { testSetId: 125, dryRun: false, confirmModule: "ONBOARDING", actions: out.slice(0, 1) });
check("live apply blocked while Needs Review remains", blockedLive.status === 400 && /Needs Review/.test(blockedLive.data?.error));

const decisions = Object.fromEntries(set.cards.filter((c) => c.suggestion === "needsReview").map((c) => [c.key, "inScope"]));
const current = (await call("GET", `/api/drafts/${id}`)).data.draft;
const saved = await call("PUT", `/api/drafts/${id}`, { decisions, history: [], expectedUpdatedAt: current.updatedAt });
check("draft saves decisions", saved.status === 200, JSON.stringify(saved.data).slice(0, 200));
const stale = await call("PUT", `/api/drafts/${id}`, { decisions, expectedUpdatedAt: compared.data.draft.updatedAt });
check("stale save returns 409", stale.status === 409);

const wrongConfirm = await call("POST", `/api/drafts/${id}/apply`, { testSetId: 125, dryRun: false, confirmModule: "Onboarding", actions: out.slice(0, 1) });
check("live apply needs exact uppercase module", wrongConfirm.status === 400);
const noPreflight = await call("POST", `/api/drafts/${id}/apply`, { testSetId: 125, dryRun: false, confirmModule: "ONBOARDING", actions: out.slice(0, 1) });
check("live apply needs a membership check", noPreflight.status === 409);

const pre = await call("POST", `/api/drafts/${id}/preflight`);
check("membership check passes", pre.data?.preflight?.ok === true);

const results = [];
for (let i = 0; i < out.length; i += 25) {
  const r = await call("POST", `/api/drafts/${id}/apply`, { testSetId: 125, dryRun: false, confirmModule: "ONBOARDING", actions: out.slice(i, i + 25) });
  results.push(...(r.data?.results ?? []));
}
const failed = results.filter((r) => r.status === "failed");
check("mock live apply: 63 removed, case 3661 fails once", results.length === 64 && failed.length === 1 && failed[0].testCaseId === 3661);

const firstVerify = await call("POST", `/api/drafts/${id}/verify`);
check("verify marks appliedWithErrors", firstVerify.data?.draft?.status === "appliedWithErrors");

await call("POST", `/api/drafts/${id}/preflight`);
const retry = await call("POST", `/api/drafts/${id}/apply`, {
  testSetId: 125, dryRun: false, confirmModule: "ONBOARDING",
  actions: failed.map(({ testCaseId, testSetTestCaseId }) => ({ testCaseId, testSetTestCaseId })),
});
check("retry sends only the failed case and succeeds", retry.data?.results?.length === 1 && retry.data.results[0].status === "removed");

const finalVerify = await call("POST", `/api/drafts/${id}/verify`);
check("verify marks applied", finalVerify.data?.draft?.status === "applied" && finalVerify.data?.verification?.ok);

const list = await call("GET", "/api/drafts");
const summary = list.data.drafts.find((d) => d.id === id);
check("draft summary persists status and counts", summary?.status === "applied" && summary.counts.total === 211);

const activity = await call("GET", "/api/activity");
check("activity log records the run", activity.data.entries.some((e) => e.type === "verify.applied"));

await call("DELETE", `/api/drafts/${id}`);
await call("POST", "/api/mock/reset");
await call("POST", "/api/auth/logout");

console.log(`\n${failures ? `${failures} check(s) failed` : "All smoke checks passed"}`);
process.exit(failures ? 1 : 0);
