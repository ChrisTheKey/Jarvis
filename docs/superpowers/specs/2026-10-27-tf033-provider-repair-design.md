# TF-033 – Provider-Erkennung und gemeinsamer Reparaturvertrag

## Ziel

Die vorhandenen, sicherheitsgeprüften Reparaturadapter werden unter einem einheitlichen Vertrag nutzbar, ohne bestehende Engine-Aufrufe zu brechen. Anbietererkennung bleibt ein Vorschlag und darf bei schwachen oder widersprüchlichen Signalen keine automatische Reparatur freischalten.

## Design

- `repair-adapters/router.js` bleibt die einzige Adaptergrenze. Die bestehende Contract-Schnittstelle bleibt erhalten; zusätzlich exponiert die Brücke `createBackup`, `planRepair`, `applyRepair` und `validateRepair` als deterministische Aliase bzw. normalisierte Rückgaben.
- Zugangsdaten werden weiterhin nur im Aufrufkontext erzeugt, Antworten werden bereinigt und der Kontext wird danach verworfen. Kein Adapter erhält freie Shell-Befehle.
- `detectProviderSuggestion()` akzeptiert nur ein einzelnes HIGH-Signal als `DETECTED`. Kein verwertbares oder widersprüchliches Signal ergibt `CUSTOM` plus `PROVIDER_VERIFICATION_REQUIRED`; die Providerwahl bleibt damit kundenkorrigierbar.
- Die vorhandenen Zahlungs-, Autorisierungs-, Domain-, Profil-, Backup-, Validierungs- und Rollback-Gates bleiben unverändert vorgeschaltet.

## Statusgrenzen

WordPress/WooCommerce, GitHub/Netlify und klassische SFTP-/SSH-Websites bleiben auf den vorhandenen synthetisch geprüften Adapterpfaden. Shopify, Webflow und Wix erhalten keinen erfundenen Admin- oder Browserpfad und bleiben `VAULT_ONLY`/manuelle Prüfung, bis offizielle, autorisierte und reproduzierbar testbare Schnittstellen vorliegen.

## Tests

Der neue Test prüft die fail-closed Erkennung sowie alle gemeinsamen Vertragsnamen. Bestehende Adapter-, Zahlungs-, Autorisierungs-, Backup-, Rollback- und Geheimnisschutztests bleiben Bestandteil der Regression. Docker-Labs werden nur mit wirksamem isoliertem Laborzugriff ausgeführt; ohne diesen Nachweis bleiben sie BLOCKED.
