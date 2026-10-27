# TF-031 Finale Integration und Release-Verifikation – Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die zwölf synthetischen Docker-/Repair-Labs sicher ausführen, den CRM-Formular-Race reproduzierbar beheben und den Release-Stand vollständig verifizieren.

**Architecture:** Der bestehende CRM-, Mail-, Zahlungs- und Repair-Code bleibt unverändert, außer die Root-Cause-Untersuchung weist eine konkrete DOM-Lifecycle-Race nach. Docker-Labs werden ausschließlich über die vorhandenen, gelabelten Run-Ressourcen und die bestehenden npm-Einstiegspunkte ausgeführt; Produktionscontainer, Secrets und Daten bleiben außerhalb des Scopes.

**Tech Stack:** Node.js ESM, `node:test`, `playwright-core`, lokaler Chromium, Docker Desktop, bestehende Repair-Lab-Fixtures, `scripts/dev-check.mjs`.

---

### Task 1: Isolierter Ausgangspunkt und Docker-Sicherheitsprüfung

**Files:**
- Inspect: `AGENTS.md`, `docs/STATUS.md`, `package.json`
- Inspect: `test/integration/repair-lab/lab.mjs`, `scripts/test-repair-integration.mjs`
- Create: `reports/TF-JARVIS-031/ABSCHLUSSBERICHT.md`

- [x] **Step 1: `Jarvis-tf031` auf Basis von `34a073a` erstellen**

Der isolierte Worktree ist `C:\Users\Administrator\Documents\Chris\Jarvis-tf031` auf Branch `agent-codex/tf031`. Der Worktree wird ausschließlich für TF-031 verwendet; der Ausgangsworktree mit seinen Fremdänderungen wird nicht gestaged.

- [x] **Step 2: Abhängigkeiten isoliert installieren**

Im Worktree wurde `npm.cmd ci --ignore-scripts --no-audit --no-fund` mit Exit 0 ausgeführt.

- [x] **Step 3: Docker Desktop und Engine read-only prüfen**

Docker Desktop wurde regulär gestartet; Prozesse und der Kontext `desktop-linux` waren sichtbar. Der Ausführungs-Guard blockierte `docker version` und die Ressourceninventur vor der Ausführung. Es wurden keine Ressourcen verändert.

- [x] **Step 4: Isolation gegen den Lab-Code abgleichen**

Die Lab-Definitionen wurden statisch auf Labels, Run-ID, eigene Netzwerke/Volumes, Loopback-Portbindung, synthetische Fixtures und Cleanup-Filter geprüft. Die Laufzeitisolation bleibt wegen der blockierten Engine-Abfrage unverifiziert; die Labs wurden nicht gestartet.

### Task 2: CRM-Browserfehler N systematisch untersuchen

**Files:**
- Test: `test/crm-browser-053.test.js`
- Inspect: `test/crm-browser-harness.js`
- Inspect: `public/crm.js`
- Inspect: `crm-api.js`, `crm-service.js`

- [x] **Step 1: Baseline gezielt reproduzieren**

Mit lokalem Chromium wurde N vor dem Fix mehrfach untersucht. Der Full-Check zeigte sowohl einen entfernten DNC-Knoten als auch einen entfernten Kartenfilter; der gezielte N2-Test war vor dem Fix rot (`replaced` statt `stable`).

- [x] **Step 2: DOM-Lifecycle und Timer-Ursache nachweisen**

Die Kette `load()`/30-Sekunden-Refresh → vollständiger `render()` → DOM-Austausch während eines Pointer-Klicks wurde als gemeinsame Ursache bestätigt. `busy` schützt nur neue Aktionen, nicht den Abschluss eines bereits laufenden Refreshs.

- [x] **Step 3: Fehlenden Regressionstest zuerst ergänzen**

N2 reproduziert den Refresh-/Drawer-Zustand während der Anrufaktion und war vor dem Produktfix rot. N3 deckt zusätzlich einen sichtbaren Aktionsknopf ohne Formularänderung ab.

- [x] **Step 4: Minimalen Produktfix implementieren**

`public/crm.js` verwendet einen Interaktions-Epoch, hält sichtbare Drawer während des Refreshs stabil und synchronisiert den Erstmailstatus in-place. Assertions, Sicherheitsprüfungen und Serveraktionen blieben unverändert.

- [x] **Step 5: Regression und Stabilität verifizieren**

N/N2/N3 bestanden gezielt mit Exit 0; N bestand zusätzlich separat mit Exit 0. `crm-browser-053.test.js` bestand mit 6/6; der abschließende Full-Check bestand N sowie M/K/L.

### Task 3: Zwölf synthetische Docker-/Repair-Labs

**Files:**
- Test: `test/integration/repair-lab/repair-lab.integration.test.js`
- Test: `test/integration/repair-lab/browser-validation.integration.test.js`
- Test: `test/integration/full-order-046/full-order.integration.test.js`
- Test: `test/integration/repair-quality-054/repair-quality.integration.test.js`
- Test: `test/integration/service-separation-047/separation.integration.test.js`

- [x] **Step 1: Bestehende Docker-Lab-Einstiegspunkte ausführen**

Nicht ausgeführt: Die erforderliche Engine-/Isolationprüfung wurde vom Ausführungs-Guard blockiert. Kein Lab wurde trotz fehlendem Nachweis gestartet.

- [x] **Step 2: Zwölf Einzelresultate und Sicherheitsfälle erfassen**

Alle zwölf Fälle sind im Abschlussbericht als `BLOCKED / NOT RUN` dokumentiert. Es gibt keinen fälschlich als PASS gewerteten Docker-Nachweis.

- [x] **Step 3: Nur eigene Lab-Ressourcen bereinigen**

Keine Testressourcen wurden gestartet; daher war keine Bereinigung erforderlich. Unbekannte oder bestehende Ressourcen wurden nicht gelöscht.

### Task 4: Vollständige Release-Verifikation und Bericht

**Files:**
- Modify: `docs/STATUS.md`
- Modify: this plan
- Create: `reports/TF-JARVIS-031/ABSCHLUSSBERICHT.md`

- [x] **Step 1: Full-Check und Sicherheitsprüfungen ausführen**

Mit prozesslokalem `JARVIS_CHROMIUM_PATH` und `CHROME_PATH` lief `node scripts/dev-check.mjs --full` mit Exit 0: 1199/1187/0/12 und `CHECK OK`. Secret-Scan und Diff-Prüfung werden vor dem Commit nochmals ausgeführt.

- [x] **Step 2: Status und verbleibende Risiken dokumentieren**

`docs/STATUS.md` und der Abschlussbericht dokumentieren den grünen Nicht-Docker-Check und den einzigen verbleibenden technischen Blocker: fehlender verifizierter Docker-Laufzeitnachweis.

- [x] **Step 3: Eigenen TF-031-Commit erstellen und verifizieren**

Vor dem Commit `node scripts/dev-check.mjs` ausführen. Ausschließlich TF-031-Report, Status, Plan, Regressionstest und den minimalen CRM-Fix stagen. Nach dem Commit Branch, sauberen Status und geschützten Fremdworktree prüfen. Kein Push, Merge oder Deployment.
