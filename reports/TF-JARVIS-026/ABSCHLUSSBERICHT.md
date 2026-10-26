# TF-JARVIS-026 – Abschlussbericht

Stand: 2026-10-26

Repository: `C:\Users\Administrator\Documents\Chris\Jarvis-codex`

Branch: `agent-codex/main`
Status: **BLOCKED**

## Kurzfazit

Die lokale TF-024/TF-025-Codebasis ist für die dokumentierten synthetischen Prüfungen nachvollziehbar und der frische lokale Vollcheck ist grün. Ein produktiver Rollout ist trotzdem noch nicht freigegeben und technisch nicht vollständig nachgewiesen.

Die tatsächlichen Blocker sind:

1. Der Codex-Stand `9536355` ist noch nicht in den aktuellen Integrations-/Default-Branch `claude/jarvis-voice-dashboard-9phl5w` integriert. Ein automatischer Merge wurde nicht durchgeführt.
2. Der direkte CRM-Button ist absichtlich auf synthetische Leads und Sandbox-Betrieb beschränkt. Das ist eine wirksame Sicherheitsbarriere, aber noch kein produktiver Versandweg für echte Kunden. Eine Produktionsfreigabe kann nicht durch eine reine Konfigurationsänderung behauptet werden.
3. Der tatsächliche VPS-, Netlify- und Produktionskonfigurationsstand wurde wegen des ausdrücklichen SSH-Verbots nicht verifiziert. Containerzustand, laufender Commit, Backup-Alter, Volumes, Gmail-OAuth und Stripe-Konfiguration bleiben daher offene Nachweise.
4. Die Docker-Integrations-Labs wurden im Vollcheck nicht ausgeführt, weil `JARVIS_REPAIR_LAB=1` nicht gesetzt war. Ihre Ausführung erfordert eine separate, kontrollierte Testumgebung und ist kein Grund, die Testbedingungen abzusenken.

## 1. Repository und Integration

| Prüfung | Ergebnis |
|---|---|
| Aktiver Branch | `agent-codex/main` |
| Lokaler HEAD | `9536355b097c236669f9649da8c3484092146d87` (`9536355`) |
| Remote | `https://github.com/ChrisTheKey/Jarvis.git` |
| Remote-Branch | `origin/agent-codex/main` zeigt auf denselben Commit |
| Bestätigte Vorgänger | `3d5efde` und `10bbf70` sind in der Historie vorhanden |
| Remote-HEAD | `claude/jarvis-voice-dashboard-9phl5w` auf `07b68c5` |
| Vergleich zur Integration | Integrations-Branch: 3 eigene Commits; Codex-Branch: 10 eigene Commits seit dem gemeinsamen Merge-Base `1ceabe6` |
| Merge-Konflikte | Git meldet bei einem trivialen Merge einen Textkonflikt in `docs/STATUS.md`; kein Merge wurde ausgeführt |
| Uncommittete Dateien | Vorhandene Änderungen in `test/crm-fixture.js` und drei TF-024-Screenshots wurden nicht verändert oder gestaged |

Die branchübergreifende Dateiprüfung ergab:

- Die Integrationsseite enthält gegenüber dem gemeinsamen Merge-Base unter anderem eine eigene Änderung in `scripts/run-unit-tests.mjs`. Diese Änderung darf bei der späteren Integration nicht durch den Codex-Stand verloren gehen.
- `docs/STATUS.md` ist auf beiden Seiten geändert und muss manuell zusammengeführt werden.
- Die TF-024/TF-025-Dateien müssen nach dem Merge insbesondere in CRM, Mail-Worker, Repair, Stripe, Access-Intake und Docker-Images fachlich geprüft werden, auch wenn Git einzelne Dateien automatisch zusammenführen kann.

## 2. Frische lokale Verifikation

Ausgeführt wurde:

```text
JARVIS_CHROMIUM_PATH=<vorhandenes lokales Playwright-Chromium>
CHROME_PATH=<derselbe Prozesswert>
node scripts/dev-check.mjs --full
```

Ergebnis:

| Kennzahl | Ergebnis |
|---|---:|
| Exit-Code | 0 |
| Tests | 1’192 |
| Bestanden | 1’180 |
| Fehlgeschlagen | 0 |
| Übersprungen | 12 |
| Secret-Scan | 0 Treffer |
| Vollcheck-Dauer | ca. 434 Sekunden |

Die 12 Übersprünge sind die markierten Docker-/Repair-Integrations-Labs, die nur mit `JARVIS_REPAIR_LAB=1` ausgeführt werden. Sie wurden nicht als bestanden gezählt. Der Vollcheck enthält unter anderem die TF-024-Direct-Mail-, TF-024-Phase-3-, CRM-, Auth-, DNC-, Stripe-, Access-Intake-, Service-Separation- und Repair-Gates.

Die vom Auftrag übernommene TF-025-Evidenz umfasst außerdem 52/52 gezielte Regressionstests sowie synthetische CHF-150-/CHF-480-Prüfungen. Diese lokale Evidenz beweist weder Live-Zustellung noch den Zustand der Produktionsinfrastruktur.

Nicht ausgeführt wurden:

- kein SSH und keine Read-only-Prüfung auf dem Hetzner-VPS;
- kein Netlify-Deploy oder Netlify-Statusabruf;
- kein Docker-Build oder Container-Neustart auf Produktion;
- kein Live-E-Mail-Versand, keine echte Zahlung und kein Zugriff auf Kundendaten;
- kein Merge und kein Push dieses TF-026-Dokumentationscommits aus dem Agenten-Worktree.

## 3. Architektur- und Komponentenbefund

| Komponente | Nachweis im Repository | TF-026-Entscheid |
|---|---|---|
| Netlify UI/Gateway | `public/`, `netlify/functions/`, `netlify.toml` | Nach Integration gemeinsam mit den Functions deployen; aktueller Netlify-Stand ist nicht verifiziert |
| CRM | `public/crm.js`, `crm-service.js`, `crm-api.js`, Auth-/Scope-Module | TF-024-Button und API-Scope fachlich prüfen; `jarvis-crm` nur aktualisieren, wenn der integrierte Diff es verlangt |
| Mail-Queue | Netlify Blob `jarvis-mail-requests`, `mail-requests.js` | Idempotenz, Queue-Zustand und Claim-Zustand vor einem Worker-Restart sichern |
| Mail-Worker | `mail-worker.js`, `sales-intake.js`, `sales-intake-bundle.js`, `deploy/vps/Dockerfile` | Für Queue-/Direct-Mail-Änderungen erforderlich; nur in Wartungsfenster, da der Restart Mailing unterbricht |
| Repair-Service | `repair-service.js`, `repair-workflow.js`, `check-150-workflow.js`, `deploy/vps/Dockerfile.repair` | Separat mit `deploy-repair.sh`; darf Mail-Worker, CRM und Contacts nicht neu starten |
| Stripe | `stripe-webhook.js`, `stripe-payments.js`, `payments.js`, `netlify/functions/payments.mjs` | TEST/LIVE strikt getrennt prüfen; keine Schlüsseländerung in TF-026 |
| Zugangstresor | `access-intake.js`, `netlify/functions/access-intake.mjs` | Einmal-Token, Ablauf, Auftragsbindung und Hash-only-Zustand erhalten |
| Persistenz | Mail-Secrets/State, Repair-State/Outbox, CRM-Daten, Netlify Blobs | Vor Deploy Backup-Alter, Volume-Mounts und freien Speicher read-only nachweisen |
| Docker | getrennte Compose-Projekte `jarvis-mail`, `jarvis-repair`, `jarvis-crm`, `jarvis-contacts` | Keine globale Compose-Aktion; nur betroffenen Service mit vorhandenen Guards aktualisieren |

Wesentliche Sicherheitsbefunde:

- Der VPS-Mail-Worker ist laut Capability Matrix die einzige Senderautorität.
- `security-capabilities.js` arbeitet standardmäßig deny-by-default; synthetische Adapter sind ausdrücklich markiert und dürfen keine produktiven Gmail-, Calling- oder Paid-API-Aktionen auslösen.
- Die Mail-Worker- und Access-Intake-Pfade prüfen DNC, Opt-out, Suppression, Empfängerbindung, Auftragsbindung, Ablaufdatum und Idempotenz erneut serverseitig.
- Der direkte TF-024-CRM-Versand verlangt aktuell `JARVIS_SALES_SANDBOX_MODE=true`, `lead.is_test=true`, zwei Stripe-Testlinks und einen individuellen One-Time-Access-Link. Ein echter Lead wird mit `SYNTHETIC_ONLY` abgelehnt. Diese Sperre bleibt bestehen.
- Die bestehende Queue-Idempotenz und der Worker-Send-Lock verhindern bei bekanntem Status einen zweiten Versand. Bei unklarem Versandstatus darf später nicht blind erneut versucht werden.

## 4. Tatsächliche Risiken, priorisiert

### P0 – vor jeder Freigabe auflösen

1. **Nicht integrierter Branch:** Der aktuelle Codex-Stand ist nicht der aktuelle Produktions-/Integrationsstand. Ein Deploy aus dem Worktree könnte Änderungen der Integrationsseite auslassen.
2. **Produktiver CRM-Versand noch gesperrt:** Die Sandbox-/Synthetic-Gates sind korrekt und dürfen nicht entfernt werden. Für echte Empfänger fehlt ein separat freigegebener Produktionspfad mit eigenen Live-Tests und Sicherheitsnachweisen.
3. **Produktionszustand unbekannt:** Ohne SSH-Nachweis sind laufender Commit, Container-Health, Worker-Authority, Gmail-OAuth, Stripe-Modus, Backup-Generationen, Volumes und Queue-Zustand unbekannt.
4. **Mail-Worker-Unterbrechung:** `deploy/vps/deploy.sh` baut/startet das Mail-Projekt neu. Ein unkontrollierter Restart kann laufende Claims oder die Zustellbeobachtung beeinflussen.

### P1 – vor dem Rollout kontrollieren

5. TEST-/LIVE-Konfiguration, Stripe-Webhooks und Zahlungszuordnung könnten bei einer falschen Umgebungsdatei vermischt werden.
6. Netlify-Commit, Functions und VPS-Commit könnten auseinanderlaufen.
7. Persistenter State darf nicht mit einer inkompatiblen älteren Codeversion überschrieben werden.
8. Die Docker-Kopiellisten müssen nach der Integration erneut gegen alle Imports geprüft werden; insbesondere `sales-intake-bundle.js` muss im Repair-Image enthalten bleiben.
9. Access-Intake- und Outbox-Volumes müssen vorhanden, beschreibbar an der vorgesehenen Stelle und in den Backups berücksichtigt sein.
10. Stripe-Webhooks müssen signiert, dem korrekten Modus zugeordnet und idempotent verarbeitet werden.

### P2 – beobachten

11. Parallele Entwicklungsbranches können `docs/STATUS.md`, Test-Runner und CRM-Dateien fachlich auseinanderentwickeln.
12. Netlify- und VPS-Healthchecks können unterschiedliche Commitstände anzeigen; ein grüner HTTP-Status allein reicht nicht.

## 5. Fakten und noch nicht verifizierte Annahmen

| Nachweisbar aus dem Worktree | Nur auf Zielsystemen verifizierbar |
|---|---|
| Compose-Projekte, Mounts, `read_only`, `cap_drop`, Healthchecks und Service-Trennung | tatsächlich laufende Container-IDs, Startzeiten, Restart-Zähler und Health-Status |
| Deploy-Skripte und Guards für Mail, Repair und CRM | tatsächlich auf VPS gesetzter `DEPLOYED_COMMIT` |
| Queue-/Worker-Idempotenz im Code und in synthetischen Tests | offene/PROCESSING-Queue-Aufträge und unbekannte Versandversuche |
| One-Time-Access-Token, Hash-only-Vault und Ablaufprüfung im Code | Backup-Alter, Offsite-Erreichbarkeit und Restore-Fähigkeit der produktiven Volumes |
| TEST/LIVE-Prüfungen in Stripe-Code und Tests | tatsächliche Netlify-/VPS-Umgebungsvariablen und ihre Modusgleichheit |
| Read-only-Produktions-Readiness-Skript | Gmail-OAuth-Status und Senderautorität des laufenden Workers |
| `netlify.toml` und Function-Routen | aktuell veröffentlichter Netlify-Deploy und Edge-/Function-Version |
| Lokaler Vollcheck mit Exit 0 | Live-Zustellung, Live-Zahlung, echte Kunden-Websites und externe Providerzustände |

## 6. Erforderliche manuelle Freigaben

Vor einem späteren Deployment sind mindestens erforderlich:

1. Freigabe von Chris für die Integration des Codex-Branches in den aktuellen Integrations-Branch.
2. Freigabe eines konkreten, nach der Integration getesteten Release-Commits.
3. Freigabe für die read-only Serverprüfung und anschließend, getrennt davon, für jeden produktiven Deploy-Schritt.
4. Freigabe eines Wartungsfensters für den Mail-Worker, falls dessen Image oder Queue-Vertrag geändert wird.
5. Eine separate Sicherheits- und Produktentscheidung für einen möglichen echten CRM-Mailbutton. Der aktuelle TF-024-Sandbox-Gate darf nicht per Environment-Variable in einen Kundenversand umgedeutet werden.
6. Falls ein Live-Smoke-Test später überhaupt nötig ist: ausdrückliche Freigabe für ein eigenes Testpostfach und einen genau benannten Testlead; keine Kundendaten.
7. Separate Freigabe für Stripe-LIVE und jede produktive Netlify-/VPS-Konfigurationsänderung.

## 7. Nächster konkreter Schritt

Der nächste sichere Schritt ist eine manuelle Integration im Hauptcheckout durch Chris:

1. `agent-codex/main` gegen `claude/jarvis-voice-dashboard-9phl5w` diffen.
2. `docs/STATUS.md` und `scripts/run-unit-tests.mjs` fachlich zusammenführen, ohne WIP-Dateien aus dem Hauptordner zu überschreiben.
3. Die oben genannten CRM-/Mail-/Repair-/Stripe-/Access-/Docker-Dateien nach dem Merge prüfen.
4. Den vollständigen lokalen Release-Gate einschließlich der Docker-Labs in einer isolierten Testumgebung ausführen.
5. Erst danach einen konkreten Release-Commit bestimmen und eine gesonderte Deploymentfreigabe einholen.

Bis dahin bleibt der Status **BLOCKED**. Es wurde keine produktive Aktion durchgeführt.
