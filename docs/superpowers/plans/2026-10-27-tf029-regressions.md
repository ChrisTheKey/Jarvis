# TF-029 Regressionen und Release-Tests – Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die 13 reproduzierten TF-028-Folgefehler korrekt klassifizieren, veraltete Testverträge auf die freigegebene TF-028-Fachlichkeit aktualisieren und die vollständige lokale Suite ohne Sicherheitslockerung verifizieren.

**Architecture:** Die Produktionslogik bleibt unverändert, sofern die Analyse keinen echten Fehler nachweist. Die alten Tests werden nur an den nach TF-028 geänderten Gates angepasst: vollständige Quittung vor CHF-150-Versand, vollständige verifizierte Reparatur vor CHF-480-Abschlussmail und serverseitige Upgrade-Bindung. Docker-Labs werden ausschließlich mit der vorhandenen isolierten Lab-Umgebung und ohne produktive Volumes geprüft.

**Tech Stack:** Node.js ESM, `node:test`, bestehende synthetische Fixtures, `scripts/run-unit-tests.mjs`, `scripts/dev-check.mjs`, Docker-Lab-Gates.

---

### Task 1: Baseline und Fehlerklassifikation

**Files:**
- Inspect: `test/full-order-046.test.js`
- Inspect: `test/onboarding-066.test.js`
- Inspect: `test/repair-manual-055.test.js`
- Inspect: `test/repair-no-package-062.test.js`
- Inspect: `test/tf088.test.js`
- Inspect: `check-150-workflow.js`, `repair-workflow.js`, `completion-artifacts.js`

- [x] **Step 1: Reproduce the five affected files with the process-local Chromium path**

Run:
```powershell
$env:JARVIS_CHROMIUM_PATH='C:\Users\Administrator\AppData\Local\ms-playwright\chromium-1248\chrome-win64\chrome.exe'
node scripts/run-unit-tests.mjs --test-concurrency=1 test/full-order-046.test.js test/onboarding-066.test.js test/repair-manual-055.test.js test/repair-no-package-062.test.js test/tf088.test.js
```

Expected baseline: 56 tests, 43 pass, 13 fail; the failures are the 13 known assertions, not missing Chromium.

- [x] **Step 2: Trace each failure to the current gate**

Verify the observed values at the assertion boundary:

- manual repair points leave the order `READY_FOR_DELIVERY` and block the new CHF-480 completion mail;
- `buildRepairDeliveryMail` rejects incomplete synthetic orders under the new completion artifact contract;
- CHF-150 delivery remains `MANUAL_REVIEW_REQUIRED` without a complete receipt/business address/upgrade artifact;
- onboarding §59 has no complete TF-028 receipt gate;
- `tf088` uses the pre-TF-028 direct-delivery fixture and does not provide the new completion prerequisites;
- the readiness assertion is environmental when `JARVIS_CHROMIUM_PATH` is absent.

- [x] **Step 3: Record a single hypothesis per failure group before editing**

Classify each as either `TF028_CONTRACT_CHANGED`, `ENVIRONMENT_ONLY`, or `PRODUCT_DEFECT`. Do not change production code while any group remains unclassified.

### Task 2: Update obsolete test contracts only

**Files:**
- Modify: `test/full-order-046.test.js`
- Modify: `test/onboarding-066.test.js`
- Modify: `test/repair-manual-055.test.js`
- Modify: `test/repair-no-package-062.test.js`
- Modify: `test/tf088.test.js`
- Test: the five files above

- [x] **Step 1: Write assertions for the TF-028 behavior before changing fixtures**

The updated assertions must prove that unresolved/manual findings do not produce a CHF-480 completion mail, that incomplete CHF-150 receipts remain blocked, and that the old idempotency/security checks remain active.

- [x] **Step 2: Run the affected tests and confirm the new assertions fail for the expected old-contract reason**

Run the same five-file command from Task 1 and verify failures identify only the assertion/fixture mismatch, not a syntax or import error.

- [x] **Step 3: Make the smallest test-only migration**

For each changed expectation, preserve the original safety assertion and update only the expected state/body/queue count to the TF-028 gate. Where a positive CHF-150 delivery test is still intended, supply a synthetic business profile and an injected synthetic upgrade-checkout result instead of a live Stripe call.

- [x] **Step 4: Run each affected file separately**

Run:
```powershell
$env:JARVIS_CHROMIUM_PATH='C:\Users\Administrator\AppData\Local\ms-playwright\chromium-1248\chrome-win64\chrome.exe'
node scripts/run-unit-tests.mjs --test-concurrency=1 test/full-order-046.test.js
node scripts/run-unit-tests.mjs --test-concurrency=1 test/onboarding-066.test.js
node scripts/run-unit-tests.mjs --test-concurrency=1 test/repair-manual-055.test.js
node scripts/run-unit-tests.mjs --test-concurrency=1 test/repair-no-package-062.test.js
node scripts/run-unit-tests.mjs --test-concurrency=1 test/tf088.test.js
```

Expected result: 0 failures in each file, with no disabled or weakened test.

### Task 3: Verify TF-028 and security regressions

**Files:**
- Test: `test/tf028-completion-upgrade.test.js`
- Test: `test/service-separation-047.test.js`
- Test: `test/always-online-021.test.js`
- Test: `test/payments-041.test.js`
- Test: `test/tf081-stripe-checkout.test.js`
- Test: `test/repair-480-035.test.js`
- Test: `test/crm-detail-059.test.js`
- Test: `test/lead-crm-053.test.js`

- [x] **Step 1: Run all targeted TF-028 and security regression files**

Confirm the 16 TF-028 tests still pass, including receipt/manual-review, webhook idempotency, mode separation, access gates and no duplicate completion mail.

- [x] **Step 2: Run the full local suite with Chromium configured process-locally**

Run:
```powershell
$env:JARVIS_CHROMIUM_PATH='C:\Users\Administrator\AppData\Local\ms-playwright\chromium-1248\chrome-win64\chrome.exe'
node scripts/dev-check.mjs --full
```

Expected result: 0 failed tests. Any remaining failure is investigated before completion; no timeout or skip is added to hide it.

### Task 4: Docker-/Repair-Lab gate

**Files:**
- Inspect: `package.json`
- Inspect: `test/integration/`
- Inspect: `deploy/vps/`
- Modify only if required: `reports/TF-JARVIS-029/` documentation

- [x] **Step 1: Inspect the twelve skip conditions and Docker isolation guard**

Identify the exact `JARVIS_REPAIR_LAB` prerequisite, Docker engine availability, compose project names, volume declarations and synthetic-mail configuration. Do not read secrets or use production compose files/volumes.

- [x] **Step 2: Isolation nicht nachweisbar; Labs sicherheitshalber nicht gestartet und als BLOCKED dokumentiert**

Use the repository-provided release/lab commands with synthetic data only. If Docker, the lab fixture, or isolation cannot be proven, do not start the labs and document `BLOCKED` with the missing prerequisite.

- [x] **Step 3: Keine Docker-Kommandos ausgeführt; damit keine produktiven Container oder Volumes verändert**

Use read-only local checks limited to the isolated lab project; do not run VPS SSH, deployment scripts, or broad `docker compose` commands.

### Task 5: Report, status and commit

**Files:**
- Create: `reports/TF-JARVIS-029/ABSCHLUSSBERICHT.md`
- Modify: `docs/STATUS.md`

- [x] **Step 1: Write the report with exact counts and exit codes**

Document every original failure, classification, changed test, full-suite result, Docker-lab result, security risks and the next release step. Distinguish `PASS`, `FAIL` and `BLOCKED` explicitly.

- [x] **Step 2: Run final checks before commit**

Run:
```powershell
node scripts/dev-check.mjs
git diff --check
```

- [ ] **Step 3: Commit only TF-029 files**

Stage the report, status update and test-only corrections (plus production code only if a separately proven product defect required it). Commit with:
```powershell
git commit -m "test(tf029): align regression gates with tf028"
```

- [ ] **Step 4: Verify clean isolated branch**

Run `git status --short --branch` and record the commit ID. Do not push, merge, deploy or modify the original worktrees.
