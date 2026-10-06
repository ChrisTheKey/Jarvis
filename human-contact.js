// Erkennt, ob ein Kunde ein Telefonat, einen Termin oder persönlichen Kontakt wünscht.
// Satzweise mit Kontext statt blosser Stichwörter: Es braucht eine Bitte/Frage UND ein Kontakt-Thema im selben Satz
// (oder eine eindeutige Formulierung wie „Rufen Sie mich an“). Verneinungen und Fachbegriffe („Call-to-Action“,
// „Mobilansicht auf dem Phone“) lösen keinen Alarm aus.

// Eindeutige Wünsche – lösen allein aus.
const DIRECT = [
  /\b(rufen|ruft) (sie|du|ihr) (mich|uns)\b[^.!?\n]*\ban\b/i,
  /\brückruf\b/i, /\bzurück ?rufen\b/i,
  /\b(kann|könnte|koennte) mich (jemand|wer|einer) (kontaktieren|anrufen|zurückrufen)\b/i,
  /\b(mit )?(jemandem|einem menschen|einer person) (persönlich )?(sprechen|reden)\b/i,
  /\b(meine|unsere) (telefon|handy|natel)?nummer (ist|lautet|:)/i, /\berreichen sie mich (unter|am|telefonisch|jederzeit)\b/i,
  /\b(ihre|eure|deine) (telefon|handy|natel)nummer\b/i,
  /\b(call|ring) (me|us)\b/i, /\bgive (me|us) a (call|ring)\b/i, /\bcall(ing)? (me|us) back\b/i, /\bcall ?back\b/i,
  /\b(speak|talk) (to|with) a (real |actual )?(person|human)\b/i, /\bhuman contact\b/i,
  /\b(schedule|book|set up|arrange|organi[sz]e) (a |an )?(quick |short |brief )?(phone |video |zoom |teams )?(call|meeting|chat)\b/i,
  /\blet'?s (talk|speak|meet|have a (quick )?call|hop on a call|jump on a call|schedule)\b/i,
];
// Bitte oder Frage
const ASK = /\?|\b(können|könnten|koennen|koennten|würden|wuerden|wollen|sollen|sollten|lass(en|t)? uns|gerne|gern|bitte|möchte|moechte|hätten sie|haetten sie|haben sie zeit|wäre es möglich|ist es möglich|can|could|would|shall|please|i'?d like|i would like|happy to|want to|is it possible|are you available|do you have time)\b/i;
// Kontakt-Thema (eng gefasst, damit „call“/„phone“ allein nicht reicht)
const TOPIC = /\b(telefonier\w*|telefonat\w*|telefonisch\w*|anruf\w*|anrufen|termin\w*|besprechung\w*|meeting\w*|persönlich(en)? (sprechen|besprechen|treffen|vorbeikommen|kennenlernen|gespräch)|kurz (sprechen|reden|austauschen|telefonieren)|mit ihnen (sprechen|reden)|ein gespräch|zu einem gespräch|treffen|(a|an|the|quick|short|brief|phone|video|zoom|teams) call|call (me|us|you)|on a call|meet(ing)?|speak with you|talk (with|to) you|phone call|on the phone)\b/i;
// Verneinung im Umfeld des Kontakt-Themas
const NEG = /\b(nicht|kein(e|en|er)?|nie|no need|don'?t|do not|never|without|ohne)\b[^.!?\n]{0,30}\b(anruf\w*|anrufen|telefon\w*|call\w*|meeting|termin\w*|treffen|sprechen|talk)\b|\b(anruf\w*|telefon\w*|call|meeting|termin)\b[^.!?\n]{0,25}\b(nicht nötig|nicht notwendig|unnötig|not needed|not necessary)\b/i;
// Fachbegriffe, die nichts mit Kontakt zu tun haben
const NOISE = /\b(call[- ]to[- ]action|cta|phone view|mobile phone|smartphone-?ansicht|handy-?ansicht|mobilansicht|telefonnummer auf (der|ihrer|unserer) (website|webseite|seite))\b/gi;

export function detectHumanContact(text = "") {
  const sentences = String(text).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  for (const raw of sentences) {
    const s = raw.replace(NOISE, " ");
    if (NEG.test(s)) continue;
    if (DIRECT.some((r) => r.test(s)) || (ASK.test(s) && TOPIC.test(s))) {
      const kind = /telefon|anruf|rückruf|zurück ?ruf|\brufen\b[^.!?]*\ban\b|call|phone|nummer|ring/i.test(s) ? "call"
        : /termin|meeting|meet|besprechung|treffen|vorbeikommen/i.test(s) ? "meeting" : "person";
      return { kind, sentence: raw.slice(0, 200) };
    }
  }
  return null;
}

export const KIND_TEXT = { call: "möchte telefonieren", meeting: "möchte einen Termin bzw. ein Treffen", person: "möchte persönlich mit Ihnen sprechen" };
