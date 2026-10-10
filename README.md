# Spira Test Set Reconciler

Compare a release-scope workbook with Spira test set membership, decide which cases stay, and remove the rest from their test sets. The browser only talks to this app; the app's server calls the Spira REST API (v7.0) with credentials held in its environment.

Built with Next.js (App Router), TypeScript, React and Tailwind CSS.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the values:

   | Name | Purpose |
   | --- | --- |
   | `APP_PASSWORD` | Team password for the sign-in page |
   | `SESSION_SECRET` | At least 16 characters; signs the session cookie and comparisons |
   | `SPIRA_BASE_URL` | Spira site URL, e.g. `https://yourcompany.spiraservice.net` |
   | `SPIRA_USERNAME` | Spira user the server acts as |
   | `SPIRA_API_KEY` | That user's API key (RSS token), including the `{ }` braces |

   Sign-in is disabled until `APP_PASSWORD` and `SESSION_SECRET` are set. Comparisons are disabled until all three Spira values are set; **Settings → Test connection** checks them with read-only calls.

3. `npm run dev` and open http://localhost:3004.

Use a dedicated Spira service account with access to the project and permission to edit its test sets. The API key is sent as a request header, never in the URL, and is never returned to the browser.

## How it works with Spira

| Step | Spira calls |
| --- | --- |
| Compare | `GET projects/{p}/test-sets/{t}`, `…/test-case-mapping` and `…/test-cases` (read only) |
| Membership check | `GET …/test-case-mapping` |
| Dry run | `GET …/test-case-mapping`; nothing is changed |
| Live apply | `GET …/test-case-mapping`, then `DELETE projects/{p}/test-sets/{t}/test-cases/{test_set_test_case_id}` per case |
| Verify | `GET …/test-case-mapping` |

Live apply removes a test case from a test set; the test case itself is never deleted. Before each batch the server re-reads the test set and only removes memberships that still point at the reviewed test case. Reads are retried on temporary errors; removals are never retried automatically, so a failed case is retried only when you choose to.

### Matching rules

For each test case in a test set:

1. If a workbook **TC ID** (for example `TC-ONB-001`) appears in the test case name or in one of its custom property values, it matches that row. Separators and case are ignored, so `TC ONB 001` matches too, but `TC-ONB-0010` does not.
2. Otherwise, if the test case name equals a workbook **Test Scenario** (ignoring case and punctuation), it matches that row.
3. A match on the In-Scope sheet suggests **In Scope**; on the Needs Confirmation sheet, or on several different rows, **Needs Review**.
4. No match suggests **Out of Scope**, unless the name closely resembles a scenario, in which case it goes to **Needs Review** for a person to check.

Workbook rows that no test case matched are listed as missing from Spira.

## Storage

There is no database. Settings, drafts and the activity log are kept in the browser's `localStorage`, so each browser (and each domain, including Vercel preview URLs) has its own drafts.

The server is stateless. It signs every comparison and passing membership check with `SESSION_SECRET` and re-verifies those signatures before a membership check, apply or verify, so suggestions edited in the browser are rejected. The membership check also covers the reviewed decisions, so changing a decision requires a new check.

## Deploying to Vercel

Set `APP_PASSWORD`, `SESSION_SECRET`, `SPIRA_BASE_URL`, `SPIRA_USERNAME` and `SPIRA_API_KEY` under **Settings → Environment Variables** (`.env.local` is not deployed), then redeploy. If your Spira instance restricts access by IP address, it must allow Vercel's outbound traffic.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run check` | Typecheck, lint and unit tests (Spira is replaced by an in-memory fake; nothing real is called) |
| `npm run smoke` | HTTP checks against a running server; sends nothing that could change Spira |
