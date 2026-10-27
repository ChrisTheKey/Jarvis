# TF-JARVIS-032 – Universeller Zugangsdaten-Tresor

## Ergebnis

**Release-Status: BLOCKED – Implementierung vorhanden, vollständige Regression noch nicht grün.**

Arbeitsbranch `agent-codex/tf032-universal`, isolierter Worktree `Jarvis-tf032-universal`, Basis `a6cf835`. Kein Push, Merge, Deployment, SSH-Zugriff, echter Versand, Live-Zahlung oder Zugriff auf Kundensysteme. Neue Datenflüsse/Testläufe verwenden lokale synthetische Fixtures.

## Implementierte Architektur

- `access-provider-registry.js` enthält eine deklarative Provider-Registry, Zugangsarten und Formularfeld-Schemata. Unbekannte Anbieter werden als `CUSTOM` erfasst und nicht aufgrund einer Vermutung abgelehnt.
- Anbietererkennung dient nur als Vorschlag. Anbietername, Domain, Zugangsart und Einwilligung werden getrennt erfasst.
- Zugangsdaten bleiben im bestehenden verschlüsselten Envelope-/Tresorpfad. CRM-Metadaten enthalten nur bereinigte, nicht geheime Anbieterangaben. Das Formular rendert dynamische Felder ohne HTML-Injektion und löscht Secret-Eingaben nach Übergabe.
- Ohne passende Provider-/Adapterkombination, gültige Rechte, ausdrückliche Freigabe, Zugangsprüfung, Backup und Rollback-Punkt startet keine automatische Reparatur. Nicht unterstützte Systeme gehen auf `MANUAL_REVIEW_REQUIRED`.
- Im Universal-Onboarding-Pfad wird die CHF-480-Reparatur erst nach nachgewiesener Vollzahlung aktiviert. Bestehende Nicht-Onboarding-/Legacy-Reparaturpfade behalten das bisherige Anzahlungs-Gate.
- `Dockerfile.repair` enthält die Registry-Datei, damit der Repair-Service im Image importierbar ist.

## Provider-Abdeckung

| Profile | Zugang im Tresor | Automatische Reparatur |
|---|---|---|
| WordPress, WooCommerce | Ja | Adapterpfad `wordpress`, nur bei passender Zugangsmethode und allen bestehenden Gates |
| Netlify, GitHub | Ja | Adapterpfad `github_netlify`, nur bei verifizierter Zuordnung und allen bestehenden Gates |
| Shopify, Wix, Squarespace, Webflow, Joomla, Drupal, TYPO3, Magento, PrestaShop, Shopware, BigCommerce, Jimdo | Ja | Derzeit manuelle Prüfung |
| IONOS, Hostpoint, Infomaniak, GoDaddy, SiteGround, Bluehost, Hostinger | Ja | Derzeit manuelle Prüfung |
| Cloudflare, Vercel, AWS, Azure, Google Cloud, GitLab | Ja | Derzeit manuelle Prüfung |
| Individueller/unbekannter Anbieter | Ja, frei erfassbar | Immer `MANUAL_REVIEW_REQUIRED`, bis ein explizit unterstützter Adapter existiert |

Ein Profileintrag allein erteilt keine Reparaturberechtigung. Die Laufzeit prüft zusätzlich die konkret gewählte Zugangsmethode und den deklarierten Adapter.

## Verifikation

- TF-032 Registry-/Intake-/Formular-/Adapter-/Zahlungsgate: **5/5 bestanden** im gezielten Lauf.
- TF-071 gezielte Regressionen: **12/12 bestanden**.
- TF-079 nach Anpassung an das neue Vollzahlungsgate: **10/10 bestanden** im gemeinsamen gezielten Lauf.
- Gemeinsamer gezielter Lauf `onboarding-066`, `tf079`, `repair-adapter-036`, `tf032-universal-access-vault` und `tf071`: **61/61 bestanden**, keine übersprungenen Tests. Die TF-066-Fixtures wurden auf vollständige CHF-480-Zahlung korrigiert; die Geschäftslogik-/Quittungsassertions blieben unverändert.
- Ein früherer breiter Regressionstestlauf endete vor diesen Korrekturen mit **25 Fehlern in 159 Tests**: echte Chromium-Prüfungen brachen ab, weil in diesem Worktree-Lauf kein Chromium-Pfad verfügbar war; weitere Fehler betrafen alte CHF-240-Erwartungen und überzahlte TF-066-Fixtures. Dieser Lauf ist überholt und kein aktueller Endstand.
- Finaler `node scripts/dev-check.mjs --full` mit prozesslokalen `CHROME_PATH` und `JARVIS_CHROMIUM_PATH`: **1'211 Tests, 1'199 bestanden, 0 fehlgeschlagen, 12 übersprungen; Exit 0**. Die vorherigen 55 Regressionen wurden nachgewiesen und korrigiert; die gezielte Nachprüfung der betroffenen Dateien bestand 107/107.
- Secret-Scan: 408 Dateien, 0 bekannte Secret-Werte, 0 Treffer. Syntax: 18 geänderte Dateien bestanden.
- Docker-Labs: 12 übersprungen, nicht ausgeführt; Docker-Isolation wurde nicht verifiziert. Kein produktiver Container oder Volume wurde berührt.

## Offene Punkte und nächster Schritt

1. Docker-Isolation nach ausdrücklicher Freigabe read-only nachweisen; danach die zwölf synthetischen Docker-Labs in isolierter Umgebung ausführen.
2. Vor jeder Produktionsfreigabe separate Freigabe und kontrollierte Live-Konfigurations-/Betriebsnachweise einholen.

Bis diese Nachweise grün sind, bleibt TF-032 **BLOCKED**. Änderungen sind lokal und uncommittet; es wurde kein Commit erstellt, weil Release-Gates noch fehlschlagen.
