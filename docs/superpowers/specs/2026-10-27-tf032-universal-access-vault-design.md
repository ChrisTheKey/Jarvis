# TF-032 – Universeller Zugangsdaten-Tresor: Design

## Ziel und Grenze

Der bestehende, auftragsgebundene und einmal verwendbare Zugangstresor wird für bekannte und unbekannte Website-Technologien universell nutzbar. Er bleibt vollständig fail-closed: eine Erkennung ist ausschliesslich ein Hinweis, ein unbekannter Anbieter ist zulässig für die Tresorübermittlung, aber niemals automatisch reparierbar.

Keine neue Live-Integration, kein externer Provider-Aufruf und keine Änderung am Verschlüsselungs-, Domainbindungs-, Einmal-Link-, Einwilligungs- oder Löschvertrag sind Teil dieses Vorhabens.

## Provider-Registry

`access-provider-registry.js` ist der gemeinsame deklarative Kern. Jedes Profil enthält eine stabile Kennung, Namen/Aliasse, erlaubte Zugangsarten, Formularfelder, Hinweise zur geringstmöglichen Berechtigung, Automatisierungsstatus und optional die erwartete Adapterkennung.

Die Registry kennt die vorhandenen Plattformen und Hoster (unter anderem WordPress, WooCommerce, Shopify, Wix, Squarespace, Webflow, Joomla, Drupal, TYPO3, Netlify, Vercel, Cloudflare, GitHub, GitLab, AWS, Azure und Google Cloud). Sie ist nicht abschliessend. Das Profil `CUSTOM` akzeptiert einen frei angegebenen Anbieter, eine der erlaubten Zugangsarten und begrenzte verschlüsselte Zusatzinformationen.

Die Registry ist keine Adapter-Registry: `automation: "manual"` ist der sichere Standard. `automation: "adapter"` ist nur möglich, wenn die erwartete Adapterkennung tatsächlich im Repair-Engine-Adapterset vorhanden ist.

## Erkennung und Kundenentscheidung

`hosting-detect.js` behält öffentliche, gewichtete Signale und die bestehende Confidence-Logik. Es setzt nie einen unbestätigten Anbieter als Fakt. Der Befund enthält zusätzlich ein Registry-Profil als Vorschlag nur dann, wenn die bestehende Confidence hoch genug ist. Schwache, widersprüchliche oder unbekannte Signale führen zum `CUSTOM`-Profil.

Das Access-Intake-Info-API gibt eine whitelisted Formularbeschreibung zurück. Das Browserformular rendert diese Beschreibung; es übernimmt keine freien Felddefinitionen vom Browser. Ein Kunde kann einen Vorschlag durch ein unterstütztes Profil oder `CUSTOM` ersetzen, gibt Anbietername und gewählte Zugangsart an und bestätigt Domain sowie Reparaturautorisierung. Geheimnisse bleiben verschlüsselt im vorhandenen Envelope und werden weder in Metadaten, Logs noch Fehlermeldungen übernommen.

## Reparaturfreigabe

Nach bestätigter CHF-480-Vollzahlung läuft der bestehende Workflow unverändert weiter. Vor dem Adapteraufruf prüft er zusätzlich:

1. ausdrückliche, domaingebundene Autorisierung;
2. Eingang und erfolgreiche Prüfung des verschlüsselten Zugangs;
3. ein Registry-Profil mit `automation: "adapter"`;
4. passenden, vorhandenen Adapter;
5. bestehenden Backup- und Rollback-Gate.

Fehlt ein Punkt oder ist der Anbieter unbekannt, setzt der Workflow `MANUAL_REVIEW_REQUIRED`; er versucht keine Verbindung und keine Reparatur. Die erste Zugangs-Mail enthält weiterhin ausschliesslich den persönlichen Tresor-Link und fordert nie Zugangsdaten per E-Mail an.

## Daten- und Sicherheitsvertrag

Persistiert werden nur nicht geheime Metadaten: Registry-ID, kundenbestätigter Anzeigename in begrenzter, bereinigter Form, gewählte Zugangsart, Automatisierungsstatus sowie Prüfstatus. Anbieterfreitext ist nie Teil öffentlicher CRM-Exports. Der verschlüsselte Envelope bleibt der alleinige Speicher für Zugangsdaten und zusätzliche Verbindungsangaben; die bestehende sichere Löschung bleibt verbindlich.

## Tests und Erfolgskriterien

Neue synthetische Tests decken bekannte Profile, unbekannte Anbieter, abweichende Zugangsarten, ungültige Domain, Einmal-Link/Einwilligung, keinen Klartext in Metadaten/Logs, verfügbare und fehlende Adapter, Backup-/Rollback-Gates sowie die Zugangs-Mail ab. Bestehende TF-071- und CHF-480-Regressionen bleiben grün. Docker-Labs werden nur bei separat nachgewiesener lokaler Isolation gestartet.
