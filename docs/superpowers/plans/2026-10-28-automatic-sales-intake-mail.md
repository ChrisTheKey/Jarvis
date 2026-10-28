# Automatic Sales Intake Mail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing CHF 150/CHF 480 CRM buttons complete the authorized synthetic TEST path through permission checks, Outbox, Gmail sender authority, and worker status without adding a second mail system.

**Architecture:** Extend only the OWNER-only manual TEST-Lead fixture with fixed server-side `REQUESTED_CONTACT` evidence for the approved test recipient. Keep `sales_intake_send`, `mail-requests.js`, Gmail OAuth, Outbox, and the worker unchanged except for targeted status/evidence coverage. Verify the live path through Playwright MCP and read-only worker/provider diagnostics.

**Tech Stack:** Node.js ESM, Netlify Functions/Edge Function, Netlify Blobs, existing Gmail worker, Node test runner, Playwright MCP.

---

### Task 1: Establish the synthetic authorization contract

**Files:**
- Modify: `lead-crm.js:80-99,381-450,560-575`
- Modify: `public/crm.js:638-660`
- Test: `test/netlify-sales-test-lead.test.js`

- [ ] **Step 1: Add a failing test for fixed TEST contact evidence**

  Extend the existing test fixture so the manual TEST lead carries a request with `basis: "requested_contact"`, high confidence, website-repair scope, a past request date, explicit recipient channel `helvetic.webdesign@proton.me`, and evidence identifying this as an authorized synthetic E2E request. Assert that normal non-test leads are unaffected and that arbitrary client-supplied request fields are rejected.

- [ ] **Step 2: Run the targeted test and confirm failure**

  Run `node --test --test-concurrency=1 test/netlify-sales-test-lead.test.js`; expect failure because the current manual lead has no request permission metadata.

- [ ] **Step 3: Implement the minimal server-side fixture**

  Add one constant in `lead-crm.js` containing the fixed test request metadata. Do not accept request fields from `public/crm.js`. Include that constant when `cleanManualParams` builds the validated manual record and when `buildCrmLead` exposes the synthetic TEST lead. Keep `MANUAL_TEST`/`TEST`/`MANUAL_TEST_AUTHORIZED` checks mandatory and preserve domain deduplication.

- [ ] **Step 4: Keep the browser payload unchanged except for explicit UI text**

  The browser continues submitting only the existing manual test fields. Update the note in `public/crm.js` to state that the lead contains a synthetic E2E contact authorization limited to the approved recipient; do not add editable legal-basis fields.

- [ ] **Step 5: Run the targeted tests**

  Run `node --test --test-concurrency=1 test/netlify-sales-test-lead.test.js test/tf024-direct-sales-mail.test.js test/netlify-cloud-bundle.test.js`; expect all tests to pass.

- [ ] **Step 6: Commit the authorization fixture**

  Run `node scripts/dev-check.mjs` through its syntax/secret-scan stage, then commit only the source and test files with `feat(tf034): authorize synthetic sales intake test lead`.

### Task 2: Add sender-authority and worker-status regression coverage

**Files:**
- Test: `test/tf024-direct-sales-mail.test.js`
- Test: `test/mail-064.test.js`
- Read-only verification: `mail-worker.js`, `gmail.js`, `mail-access.js`, `netlify/functions/mail-requests.mjs`

- [ ] **Step 1: Add tests for both offer-specific messages**

  Assert CHF 150 uses the CHF 150 package text/order prefix/payment TEST link and CHF 480 uses the CHF 480 text/order prefix/payment TEST link; assert neither body contains the other offer’s order reference.

- [ ] **Step 2: Add idempotency and status assertions**

  Exercise each offer twice with the same synthetic lead and assert one Outbox request per offer, a duplicate response on the second call, and distinct `pending`/`sent`/`failed` status handling.

- [ ] **Step 3: Add sender metadata assertions without secrets**

  Assert the queued metadata preserves the configured sender-authority path and never logs or returns OAuth tokens. If the current queue contract deliberately omits the alias, assert that the worker—not the browser—owns the sender selection.

- [ ] **Step 4: Run the focused mail suite**

  Run `node --test --test-concurrency=1 test/tf024-direct-sales-mail.test.js test/mail-064.test.js test/ux-mail-020.test.js`; no live mail is sent by these tests.

- [ ] **Step 5: Commit the regression coverage**

  Commit only the test changes with `test(tf034): cover offer-specific sender status and idempotency`.

### Task 3: Verify Gmail OAuth and alias through existing authority

**Files:**
- Read-only: `gmail.js`, `mail-worker.js`, `mail-access.js`, `mail-requests.js`, `netlify/functions/mail-requests.mjs`
- Modify only if a concrete non-secret configuration defect is found.

- [ ] **Step 1: Run local structural diagnostics**

  Confirm the worker uses the existing Gmail OAuth/token store and sender profile path; do not read `.env`, `.secrets`, OAuth JSON, or token values.

- [ ] **Step 2: Query live read-only service state**

  Through the authenticated JARVIS UI/API, record worker heartbeat, sender authority, and alias verification state without exposing account tokens.

- [ ] **Step 3: Stop on missing manual access**

  If Gmail requires interactive OAuth or alias verification, record the exact required user action and do not attempt to create credentials or a replacement sender.

### Task 4: Deploy and run the controlled Playwright MCP proof

**Files:**
- Update: `reports/TF-JARVIS-SELLER-BUTTON-FULL-E2E.md`
- Evidence: `reports/final-e2e-150-480/`

- [ ] **Step 1: Verify local tests and current Git status**

  Preserve the existing uncommitted reports and evidence; verify only intended commits are ready.

- [ ] **Step 2: Push/deploy the source changes through the authorized branch**

  If the environment blocks push, stop and provide the exact PowerShell command. Do not deploy unrelated changes.

- [ ] **Step 3: Verify the live CRM version**

  Open `https://chrisjarvis.netlify.app/#crm` with the registered Playwright MCP, confirm both buttons, and open the synthetic TEST lead.

- [ ] **Step 4: Click CHF 150 once**

  Capture the request/response, Outbox request ID, worker status, sender alias, Gmail provider acceptance, and Proton delivery state. Do not retry after a terminal duplicate or blocked status.

- [ ] **Step 5: Click CHF 480 once**

  Repeat the same evidence chain with the CHF 480 offer. Do not initiate Stripe or repair actions unless the user separately requests the payment/reparation E2E; this plan covers automatic Erst-Mail dispatch only.

- [ ] **Step 6: Finalize evidence**

  Mark each step `PASS`, `FAIL`, or `BLOCKED`; distinguish Gmail acceptance from Proton delivery; document any manual OAuth/alias action required; include screenshots and network evidence.
