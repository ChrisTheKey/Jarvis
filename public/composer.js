// Texteingabe (Composer) des Jarvis-HUD – dieselbe in LOCAL und CLOUD (klassisches Skript, auch in Node-Tests ladbar).
// Enter sendet, Shift+Enter fügt eine neue Zeile ein; das Feld wächst bis zu einigen Zeilen mit.
(function (g) {
  // Während einer IME-Eingabe (z. B. Akzente) oder mit Strg/Alt/Meta wird nie gesendet.
  function shouldSubmit(e) { return e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey; }

  function attach({ form, input, maxRows = 5 }) {
    function fit() {
      const lh = (typeof getComputedStyle === "function" && parseFloat(getComputedStyle(input).lineHeight)) || 22;
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight || lh, lh * maxRows + 28) + "px";
    }
    input.addEventListener("keydown", (e) => {
      if (!shouldSubmit(e)) return; // Shift+Enter: Standardverhalten = neue Zeile
      e.preventDefault();
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.dispatchEvent(new Event("submit", { cancelable: true }));
    });
    input.addEventListener("input", fit);
    return { fit, clear() { input.value = ""; fit(); }, focus() { input.focus(); } };
  }

  g.JarvisComposer = { shouldSubmit, attach };
})(typeof window !== "undefined" ? window : globalThis);
