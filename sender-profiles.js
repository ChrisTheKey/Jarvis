// Absender-/Geschäftsprofile je Markt (TF-064) – ohne Abhängigkeiten, ohne Secrets. Der Versand-/Entwurfsweg bleibt der bestehende,
// autorisierte Gmail-Sender des Mail-Workers (keine neue Adresse, kein neues Konto). Das Profil bestimmt nur Signatur, Sprache und
// Abmeldezeile eines werblichen Entwurfs bzw. einer Kundenmail.
//
//   CH  bestehende Identität aus config.json (cfg.sender) – exakt unverändert, deutsche Abmeldezeile wie bisher
//   VN  Lap · Hỗ trợ khách hàng Việt Nam · Helvetic Webdesign · vi-VN · Landingpage – feste Signatur, vietnamesische Abmeldezeile
//       Bewusst OHNE Adresse, Telefonnummer, Firmenregister- oder Steuernummer (nichts erfunden).
//
// Auswahl (senderProfileFor): actor_user_id = lap ODER market = VN → VN, sonst CH. Die Metadaten stammen serverseitig aus der
// Session bzw. dem Lead (mail-requests.js), nie frei aus dem Browser.

export const VN_LANDING_PAGE_URL = "https://lapvietnamese.netlify.app/";
export const VN_SIGNATURE = ["Trân trọng,", "Lap", "Hỗ trợ khách hàng Việt Nam", "Helvetic Webdesign", VN_LANDING_PAGE_URL].join("\n");
export const VN_PROFILE = Object.freeze({
  id: "vn", market: "VN", locale: "vi-VN", lang: "vi", name: "Lap", company: "Helvetic Webdesign", role: "Hỗ trợ khách hàng Việt Nam",
  landing_page: VN_LANDING_PAGE_URL, signature: VN_SIGNATURE,
});
export const VN_ACTORS = Object.freeze(["lap"]);
export const isVnMeta = (meta) => !!meta && (VN_ACTORS.includes(meta.actor_user_id) || meta.market === "VN");

// Profil für einen Mailauftrag: { id: "ch", sender: cfg.sender } (unverändert) oder das feste VN-Profil.
export function senderProfileFor(meta, chSender = {}) {
  return isVnMeta(meta) ? { ...VN_PROFILE, sender: { name: VN_PROFILE.name, company: VN_PROFILE.company, signature: VN_SIGNATURE } }
    : { id: "ch", market: "CH", locale: "de-CH", lang: null, sender: chSender };
}
