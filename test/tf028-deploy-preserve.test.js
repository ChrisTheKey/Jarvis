// TF-JARVIS-028: Deploys dürfen /opt/jarvis-payment/{stripe,e2e}.env nie leeren. Das Verzeichnis ist root:root 0700 – eine Existenzprüfung
// als Deploy-Benutzer ([ -f … ]) sieht die Datei nie, hielt sie für fehlend und überschrieb sie mit einer leeren Datei.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (f) => fs.readFileSync(new URL(`../deploy/vps/${f}`, import.meta.url), "utf8");

test("TF-JARVIS-028 deploy.sh / repair-remote.sh prüfen die Payment-Dateien mit Root-Rechten, bevor sie eine leere Datei anlegen", () => {
  for (const f of ["deploy.sh", "repair-remote.sh"]) {
    // TF-JARVIS-PRAXIS-002: repair-remote.sh nutzt "$PAY" (Standard /opt/jarvis-payment, nur das Lab weicht ab).
    const lines = read(f).split("\n").filter((l) => (l.includes("/opt/jarvis-payment/") || l.includes("$PAY/")) && /: >/.test(l));
    assert.ok(lines.length >= 1, `${f}: Anlege-Zeile vorhanden`);
    for (const l of lines) {
      assert.doesNotMatch(l, /(^|[;\s])\[\s+-f\s/, `${f}: keine unprivilegierte [ -f ]-Prüfung: ${l.trim()}`);
      assert.match(l, /(sudo|\$SUDO)\s+test\s+-f\s/, `${f}: Prüfung mit sudo/$SUDO: ${l.trim()}`);
    }
  }
  assert.match(read("repair-remote.sh"), /^PAY="\$\{PAY:-\/opt\/jarvis-payment\}"\r?$/m, "Produktions-Standard unverändert");
});
