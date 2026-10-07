// TF-024 SWISS STRICT EMAIL COMPLIANCE – zentrale, einzige Entscheidung, ob Jarvis eine E-Mail selbständig senden darf.
// Grundlage: Art. 3 Abs. 1 lit. o UWG (Massenwerbung nur mit vorheriger Einwilligung oder an Bestandskunden für ähnliche eigene
// Leistungen, mit Absender und kostenloser Abmeldemöglichkeit).
//
//   MARKETING           nur EXPLICIT_OPT_IN oder EXISTING_CUSTOMER_SIMILAR_SERVICE – vollständig belegt, Vertrauen HIGH
//   SOLICITED_RESPONSE  nur konkrete dokumentierte Anfrage (REQUESTED_CONTACT) oder konkrete aktive passende Ausschreibung
//                       (ACTIVE_RFP_RESPONSE), nur innerhalb des angefragten Umfangs, nie Marketing-Follow-up
//   DRAFT_ONLY          TF-025 Cold Lead: nur Gmail-Entwurf, nie gesendet
//   BLOCKED             alles andere. MEDIUM/LOW Vertrauen = BLOCK, fehlende Evidence = BLOCK.
// Eine öffentliche Adresse (info@, Impressum, Kontaktseite, Verzeichnis, Maps, LinkedIn, Whois, Register, .ch), ein Reparaturbefund,
// vermutetes Interesse oder eine Freigabe/Bestätigung durch Chris sind NIE eine Grundlage. Es gibt keinen Override – Felder wie
// approved_by_chris, force, override oder admin_bypass in der Nachricht werden ignoriert.

export const MESSAGE_CLASSES = Object.freeze(["MARKETING", "SOLICITED_RESPONSE", "TRANSACTIONAL", "DRAFT_ONLY", "BLOCKED"]);
export const LEGAL_BASES = Object.freeze(["EXPLICIT_OPT_IN", "EXISTING_CUSTOMER_SIMILAR_SERVICE", "REQUESTED_CONTACT", "ACTIVE_RFP_RESPONSE", "NONE"]);
export const MARKETING_BASES = Object.freeze(["EXPLICIT_OPT_IN", "EXISTING_CUSTOMER_SIMILAR_SERVICE"]);

const norm = (s = "") => (String(s).match(/<([^>]+)>/)?.[1] || String(s)).trim().toLowerCase();
const text = (v) => [].concat(v ?? []).filter((x) => x !== null && x !== undefined).map(String).join(" ").trim();
// Feld in camelCase (leads.json) oder snake_case lesen, auch aus einem Unterobjekt (consent/customer/request/rfp).
const pick = (lead, sub, ...names) => {
  for (const n of names) {
    const snake = n.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
    for (const o of [lead?.[sub], lead]) if (o && (o[n] !== undefined || o[snake] !== undefined)) return o[n] ?? o[snake];
  }
  return undefined;
};
const pastDate = (v, now) => { const t = Date.parse(v); return Number.isFinite(t) && t <= +now ? t : null; };

// Leistung von Helvetic Webdesign (Website-Prüfung/-Reparatur) – Umfang muss dazu passen.
export const SERVICE_RE = /website|webseite|homepage|webdesign|web-?site|internetauftritt|reparatur|repair|wordpress|site web|sito web/i;
// Öffentliche Fundstellen und Annahmen – niemals Einwilligung, Kundenbeziehung oder Anfrage.
export const PUBLIC_SOURCE_RE = /impressum|imprint|kontaktseite|contact[ -]?page|\binfo@|verzeichnis|directory|local\.ch|search\.ch|google[ -]?maps|maps\.google|linkedin|whois|handelsregister|firmenregister|zefix|moneyhouse|\.ch[- ]domain|öffentlich (gefunden|angegeben)|publicly listed|reparaturbedarf|repair[ -]issue|website-befund|vermutet|interesse angenommen|chris (approval|freigabe|hat freigegeben)|freigabe durch chris|manuell freigegeben|approved by chris/i;
// Allgemeine Einladungen sind keine konkrete Anfrage.
export const GENERIC_INVITE_RE = /offerten (sind )?willkommen|kontaktieren sie uns|nehmen sie kontakt|supplier[- ]?(proposals?|page|portal)|lieferant(en)?[- ]?(werden|seite|portal)|partner[- ]?(werden|seite|programm|page)|become a partner|wir freuen uns (über|auf) (ihre )?(angebote|offerten|kontakt)|proposals welcome/i;

const deny = (message_class, legal_basis, confidence, rationale, evidence = []) => ({ allowed: false, message_class, legal_basis, confidence, evidence, rationale });
const allow = (message_class, legal_basis, evidence, rationale) => ({ allowed: true, message_class, legal_basis, confidence: "HIGH", evidence, rationale });
const conf = (v) => (["HIGH", "MEDIUM", "LOW"].includes(String(v || "").toUpperCase()) ? String(v).toUpperCase() : "LOW");

// Jede Prüfung liefert { ok, confidence, evidence[], missing[] }.
function checkOptIn(lead, recipient, now) {
  const basis = pick(lead, "consent", "basis", "consentBasis");
  if (!["opt_in", "explicit_opt_in", "EXPLICIT_OPT_IN"].includes(basis)) return null;
  const f = {
    recipient: norm(pick(lead, "consent", "recipient", "consentRecipient") || ""),
    consent_source: text(pick(lead, "consent", "source", "consentSource")),
    consent_date: pick(lead, "consent", "date", "consentDate", "consentAt"),
    consent_scope: text(pick(lead, "consent", "scope", "consentScope")),
    evidence: text(pick(lead, "consent", "evidence", "consentEvidence")),
    obtained_before_marketing_send: pick(lead, "consent", "obtainedBeforeMarketingSend"),
    withdrawal_status: pick(lead, "consent", "withdrawalStatus"),
    confidence: conf(pick(lead, "consent", "confidence", "consentConfidence")),
  };
  const missing = [];
  if (!f.recipient || f.recipient !== recipient) missing.push("recipient (muss dem Empfänger entsprechen)");
  if (!f.consent_source) missing.push("consent_source");
  if (!pastDate(f.consent_date, now)) missing.push("consent_date");
  if (!f.consent_scope) missing.push("consent_scope");
  else if (!SERVICE_RE.test(f.consent_scope)) missing.push("consent_scope deckt Website-Leistungen nicht ab");
  if (!f.evidence) missing.push("evidence");
  if (f.obtained_before_marketing_send !== true) missing.push("obtained_before_marketing_send");
  if (f.withdrawal_status !== "active") missing.push(`withdrawal_status=${f.withdrawal_status ?? "fehlt"}`);
  if (PUBLIC_SOURCE_RE.test(`${f.consent_source} ${f.evidence}`)) missing.push("Quelle ist öffentlich/Annahme – keine Einwilligung");
  return { kind: "EXPLICIT_OPT_IN", confidence: f.confidence, missing, evidence: [{ type: "explicit_opt_in", ...f }] };
}

function checkCustomer(lead, recipient, now) {
  const basis = pick(lead, "customer", "basis", "consentBasis");
  if (!["existing_customer", "existing_customer_similar_service", "EXISTING_CUSTOMER_SIMILAR_SERVICE"].includes(basis)) return null;
  const f = {
    customer_relationship_evidence: text(pick(lead, "customer", "customerRelationshipEvidence", "relationshipEvidence")),
    relationship_date: pick(lead, "customer", "relationshipDate"),
    previous_service: text(pick(lead, "customer", "previousService")),
    advertised_service: text(pick(lead, "customer", "advertisedService")),
    similarity_rationale: text(pick(lead, "customer", "similarityRationale")),
    email_source: text(pick(lead, "customer", "emailSource", "customerEmailSource")),
    opt_out_status: pick(lead, "customer", "optOutStatus"),
    same_provider: pick(lead, "customer", "sameProvider"),
    confidence: conf(pick(lead, "customer", "confidence", "customerConfidence")),
  };
  const missing = [];
  if (lead.existingCustomer !== true && pick(lead, "customer", "existingCustomer") !== true) missing.push("existingCustomer");
  if (lead.similarService !== true && pick(lead, "customer", "similarService") !== true) missing.push("similarService");
  if (!f.customer_relationship_evidence) missing.push("customer_relationship_evidence");
  if (!pastDate(f.relationship_date, now)) missing.push("relationship_date");
  if (!f.previous_service || !SERVICE_RE.test(f.previous_service)) missing.push("previous_service (frühere Website-Leistung)");
  if (!f.advertised_service || !SERVICE_RE.test(f.advertised_service)) missing.push("advertised_service (Website-Leistung)");
  if (!f.similarity_rationale) missing.push("similarity_rationale");
  if (!f.email_source || PUBLIC_SOURCE_RE.test(f.email_source)) missing.push("email_source (muss aus der Kundenbeziehung stammen)");
  if (f.same_provider !== true) missing.push("same_provider (Leistung von Helvetic Webdesign selbst)");
  if (f.opt_out_status !== "none") missing.push(`opt_out_status=${f.opt_out_status ?? "fehlt"}`);
  if (PUBLIC_SOURCE_RE.test(f.customer_relationship_evidence)) missing.push("Beleg ist öffentlich/Annahme");
  return { kind: "EXISTING_CUSTOMER_SIMILAR_SERVICE", confidence: f.confidence, missing, evidence: [{ type: "existing_customer_similar_service", recipient, ...f }] };
}

function checkRequest(lead, scope, now) {
  if (!["requested_contact", "REQUESTED_CONTACT"].includes(pick(lead, "request", "basis", "consentBasis"))) return null;
  const f = {
    request_source: text(pick(lead, "request", "requestSource", "source")),
    request_date: pick(lead, "request", "requestDate", "date"),
    request_scope: text(pick(lead, "request", "requestScope", "scope")),
    request_evidence: text(pick(lead, "request", "requestEvidence", "evidence")),
    response_scope: text(pick(lead, "request", "responseScope")),
    recipient_or_submission_channel: text(pick(lead, "request", "recipientOrSubmissionChannel")),
    confidence: conf(pick(lead, "request", "requestConfidence", "confidence")),
  };
  const missing = [];
  for (const k of ["request_source", "request_scope", "request_evidence", "response_scope", "recipient_or_submission_channel"]) if (!f[k]) missing.push(k);
  if (!pastDate(f.request_date, now)) missing.push("request_date");
  if (f.request_scope && !SERVICE_RE.test(f.request_scope)) missing.push("request_scope passt nicht zur Leistung");
  if (f.response_scope && !SERVICE_RE.test(f.response_scope)) missing.push("response_scope ausserhalb der Anfrage");
  if (scope && !SERVICE_RE.test(scope)) missing.push("Nachricht ausserhalb des angefragten Umfangs");
  if (GENERIC_INVITE_RE.test(`${f.request_source} ${f.request_evidence}`)) missing.push("nur allgemeine Einladung, keine konkrete Anfrage");
  if (PUBLIC_SOURCE_RE.test(`${f.request_source} ${f.request_evidence}`)) missing.push("Quelle ist öffentlich/Annahme – keine Anfrage");
  return { kind: "REQUESTED_CONTACT", confidence: f.confidence, missing, evidence: [{ type: "requested_contact", ...f }] };
}

function checkRfp(lead, scope, now) {
  if (!["active_rfp", "ACTIVE_RFP", "ACTIVE_RFP_RESPONSE"].includes(pick(lead, "rfp", "basis", "consentBasis"))) return null;
  const f = {
    rfp_url: text(pick(lead, "rfp", "rfpUrl", "url")), rfp_date: pick(lead, "rfp", "rfpDate", "date"), rfp_scope: text(pick(lead, "rfp", "rfpScope", "scope")),
    submission_channel: text(pick(lead, "rfp", "submissionChannel")), deadline: pick(lead, "rfp", "deadline"), exact_evidence: text(pick(lead, "rfp", "exactEvidence", "evidence")),
    service_match: pick(lead, "rfp", "serviceMatch"), still_active: pick(lead, "rfp", "stillActive"), confidence: conf(pick(lead, "rfp", "rfpConfidence", "confidence")),
  };
  const missing = [];
  for (const k of ["rfp_url", "rfp_scope", "submission_channel", "exact_evidence"]) if (!f[k]) missing.push(k);
  if (!/^https?:\/\//i.test(f.rfp_url)) missing.push("rfp_url");
  if (!pastDate(f.rfp_date, now)) missing.push("rfp_date");
  const dl = Date.parse(f.deadline);
  if (!Number.isFinite(dl)) missing.push("deadline");
  else if (dl <= +now) missing.push("Ausschreibung abgelaufen");
  if (f.still_active !== true) missing.push("still_active");
  if (f.service_match !== true || !SERVICE_RE.test(f.rfp_scope)) missing.push("service_match (Website-Leistung ausdrücklich gesucht)");
  if (scope && !SERVICE_RE.test(scope)) missing.push("Nachricht ausserhalb des Ausschreibungsumfangs");
  if (GENERIC_INVITE_RE.test(`${f.exact_evidence} ${f.rfp_scope}`)) missing.push("nur allgemeine Einladung, keine konkrete Ausschreibung");
  return { kind: "ACTIVE_RFP_RESPONSE", confidence: f.confidence, missing, evidence: [{ type: "active_rfp", ...f }] };
}

const blockedRecipient = (lead, message) => {
  const st = String(lead?.status || "");
  return message?.suppressed === true || lead?.suppressed === true || lead?.do_not_contact === true || st === "suppressed" || st === "do_not_contact";
};

// message: { type: "MARKETING" | "SOLICITED_RESPONSE" | "TRANSACTIONAL" | "COLD_DRAFT", recipient?, scope?, transaction_ref? }
export function evaluateSwissEmailPermission(lead = {}, message = {}, now = new Date()) {
  const type = String(message.type || "MARKETING").toUpperCase();
  const recipient = norm(message.recipient || lead.email || "");
  if (!recipient) return deny("BLOCKED", "NONE", "HIGH", "Kein Empfänger.");
  if (blockedRecipient(lead, message)) return deny("BLOCKED", "NONE", "HIGH", "Empfänger gesperrt (Opt-out/Suppression/do_not_contact).");

  if (type === "COLD_DRAFT") return deny("DRAFT_ONLY", "NONE", "HIGH", "COLD_LEAD_DRAFT_ONLY: nur Gmail-Entwurf; Versand ausschliesslich manuell durch Chris, ohne Rechtsgrundlage.");
  if (type === "TRANSACTIONAL") {
    return message.transaction_ref ? allow("TRANSACTIONAL", "NONE", [{ type: "transaction", ref: String(message.transaction_ref) }], "Transaktionale Nachricht zu einem bestehenden Vorgang.")
      : deny("BLOCKED", "NONE", "LOW", "Transaktional nur mit Vorgangsbezug.");
  }
  const decide = (checks, cls, label) => {
    const found = checks.filter(Boolean);
    const ok = found.find((c) => c.confidence === "HIGH" && !c.missing.length);
    if (ok) return allow(cls, ok.kind, ok.evidence, `${label}: ${ok.kind} vollständig belegt (HIGH).`);
    if (!found.length) return deny("BLOCKED", "NONE", "LOW", `${label}: keine dokumentierte Grundlage.`);
    const c = found[0];
    const why = [...(c.confidence !== "HIGH" ? [`Vertrauen ${c.confidence}`] : []), ...c.missing];
    return deny("BLOCKED", "NONE", c.confidence === "HIGH" ? "LOW" : c.confidence, `${label}: ${c.kind} unzureichend – ${why.join("; ")}.`, c.evidence);
  };
  if (type === "MARKETING") return decide([checkOptIn(lead, recipient, now), checkCustomer(lead, recipient, now)], "MARKETING", "Marketing");
  if (type === "SOLICITED_RESPONSE") return decide([checkRequest(lead, message.scope, now), checkRfp(lead, message.scope, now)], "SOLICITED_RESPONSE", "Angefragte Antwort");
  return deny("BLOCKED", "NONE", "LOW", `Unbekannter Nachrichtentyp ${type}.`);
}
