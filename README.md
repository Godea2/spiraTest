# Spira Test Set Reconciler

Compare a release-scope workbook with Spira test set membership, decide which cases stay, and remove the rest through n8n. The browser only talks to this app; the server calls n8n with a shared secret, and n8n calls Spira.

Built with Next.js (App Router), TypeScript, React and Tailwind CSS.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the secrets:

   | Name | Purpose |
   | --- | --- |
   | `APP_PASSWORD` | Team password for the sign-in page |
   | `SESSION_SECRET` | At least 16 characters; signs the session cookie |
   | `WEBHOOK_SECRET` | Sent to n8n as the `X-Webhook-Secret` header |
   | `RECONCILE_WEBHOOK_URL` | Fallback Reconcile webhook (optional) |
   | `APPLY_WEBHOOK_URL` | Fallback Apply webhook (optional) |

   Sign-in is disabled until `APP_PASSWORD` and `SESSION_SECRET` are set. n8n calls are refused until `WEBHOOK_SECRET` is set.

3. `npm run dev` and open http://localhost:3004.

Admins can save a Reconcile or Apply URL override in **Settings**; it takes priority over the environment value until "Clear saved override" is used. Saved URLs and the webhook secret are never sent to the browser — Settings only shows where each URL comes from and its host.

Settings, drafts and the activity log are stored as JSON files in `data/` (override with `DATA_DIR`). Mount it on persistent storage in production.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run check` | Typecheck, lint and unit tests |
| `npm run smoke` | End-to-end HTTP checks against a running server; refuses to run apply steps unless Mock mode is on |
| `node scripts/make-sample-workbook.mjs` | Regenerates `tests/fixtures/sample-scope.xlsx` |

## n8n contract

Both webhooks receive `POST` JSON with the `X-Webhook-Secret` header.

**Reconcile** (one call per test set)

```json
{ "projectId": 24, "releaseId": 157, "module": "Onboarding", "testSetId": 125,
  "testSetName": "Onboarding-IOS", "platform": "iOS", "rows": [{ "sheet": "…", "rowNumber": 4, "scope": "inScope", "values": {} }] }
```

Response:

```json
{ "cards": [{ "testCaseId": 3519, "testSetTestCaseId": 12318, "name": "…", "tcId": "TC-001",
              "executionStatus": "Passed", "executed": true, "suggestion": "inScope|outOfScope|needsReview", "reason": "…" }],
  "missingFromSpira": [{ "tcId": "TC-999", "testScenario": "…", "reason": "…" }],
  "membership": [12318, 12319] }
```

Row `scope` is `inScope` or `needsConfirmation`. `suggestion` also accepts `keep`/`in` and `remove`/`out`. `membership` (the current test set test case IDs) is optional; when it is omitted, the IDs from `cards` are used.

**Apply** (up to 25 actions per call, remove only)

```json
{ "projectId": 24, "releaseId": 157, "testSetId": 125, "dryRun": true,
  "actions": [{ "action": "remove", "testSetTestCaseId": 12319, "testCaseId": 3520 }] }
```

Response:

```json
{ "results": [{ "testSetTestCaseId": 12319, "status": "wouldRemove|removed|failed|skipped", "message": "…" }] }
```

Any action missing from `results` is treated as failed. When `dryRun` is true, n8n must not change Spira.
