# JARVIS Seller Button and Full E2E Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the existing synthetic CH sales-intake path with two visible, package-specific seller actions, deploy only the required frontend/backend changes, and verify both actions through the registered Playwright MCP and existing TEST-only payment/mail/repair workflow.

**Architecture:** Reuse `public/crm.js` and `mail-requests.js` as the existing browser/API path. Add an explicit offer selector to the existing `sales_intake_send` operation, make order references and payment links package-specific, and retain actor, CH, synthetic-lead, sender-authority, outbox, and idempotency gates. Netlify continues to serve `public/` and functions; no new service or browser-side mail sender is introduced.

**Tech Stack:** Node.js ESM, Netlify Functions/Blobs, existing JARVIS mail outbox/worker, Stripe TEST payment links, Playwright MCP.

---

## Task 1: Establish the change boundary and rollback evidence

**Files:** `docs/STATUS.md`, `reports/TF-JARVIS-SELLER-BUTTON-FULL-E2E.md`, `reports/` evidence directory.

- [ ] Re-read the current status and relevant sales/mail/Stripe implementation files.
- [ ] Record current HEAD, worktree status, live frontend evidence, and existing uncommitted files without overwriting them.
- [ ] Create a local source rollback artifact containing only the files that will change, excluding secrets and customer data.
- [ ] Confirm the authorized Netlify/test-site rollback path before any website or JARVIS deployment mutation.

## Task 2: Add failing package-specific regression coverage

**Files:** `test/tf024-direct-sales-mail.test.js` or a focused new `test/tf034-seller-button.test.js`, `public/crm.js` source assertions.

- [ ] Add tests that submit `sales_intake_send` with `offer: "CHF150"` and `offer: "CHF480"` and assert one selected offer, its matching order reference, its matching payment link, and no cross-offer link in the sent message.
- [ ] Add tests for separate idempotency keys per lead/day/offer, duplicate-click suppression, unsupported-offer rejection, non-CH rejection, non-synthetic rejection, and seller authorization.
- [ ] Add source/UI assertions for two distinct buttons and per-offer status/error display.
- [ ] Run the focused tests and confirm the new assertions fail before implementation.

## Task 3: Implement package-aware backend sales intake

**Files:** `mail-requests.js`, `sales-intake.js`, `netlify/functions/mail-requests.mjs` only if wiring changes are required.

- [ ] Add a strict allowlist mapping `CHF150` to `REPAIR_CHECK_150` / CHF 150 / the existing CHF-150 payment link and `CHF480` to `REPAIR_FIX_500` / CHF 480 / the existing CHF-480 payment link.
- [ ] Make order ID creation/reuse, access token metadata, mail body, and outbox metadata use the selected offer only.
- [ ] Include the selected offer in the idempotency key and preserve duplicate response semantics.
- [ ] Preserve actor permission resolution, CH-only behavior, synthetic TEST-lead gate, sender authority, mail-worker handoff, and truthful queued/provider status distinction.
- [ ] Keep preview/confirm compatibility unless tests demonstrate that a narrowly scoped shared helper change is required.

## Task 4: Implement the two existing-CRM seller actions

**Files:** `public/crm.js`, `public/i18n.js`.

- [ ] Replace the single generic CH sales action with two clearly labeled actions: `CHF 150 – ERST-MAIL SENDEN` and `CHF 480 – ERST-MAIL SENDEN`.
- [ ] Show customer, recipient, package, price, seller, order/status information already available from the CRM response.
- [ ] Send the selected `offer` to the existing endpoint, disable only the selected action during its request, and render requested/queued/sent/failed states without claiming provider delivery prematurely.
- [ ] Preserve seller-scope restrictions, confirmation behavior, and safe error handling.

## Task 5: Run local verification and commit the minimal implementation

**Files:** all changed source/tests/status/report files.

- [ ] Run focused direct-sales tests, relevant auth/scope/outbox/payment tests, syntax checks, and secret scan.
- [ ] Run `node scripts/dev-check.mjs` before committing and inspect all output.
- [ ] Update `docs/STATUS.md` with implementation/test state and commit the minimal change with a TF-034 message.
- [ ] Record the commit hash and changed-file list.

## Task 6: Deploy through the verified existing Netlify path

**Files:** deployment configuration only if an existing documented path requires it.

- [ ] Verify the current deployment architecture, published commit, and available non-secret deployment credentials/path.
- [ ] Deploy only the committed seller-button change; do not modify VPS/Fiverr/other sites.
- [ ] Verify the deployment ID/commit and fetch the live CRM asset through the registered Playwright MCP.
- [ ] Stop and report the exact missing access if a deploy credential or authorized rollback path is unavailable; do not fabricate live proof.

## Task 7: Execute the real Playwright seller-button and E2E evidence chain

**Files:** `reports/TF-JARVIS-SELLER-BUTTON-FULL-E2E.md`, `reports/final-e2e-150-480/`.

- [ ] Reuse or create only synthetic TEST leads addressed to `helvetic.webdesign@proton.me`.
- [ ] Open the live CRM with Playwright MCP, verify both buttons, and click each actual button once while capturing request/response and UI status.
- [ ] Verify mail-worker/outbox/provider evidence for each first mail, with no duplicate send.
- [ ] Follow CHF 150 through the real Stripe TEST checkout, payment webhook, audit/instruction/form, and completion mail. Pause only for required manual test-card input.
- [ ] Follow CHF 480 through full TEST payment, customer authorization, verified backup/access gate, repair worker, quality check, and completion mail. Do not bypass a gate or repair the site manually.
- [ ] If any required manual payment/auth input or permission is missing, stop at that exact gate and mark the affected flow BLOCKED.

## Task 8: Final verification and handoff

**Files:** `reports/TF-JARVIS-SELLER-BUTTON-FULL-E2E.md`, `docs/STATUS.md`, `reports/final-e2e-150-480/`.

- [ ] Recheck the test website desktop/mobile, contact anchor, console/network errors, forms, and visible functionality; restore only through the verified backup path if the authorized repair fails.
- [ ] Record actual versus simulated/local/blocking evidence in the required CHF-150/CHF-480 table.
- [ ] Run final verification commands and inspect fresh output before claiming completion.
- [ ] Report changed files, commit, deployment ID, live UI proof, mail/payment/authorization/repair evidence, screenshots, open issues, and next action without overstating any blocked step.
