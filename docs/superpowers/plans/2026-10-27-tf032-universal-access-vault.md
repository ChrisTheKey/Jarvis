# TF-032 Universeller Zugangsdaten-Tresor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Den sicheren CHF-480-Zugangstresor für bekannte und unbekannte Anbieter öffnen, ohne unbekannte Systeme automatisch zu reparieren.

**Architecture:** Eine deklarative Provider-Registry liefert ausschliesslich whitelisted Profile und sichere Formulardefinitionen. Die vorhandene Erkennung liefert nur Vorschläge; der Repair-Workflow startet ausschliesslich bei registriertem Adapter nach den bestehenden Zahlungs-, Autorisierungs-, Zugangs-, Backup- und Rollback-Gates.

**Tech Stack:** Node.js ESM, bestehendes RSA-OAEP/AES-GCM-Envelope, Netlify Access-Intake API, statisches Browserformular, Node Test Runner.

---

### Task 1: Provider-Registry und sichere Normalisierung

**Files:**
- Create: `access-provider-registry.js`
- Test: `test/tf032-universal-access-vault.test.js`

- [x] **Step 1: Write the failing test**

```js
assert.equal(resolveProviderProfile({ providerId: "SHOPIFY" }).id, "SHOPIFY");
assert.equal(resolveProviderProfile({ providerName: "Neuer Anbieter" }).id, "CUSTOM");
assert.equal(profileCanAutoRepair({ id: "CUSTOM" }, { static: {} }), false);
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 test/tf032-universal-access-vault.test.js`
Expected: FAIL, because `access-provider-registry.js` does not exist.

- [x] **Step 3: Write minimal implementation**

```js
export const resolveProviderProfile = ({ providerId, providerName } = {}) =>
  PROVIDER_REGISTRY[providerId] || { ...PROVIDER_REGISTRY.CUSTOM, provider_name: cleanProviderName(providerName) };
export const profileCanAutoRepair = (profile, adapters) =>
  profile.automation === "adapter" && typeof adapters?.[profile.adapter_key] === "object";
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 test/tf032-universal-access-vault.test.js`
Expected: PASS.

### Task 2: API and vault contract

**Files:**
- Modify: `access-intake-api.js`
- Modify: `access-intake.js`
- Test: `test/tf032-universal-access-vault.test.js`

- [x] **Step 1: Write the failing test**

```js
assert.deepEqual(info.provider_profile.id, "CUSTOM");
assert.equal((await submitCustom()).status, 200);
assert.equal(JSON.stringify(publicMetadata).includes("temporary-secret"), false);
assert.equal((await submitWrongDomain()).status, 400);
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 test/tf032-universal-access-vault.test.js`
Expected: FAIL, because Registry profile and customer selection are not yet persisted.

- [x] **Step 3: Write minimal implementation**

```js
const profile = resolveProviderProfile(body.provider || {});
if (!profile.access_types.includes(body.access_type)) return reply(400, { error: "Zugangsart passt nicht zum Anbieterprofil." });
// provider_meta contains only non-secret metadata; envelope stays encrypted.
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 test/tf032-universal-access-vault.test.js`
Expected: PASS.

### Task 3: Dynamic, server-defined customer form

**Files:**
- Modify: `public/access.html`
- Modify: `public/access.js`
- Test: `test/tf032-universal-access-vault.test.js`

- [x] **Step 1: Write the failing test**

```js
assert.match(accessScript, /provider_profile/);
assert.match(accessHtml, /providerName/);
assert.doesNotMatch(accessScript, /innerHTML\s*=\s*info\.provider/);
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 test/tf032-universal-access-vault.test.js`
Expected: FAIL, because the form has no provider selection.

- [x] **Step 3: Write minimal implementation**

```js
applyProviderProfile(info.provider_profile);
providerSelect.addEventListener("change", () => applyProviderProfile(info.provider_profiles[$("provider").value]));
// CUSTOM reveals provider name and only server-approved access types.
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 test/tf032-universal-access-vault.test.js`
Expected: PASS.

### Task 4: Fail-closed repair decision

**Files:**
- Modify: `repair-workflow.js`
- Test: `test/tf032-universal-access-vault.test.js`
- Test: `test/tf071.test.js`

- [x] **Step 1: Write the failing test**

```js
assert.equal(await runWithProfile("CUSTOM"), "MANUAL_REVIEW_REQUIRED");
assert.equal(await runWithMissingAdapter("WORDPRESS"), "MANUAL_REVIEW_REQUIRED");
assert.equal(await runWithAdapterAndAllGates(), "BACKUP");
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 test/tf032-universal-access-vault.test.js`
Expected: FAIL, because Registry ability is not yet part of the adapter gate.

- [x] **Step 3: Write minimal implementation**

```js
if (!profileCanAutoRepair(profile, adapters)) {
  manual(order, "Anbieter oder Reparaturadapter nicht automatisch unterstützt – sichere manuelle Prüfung erforderlich.");
  return false;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 test/tf032-universal-access-vault.test.js test/tf071.test.js`
Expected: PASS.

### Task 5: Documentation, verification and commit

**Files:**
- Modify: `docs/STATUS.md`
- Create: `reports/TF-JARVIS-032/UNIVERSAL_ACCESS_VAULT_ABSCHLUSSBERICHT.md`

- [x] **Step 1: Write report with Registry/adapter overview**

```markdown
| Profilgruppe | Tresor | Automatische Reparatur |
|---|---|---|
| CUSTOM/unbekannt | Ja | Nein, MANUAL_REVIEW_REQUIRED |
```

- [x] **Step 2: Run targeted regressions and full suite** (107/107 gezielte Regressionen; Vollsuite 1'199/1'199 bestanden, 12 Docker-Labs übersprungen)

Run: `node scripts/dev-check.mjs --full`
Expected: 0 failed tests; Docker labs only with proven isolation.

- [x] **Step 3: Run security and Git checks** (Secret-Scan 0 Treffer; finaler Full-Check Exit 0; Diff-Prüfung vor Commit)

Run: `node scripts/dev-check.mjs && git diff --check`
Expected: syntax, secret scan and diff check pass.

- [x] **Step 4: Commit only owned files** (lokaler Commit, kein Push/Merge/Deployment)

```bash
git add access-provider-registry.js access-intake-api.js access-intake.js public/access.html public/access.js repair-workflow.js test/tf032-universal-access-vault.test.js docs/STATUS.md reports/TF-JARVIS-032/UNIVERSAL_ACCESS_VAULT_ABSCHLUSSBERICHT.md
git commit -m "feat(tf032): support universal access vault"
```
