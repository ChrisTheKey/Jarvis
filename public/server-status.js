// SERVER-Panel des Jarvis-HUD (klassisches Skript, auch in Node-Tests ladbar). Quelle: GET /api/server-control (letzter Status des VPS).
// Nur Anzeige: keine Befehle, kein Token – der Browser kennt nur das Cloud-Passwort, nie den Server-Token des VPS.
(function (g) {
  const STALE_MS = 3 * 60_000;
  const pct = (v) => (Number.isFinite(v) ? `${Math.round(v)} %` : "–");
  const gb = (v) => (Number.isFinite(v) ? `${(v / 1024 ** 3).toFixed(1)} GB` : "–");
  function duration(s) {
    if (!Number.isFinite(s)) return "–";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }
  // data: Antwort von /api/server-control (null = nicht erreichbar / nicht angemeldet). Ergebnis: Zeilen fürs HUD + Tönung.
  function summarizeServer(data, now = Date.now()) {
    if (!data || data.configured === false) return { server: data?.configured === false ? "NICHT KONFIGURIERT" : "UNBEKANNT", online: false, rows: {} };
    const s = data.snapshot, at = data.snapshot_at ? Date.parse(data.snapshot_at) : NaN;
    const online = !!s && Number.isFinite(at) && now - at < STALE_MS;
    if (!online) return { server: "OFFLINE", online: false, rows: {}, seen: data.snapshot_at || null };
    const sys = s.system || {}, b = s.backup || {}, dp = s.deploy || {};
    return {
      server: "ONLINE", online: true, seen: data.snapshot_at,
      rows: {
        uptime: duration(sys.uptime_s),
        cpu: pct(sys.cpu_pct),
        ram: Number.isFinite(sys.mem_pct) ? `${pct(sys.mem_pct)} von ${gb(sys.mem_total)}` : "–",
        disk: Number.isFinite(sys.disk_pct) ? `${pct(sys.disk_pct)} · ${gb(sys.disk_free)} frei` : "–",
        docker: s.docker?.status || "–",
        core: s.jarvis?.core || "–",
        mail: s.mail?.worker || "–",
        scheduler: s.scheduler?.status === "ONLINE" ? "ONLINE" : s.scheduler?.status || "–",
        backup: b.status === "OK" ? "OK" : b.status === "FAILED" ? "FEHLER" : b.status === "NONE" ? "KEINS" : "–",
        deploy: dp.commit ? `${dp.commit.slice(0, 7)}${dp.deployed_at ? " · " + dp.deployed_at.slice(0, 16).replace("T", " ") + " UTC" : ""}` : "–",
      },
      ok: { cpu: sys.cpu_pct < 85, ram: sys.mem_pct < 90, disk: sys.disk_pct < 90, docker: s.docker?.status === "ONLINE", core: s.jarvis?.core === "HEALTHY",
        mail: s.mail?.worker === "VPS ACTIVE", scheduler: s.scheduler?.status === "ONLINE", backup: b.status === "OK" },
    };
  }
  g.JarvisServerStatus = { summarizeServer, duration, STALE_MS };
})(typeof window !== "undefined" ? window : globalThis);
