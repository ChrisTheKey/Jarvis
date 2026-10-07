// Mail-Worker-Status für das Jarvis-HUD (klassisches Skript, auch in Node-Tests ladbar).
// Quelle ist die Cloud (send_authority + Heartbeat des zuständigen Workers), nicht der UI-Modus: LOCAL oben rechts heisst nur,
// dass der Local Core erreichbar ist – gesendet wird trotzdem vom VPS, wenn er die Authority hat.
//   service:     { online, authority: "vps" | "local", pending }  aus /api/mail-requests (null = Cloud nicht erreichbar)
//   localWorker: { alive, standby }  Windows-Worker (nur im LOCAL-Modus bekannt, sonst null)
(function (g) {
  const NAMES = { vps: "VPS", local: "WINDOWS" };

  function summarizeMail({ service = null, localWorker = null } = {}) {
    const known = !!service && typeof service === "object";
    const holder = known ? NAMES[service.authority] || "KEINE" : null;
    const active = known && holder !== "KEINE" && service.online === true;
    // Windows-Worker: ACTIVE nur, wenn Windows selbst die Authority hat und der Heartbeat frisch ist – sonst höchstens STANDBY.
    const windows = !localWorker ? null
      : !localWorker.alive ? "OFFLINE"
      : holder === "WINDOWS" && active ? "ACTIVE"
      : "STANDBY";
    return {
      worker: active ? "ONLINE" : known ? "OFFLINE" : "UNBEKANNT",
      mailService: active ? holder : known ? "OFFLINE" : "UNBEKANNT",
      mailWorker: active ? `${holder} ACTIVE` : windows === "STANDBY" ? "STANDBY" : known ? "OFFLINE" : "UNBEKANNT",
      authority: known ? holder : "UNBEKANNT",
      windows,
      pending: known && Number.isFinite(service.pending) ? service.pending : null,
      healthy: active,
    };
  }

  // „Alle Systeme sind online“ nur, wenn Kern (Claude Code) UND der zuständige Mail-Worker wirklich laufen.
  function allSystemsOnline({ core, mail }) { return !!core && !!mail && mail.healthy === true; }

  g.JarvisMailStatus = { summarizeMail, allSystemsOnline };
})(typeof window !== "undefined" ? window : globalThis);
