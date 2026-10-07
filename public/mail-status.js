// Systemstatus für das Jarvis-HUD (klassisches Skript, auch in Node-Tests ladbar). Cloud-first:
// JARVIS CORE = Cloud Core auf dem VPS (Heartbeat + Core-Status), LOCAL CLIENT = optionaler Windows-PC.
// Quelle ist die Cloud (send_authority + Heartbeat des zuständigen Workers), nicht der UI-Modus: LOCAL oben rechts heisst nur,
// dass der Local Core erreichbar ist – gesendet wird trotzdem vom VPS, wenn er die Authority hat.
//   service:      { online, authority: "vps" | "local", pending, ai, core }  aus /api/mail-requests (null = Cloud nicht erreichbar)
//   localWorker:  { alive, standby }  Windows-Worker (nur im LOCAL-Modus bekannt, sonst null)
//   localMode:    true, wenn dieser Browser den Local Core erreicht
//   clientSeenAt: letzter Abgleich des Windows-Clients mit der Cloud (sync.lastClientPushAt) – für den CLOUD-Modus
(function (g) {
  const NAMES = { vps: "VPS", local: "WINDOWS" };
  const CLIENT_STALE_MS = 5 * 60_000;

  function summarizeMail({ service = null, localWorker = null, localMode = false, clientSeenAt = null, now = Date.now() } = {}) {
    const known = !!service && typeof service === "object";
    const holder = known ? NAMES[service.authority] || "KEINE" : null;
    const active = known && holder !== "KEINE" && service.online === true;
    const clientOnline = localMode || (!!clientSeenAt && now - Date.parse(clientSeenAt) < CLIENT_STALE_MS);
    // Windows-Worker: ACTIVE nur, wenn Windows selbst die Authority hat und der Heartbeat frisch ist – sonst höchstens STANDBY.
    const windows = localWorker
      ? (!localWorker.alive ? "OFFLINE" : holder === "WINDOWS" && active ? "ACTIVE" : "STANDBY")
      : clientOnline ? (holder === "WINDOWS" && active ? "ACTIVE" : "STANDBY") : known ? "OFFLINE" : null;
    // Cloud Core: läuft im VPS-Prozess mit der Authority; online = frischer Heartbeat mit Core-Status vom VPS.
    const coreOnline = active && holder === "VPS" && service.core?.role === "vps";
    return {
      worker: active ? "ONLINE" : known ? "OFFLINE" : "UNBEKANNT",
      mailService: active ? holder : known ? "OFFLINE" : "UNBEKANNT",
      mailWorker: active ? `${holder} ACTIVE` : windows === "STANDBY" ? "STANDBY" : known ? "OFFLINE" : "UNBEKANNT",
      authority: known ? holder : "UNBEKANNT",
      windows,
      pending: known && Number.isFinite(service.pending) ? service.pending : null,
      core: coreOnline ? "CLOUD ONLINE" : known ? "OFFLINE" : "UNBEKANNT",
      client: clientOnline ? "ONLINE" : "OFFLINE",
      ai: known ? (service.ai === "paused_credit" ? "PAUSED — CREDIT LIMIT" : service.ai === "online" ? "ONLINE" : "–") : "UNBEKANNT",
      healthy: active,
      // Gesamtsystem: Cloud Core + Mail-Worker mit Authority gesund. Der PC (Local Client) ist dafür NICHT nötig.
      system: coreOnline || (active && holder === "WINDOWS") ? "ONLINE" : known ? "EINGESCHRÄNKT" : "UNBEKANNT",
    };
  }

  // „Alle Systeme sind online“ nur, wenn das Gesamtsystem (Cloud Core + Mail-Worker) wirklich läuft. core = optionale
  // Zusatzbedingung des Aufrufers (z. B. Claude Code im LOCAL-Modus); der Windows-PC selbst ist keine Bedingung.
  function allSystemsOnline({ core = true, mail }) { return !!core && !!mail && mail.healthy === true && mail.system === "ONLINE"; }

  g.JarvisMailStatus = { summarizeMail, allSystemsOnline, CLIENT_STALE_MS };
})(typeof window !== "undefined" ? window : globalThis);
