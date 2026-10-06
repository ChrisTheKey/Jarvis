// Local/Cloud-Erkennung für das Jarvis-HUD (klassisches Skript, auch in Node-Tests ladbar).
// LOCAL, sobald der Local Core auf diesem PC antwortet; sonst CLOUD (falls eingerichtet) oder OFFLINE.
// Prüft in ruhigen Abständen (15–30 s) erneut: wechselt automatisch zu LOCAL, wenn der Core hochkommt, und fällt auf
// CLOUD zurück, wenn er ausfällt. Während Jarvis gerade antwortet, wird nie umgeschaltet.
(function (g) {
  const MIN_INTERVAL_MS = 15000, MAX_INTERVAL_MS = 30000;

  function decideMode({ localOk, cloudOk }) { return localOk ? "local" : cloudOk ? "cloud" : "offline"; }

  function createModeDetector({ probeLocal, probeCloud = async () => false, onChange = () => {}, isBusy = () => false, intervalMs = 20000,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t), initial = null }) {
    const interval = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Number(intervalMs) || 20000));
    let mode = initial, timer = null, running = false, checking = null;

    async function check() {
      if (checking) return checking; // nie zwei Prüfungen gleichzeitig
      checking = (async () => {
        const localOk = await Promise.resolve().then(probeLocal).then(Boolean, () => false);
        const cloudOk = localOk ? false : await Promise.resolve().then(probeCloud).then(Boolean, () => false);
        const next = decideMode({ localOk, cloudOk });
        if (next !== mode && (mode === null || !isBusy())) {
          const prev = mode;
          mode = next;
          try { await onChange(next, prev); } catch (e) { /* Anzeige-Fehler stoppen die Erkennung nie */ }
        }
        return mode;
      })();
      try { return await checking; } finally { checking = null; }
    }
    function schedule() {
      if (!running) return;
      timer = setTimer(async () => { try { await check(); } finally { schedule(); } }, interval);
    }
    return {
      check,
      start() { if (!running) { running = true; schedule(); } },
      stop() { running = false; if (timer !== null) clearTimer(timer); timer = null; },
      get mode() { return mode; },
      interval,
    };
  }

  g.JarvisModeDetect = { createModeDetector, decideMode, MIN_INTERVAL_MS, MAX_INTERVAL_MS };
})(typeof window !== "undefined" ? window : globalThis);
