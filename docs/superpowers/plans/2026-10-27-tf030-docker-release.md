# TF-030 Docker-Integration und Release-Verifikation – Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die zwölf bisher übersprungenen Repair-/Docker-Labs nur bei nachweisbarer lokaler Isolation ausführen und den Release-Status mit belastbaren Testergebnissen dokumentieren.

**Architecture:** Die Produktionslogik bleibt unverändert, sofern kein reproduzierter Produktfehler nachgewiesen wird. Die Lab-Suite wird ausschließlich über die bestehenden `scripts/test-repair-integration.mjs`-Pfade mit synthetischen Fixtures ausgeführt; die Ressourcen sind per `jarvis.lab=true` und `jarvis.lab.run=<run-id>` markiert, auf eigene Netzwerke/Volumes begrenzt und werden nur nach erfolgreichem Nachweis eindeutig zugeordnet bereinigt.

**Tech Stack:** Node.js ESM, `node:test`, bestehende Docker-Lab-Fixtures, Chromium, `scripts/test-repair-integration.mjs`, `scripts/dev-check.mjs`.

---

### Task 1: Isolierten Worktree und Lab-Vertrag prüfen

**Files:**
- Inspect: `AGENTS.md`, `docs/STATUS.md`, `package.json`
- Inspect: `scripts/test-repair-integration.mjs`
- Inspect: `test/integration/repair-lab/lab.mjs`
- Inspect: `test/integration/full-order-046/full-order.integration.test.js`
- Inspect: `test/integration/repair-quality-054/repair-quality.integration.test.js`
- Inspect: `test/integration/service-separation-047/service-separation.integration.test.js`

- [x] **Step 1: Worktree auf Basis von `8540aca` erstellen und Fremdänderungen schützen**

Der Arbeitsstand ist `C:\Users\Administrator\Documents\Chris\Jarvis-tf030` auf `agent-codex/tf030`. Der ursprüngliche Worktree `Jarvis-codex` wird nicht geändert oder gestaged.

- [x] **Step 2: Lab-Ressourcen statisch nachvollziehen**

Prüfen, dass die Suite eigene `jarvis.lab=true`-Labels, eine Run-ID, eigene Netzwerke/Volumes und loopback-gebundene Ports verwendet. Keine Secrets, Produktions-Compose-Dateien oder produktiven Datenverzeichnisse lesen.

- [x] **Step 3: Docker read-only prüfen**

`docker.exe` ist lokal vorhanden. Die read-only-Abfrage (`docker context show` und `docker version`) wurde jedoch vor der Ausführung durch den Ausführungs-Guard mit `Keine Container ohne Freigabe.` abgewiesen. Die Prozess-/Dienstprüfung lieferte keinen Nachweis für laufendes Docker Desktop (`Docker Desktop`, `com.docker.backend`, `com.docker.proxy`, `com.docker.service` nicht vorhanden). Engine, Kontext und vorhandene Ressourcen sind damit nicht verifiziert; die Lab-Ausführung wurde sicher gestoppt und als BLOCKED dokumentiert.

### Task 2: Synthetische Docker-Labs ausführen

**Files:**
- Test: `test/integration/repair-lab/repair-lab.integration.test.js`
- Test: `test/integration/repair-lab/browser-validation.integration.test.js`
- Test: `test/integration/full-order-046/full-order.integration.test.js`
- Test: `test/integration/repair-quality-054/repair-quality.integration.test.js`
- Test: `test/integration/service-separation-047/service-separation.integration.test.js`

- [x] **Step 1: Worktree-Abhängigkeiten und Chromium bereitstellen**

Falls `node_modules` fehlt, `npm ci --ignore-scripts --no-audit --no-fund` ausführen. Für Browser-Labs nur den vorhandenen lokalen Chromium-Pfad prozesslokal setzen.

- [x] **Step 2: Die fünf bestehenden Lab-Einstiegspunkte ausführen**

Nicht ausgeführt: Die Voraussetzung einer nachweisbaren Docker-Isolation war nicht erfüllt. Alle zwölf Docker-/Repair-Labs sind im Bericht als BLOCKED erfasst.

```powershell
$env:JARVIS_CHROMIUM_PATH='C:\Users\Administrator\AppData\Local\ms-playwright\chromium-1248\chrome-win64\chrome.exe'
npm run test:repair-integration
npm run test:browser-integration
npm run test:full-order-integration
npm run test:repair-quality-integration
npm run test:separation-integration
```

Kein `docker compose down`, keine globale Bereinigung und keine produktiven Volumes. Fehler werden unverändert als FAIL dokumentiert.

- [x] **Step 3: Eindeutig zugeordnete Testressourcen prüfen und nur diese bereinigen**

Keine Lab-Ressourcen wurden gestartet oder erzeugt; deshalb war keine Bereinigung erforderlich. Es wurden keine bestehenden Container, Volumes oder Netzwerke gelöscht oder verändert.

### Task 3: Vollständige Release-Verifikation

**Files:**
- Test: komplette Unit-Suite über `scripts/dev-check.mjs --full`
- Test: `node scripts/secret-scan.mjs`

- [x] **Step 1: Vollsuite mit lokalem Chromium ausführen**

```powershell
$env:JARVIS_CHROMIUM_PATH='C:\Users\Administrator\AppData\Local\ms-playwright\chromium-1248\chrome-win64\chrome.exe'
$env:CHROME_PATH=$env:JARVIS_CHROMIUM_PATH
node scripts/dev-check.mjs --full
```

Ergebnis mit Gesamtzahl, Pass, Fail, Skip und Exit-Code erfassen. Keine Skips oder Timeouts ergänzen, um Fehler zu verdecken.

- [x] **Step 2: Security-/Diff-Prüfungen ausführen**

`node scripts/dev-check.mjs`, `node scripts/secret-scan.mjs` und `git diff --check` werden nach Erstellung der TF-030-Dokumentation erneut ausgeführt. Der Full-Check hat den Secret-Scan bereits ohne Treffer beendet; Produktivdateien und fremde Änderungen bleiben außerhalb des Stagings.

### Task 4: Bericht und Commit

**Files:**
- Create: `reports/TF-JARVIS-030/ABSCHLUSSBERICHT.md`
- Modify: `docs/STATUS.md`
- Modify: this plan

- [x] **Step 1: Jede der zwölf Lab-Prüfungen einzeln als PASS/FAIL/BLOCKED dokumentieren**

Zusätzlich Isolation, vorhandene Ressourcen, Cleanup-Nachweis, Full-Check, Sicherheitsstatus, verbleibende Blocker und READY/BLOCKED-Empfehlung festhalten.

- [x] **Step 2: Commit-Hygiene prüfen**

Nur TF-030-Test-/Dokumentationsänderungen stagen. Vor dem Commit `node scripts/dev-check.mjs` und `git diff --cached --check` ausführen; kein Push, Merge oder Deployment.

- [x] **Step 3: Isolierten Branch nach Commit verifizieren**

`git status --short --branch` muss sauber sein; Commit-ID und unveränderte Fremdworktrees im Abschlussbericht/Finale nennen.
