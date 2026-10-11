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
   | `GEMINI_API_KEY` | Optional. Google Gemini API key for the AI review of blocked cases and the defect finder |
   | `GEMINI_MODEL` | Optional. Gemini model for both; defaults to `gemini-3.8-flash` |

   Sign-in is disabled until `APP_PASSWORD` and `SESSION_SECRET` are set. Comparisons are disabled until all three Spira values are set. Nothing is preset: in **Settings**, pick the project (listed from Spira) and save. On **Compare**, choose a module and the project's test sets are read from Spira, with those whose name starts with the module (for example `Onboarding-Android`, `Onboarding-IOS`) ticked. The release is optional and only labels drafts; module-to-test-set mappings in Settings are optional overrides.

3. `npm run dev` and open http://localhost:3004.

Use a dedicated Spira service account with access to the project and permission to edit its test sets. The API key is sent as a request header, never in the URL, and is never returned to the browser.

## How it works with Spira

| Step | Spira calls |
| --- | --- |
| Settings | `GET users` and `GET projects` (connection and project list), `GET projects/{p}/releases/{r}` (release label), `GET projects/{p}/test-sets?…&release_id=` (test set picker, paged) |
| Compare | `GET projects/{p}/test-sets/{t}`, `…/test-case-mapping` and `…/test-cases` (read only) |
| Card details | `GET projects/{p}/test-cases/{tc}` and `…/test-steps`, plus the same for linked test cases (read only, when you open a card) |
| Membership check | `GET …/test-case-mapping` |
| Dry run | `GET …/test-case-mapping`; nothing is changed |
| Live apply | `GET …/test-case-mapping`, then `DELETE projects/{p}/test-sets/{t}/test-cases/{test_set_test_case_id}` per case |
| Verify | `GET …/test-case-mapping` |
| Record results | `GET …/test-sets/{t}` and `…/test-cases` (current status), then `POST projects/{p}/test-runs/record` per Blocked or Passed case |
| Undo sign-off | `GET projects/{p}/test-runs/{id}` and `…/automated` (checks the test case and runner name), then `DELETE projects/{p}/test-runs/{id}` |
| Execution status | `GET …/test-case-mapping` and `…/test-cases` per test set; read only |
| Record execution | Per batch of up to 20 cases: `GET …/test-sets/{t}` and `…/test-cases`, one `POST projects/{p}/test-runs/create` (unsaved runs with Spira's steps) and one `PUT projects/{p}/test-runs` saving them all with the step results. If Spira rejects the batch, each run is saved on its own. `POST …/test-runs/record` when Spira gives a case no steps. Afterwards `GET …/test-cases` (what Spira now shows) and `GET`/`PUT projects/{p}/test-sets` to keep the test set's status, owner and planned date |
| Test set status | `GET projects/{p}/test-sets/{t}`, then `PUT projects/{p}/test-sets` with the status Spira should show (only when you click **Set to In Progress in Spira**) |
| Undo an execution result | `GET projects/{p}/test-runs/{id}` (checks the test case), then `…/manual` (checks the app's signature in a step) or `…/automated` (checks the runner name), then `DELETE projects/{p}/test-runs/{id}` |
| Defect finder search | `GET projects/{p}/test-cases/{tc}` and `…/test-steps` for each likely case (read only); `GET projects/{p}` and `GET project-templates/{t}/incidents/types`, `…/priorities` and `…/severities` for the defect form (read only) |
| Fail cases for a defect | The same calls as Record execution, then `GET projects/{p}/test-runs/{id}/manual` per run (checks the app's signature and finds the Failed step) and one `POST projects/{p}/incidents` linked to those run steps |
| Undo a defect | `GET projects/{p}/incidents/{id}` (checks the app's signature), `DELETE projects/{p}/incidents/{id}`, then the run undo above for each of its runs |

Live apply removes a test case from a test set; the test case itself is never deleted. Before each batch the server re-reads the test set and only removes memberships that still point at the reviewed test case. Reads are retried on temporary errors; removals and recorded results are never retried automatically, so a failed case is retried only when you choose to.

Opening **Review & apply** reads each test set's membership from Spira (read only, also on **Check Spira again** and before every run). Out of Scope cases that are already gone from Spira, for example removed by an earlier run that reported an error, are counted as removed, so the remove figure only counts what is still in Spira. Any other difference (cases added in Spira, or In Scope and Blocked cases removed outside the app) is listed and blocks live apply until the board is recompared.

Once a live apply is verified (Spira matches the reviewed board), the draft moves from **Drafts** to **Completed**. A draft applied with errors stays under Drafts until a retry succeeds. Completed drafts can still be opened, and their board and review work as before.

### Test execution

From **Completed**, **Run execution** lists the draft's In Scope cases with their latest result, read from Spira when the page opens (and on **Check Spira again**), so results recorded by others show up too. Cases are grouped in buckets with counts: the page opens on **To run**, and a case leaves it as soon as it has a result and shows under Passed, Failed, Blocked or Caution (**All** shows everything). Next and previous in the runner follow the list as it was when the case was opened, so cases leaving the bucket do not shift the order.

- **Run** opens a case step by step: its steps come from Spira (steps of linked test cases are listed in place), and each step is marked Passed, Failed, Blocked, Caution or N/A, with the actual result for anything that did not pass. Keys P, F, B, C and N mark the current step; Ctrl+Enter saves and opens the next case. The case result follows from the steps: the first Failed, Blocked or Caution step decides it, so a tester can stop at a failure. Marks are kept in the draft until saved.
- **Run all** goes through every listed case (or **Run N selected**, the ticked ones) in the runner, one after another: **Save & next** moves on, and the last case offers **Save & finish**. It starts at the first case that has no result or is in progress, and the arrows move back and forth within the run.
- **Pass** records a Passed result with every step passed in one click, with an Undo in the notification. Select several cases and pick a result from the **Mark N as** menu (keys P, F, B, C while it is open). Passed records straight away with every step passed; Failed, Blocked or Caution ask for one reason (Ctrl+Enter records), which goes on the first step while the other steps stay Not Run. Cases are sent 20 per request with a live progress bar and a **Stop** between batches; afterwards Spira is read again and the summary says how many it now shows with that result, with **Retry** for any that failed.
- **Report** downloads an Excel execution report: a summary per test set (executed, passed, failed, blocked, caution, not run, pass rate), every In Scope case with its status in Spira and last run, and every run recorded here with a link to it in Spira.
- A result that is not Passed needs the actual result on that step, or a comment.

Saving records a manual test run in Spira against the draft's release (or the test set's release), the same kind of run Spira's own execution screen saves: each step has its status and actual result, and steps not reached stay Not Run. The comment and the tester's name are added to the actual result of the step that decided the result (the last step for a pass). Spira lays out the run's steps itself; the marks are matched to them by test step, and if Spira's steps would give a different result (the test case changed since it was opened), nothing is saved and the case asks to be marked again. A case with no steps in Spira is recorded as an automated run with the report in its details. The server only records In Scope cases of a verified board, and re-reads the test set first, so a case that left the test set or changed is not recorded. A case can be executed again; Spira keeps every run and shows the latest. Runs recorded here are listed on the case and can be undone, which deletes only runs this app recorded.

Spira marks a test set Completed as soon as runs are saved against it, and clears its owner and planned date. After each recording the app reads the test set again and puts it back: In Progress while any In Scope case is still Not Run, Completed once every case has a result (or is N/A), with the owner and planned date it had before. A test set set to Blocked or Deferred in Spira is left alone. When the page finds a test set Spira shows with the wrong status (for example from a recording made before this upkeep), it shows a warning with **Set to In Progress in Spira**. An owner or planned date Spira already cleared cannot be recovered and has to be set again in Spira.

#### Defect finder

With a Gemini key, the **Defect finder** on the execute page turns a defect described in plain words into failed runs and one Spira incident:

1. **Describe it**: name the screen, the action and what happened (Ctrl+Enter searches). The search covers the In Scope cases of the test set picked in the case list, or all of them.
2. **Shortlist**: Gemini reads the case names (and workbook scenarios) and picks up to 30 the defect may break, thinking about the path a case takes as well as its words, and describes the defect: a bug title, the area, the symptom, what should happen and a suggested severity. When the description is too vague it asks one question to add before searching again. Drafts with more than 600 cases are narrowed by wording first.
3. **Check the steps**: the app reads each likely case's steps from Spira, and Gemini checks them against the defect, 8 cases per request: fails, might be affected, or not affected, with the step where the tester meets the defect, a short quote from the case as evidence and a one-sentence reason.
4. **Guard against wrong failures**: the server only lets a case count as failing when the step exists, the quote is found word for word in the case, and the confidence is at least medium; anything else is offered as "might be affected" and is not ticked. Only cases that fail are ticked, and each failing step can be changed.
5. **Fail and log**: after a confirmation, each ticked case gets a manual Failed run: the steps before the failing step are Passed (or left unmarked, as you choose), the failing step is Failed with your description as its actual result plus "Defect: title" and the tester, and the steps after it stay Not Run. A case without steps is failed as a whole with the description. Then one incident is created with the title, type, severity and priority (from the project's own lists, preset from Gemini's suggestion), the detected release, steps to reproduce taken from the first failed case, and the list of failed cases; it is linked to the Failed step of each run, which the server reads back and checks is a run this app recorded for that case. If the description changes after a search, failing is blocked until you search again, so the runs always carry the description the cases were matched to.

**Defects logged here** lists each defect with a link to its incident in Spira. **Log in Spira** retries an incident that could not be created, and **Undo** deletes the incident and the defect's runs (each checked to be this app's), after which the cases show their previous result. Searching changes nothing in Spira; only failing and logging write, and neither is retried automatically. Only case names, workbook scenarios, steps and the defect description are sent to Google, with storage turned off.

### Blocked cases and sign-off

On the board, **Not implemented yet** has one keyword list per test set in the draft (for example `nin, bvn, google` for Onboarding-IOS). Only the **test scenario** is searched: the Spira test case name and the Test Scenario cell of the workbook row it matched. Test steps and test data are deliberately ignored, because a step that enters a BVN does not make a case depend on BVN verification. Keywords match whole words and their plural, ignoring case, so `nin` matches `NIN` and `BVN/NIN` but not `running`.

**Filter** collects the In Scope and Blocked cases whose scenario mentions a keyword of their test set. If `GEMINI_API_KEY` is set, the server asks Gemini whether each case really depends on the missing feature, and gets back a verdict, a confidence and a one-sentence reason. For example, "Verify no sensitive data (BVN, passcode) is logged" is about logging, so it is not blocked. A case that has to go through the missing feature's path to reach what it checks (for example "the Account number step is never shown to new customers, who use BVN/NIN instead") counts as blocked, usually with medium confidence. Without a key, a keyword in the scenario counts as Blocked. Only test case names, workbook scenarios and keywords are sent to Google for this review, with storage turned off; Spira is not called. Cases go in batches of 20, and each request gives up with a clear message after 50 seconds; answers already received are kept, and **Stop** ends a long run early.

**Deep check** (with a Gemini key) asks about the In Scope and Blocked cases whose scenario names none of the keywords, in case the wording describes a missing feature another way. Its suggestions are marked "Deep check" with the features the AI named. A deep-check verdict is redone when the test set's keywords change.

Nothing moves on its own. The review lists the suggested changes: cases to move to Blocked, and cases to move back to In Scope, including Blocked cases whose scenario mentions none of the keywords. Confident suggestions are ticked; low-confidence answers and cases with no keyword are left unticked for you to decide. **Apply** moves the ticked cases in one step, which is in the change history and can be undone. Verdicts are saved in the draft, so filtering again only sends new or changed cases unless you choose **Re-analyse all**. A table shows, for every keyword, how many cases mention it in each column, so a keyword found only in Out of Scope cases shows that the workbook left those cases out.

Click a card (or focus it and press Enter) to open its details: where it sits and why, the not-implemented verdict, the matched workbook row with all its cells (test steps, test data, expected results), and the test case as stored in Spira, with its description, properties and test steps, including steps from linked test cases. Use the arrow keys to move through the column and Esc to close. Ctrl-click or Shift-click selects cards instead. On desktop, the sidebar collapses to icons (button at the top, or Ctrl+B) to give the board more room.

On **Review & apply**, a live apply removes Out of Scope cases, then records an automated test run with status **Blocked** for each Blocked case. Ticking **Also mark In Scope cases as Passed** (off by default, with its own confirmation) records **Passed** runs for In Scope cases too. Runs use the draft's release, or the test set's release when the draft has none. Cases that already have a result in Spira are skipped and listed. The IDs of recorded runs are kept in the draft so **Undo sign-off** can delete exactly those runs.

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

Set `APP_PASSWORD`, `SESSION_SECRET`, `SPIRA_BASE_URL`, `SPIRA_USERNAME` and `SPIRA_API_KEY` (and optionally `GEMINI_API_KEY` and `GEMINI_MODEL`) under **Settings → Environment Variables** (`.env.local` is not deployed), then redeploy. If your Spira instance restricts access by IP address, it must allow Vercel's outbound traffic.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run check` | Typecheck, lint and unit tests (matching, board rules, workbook parsing, settings); none of them call Spira |
| `npm run smoke` | HTTP checks against a running server; sends nothing that could change Spira |
