"""Jarvis: minimaler Geld-Agent. Bringt Ideen, plant, handelt nie ohne Freigabe.

Setup: pip install anthropic && export ANTHROPIC_API_KEY=...
Start: python jarvis/jarvis.py
"""
import json
import pathlib

import anthropic

MEMORY = pathlib.Path(__file__).with_name("memory.json")
SYSTEM = """Du bist Jarvis, ein knallharter Geschäftspartner. Ziel: echtes, legales Einkommen für deinen Nutzer.
Regeln:
- Jede Idee mit: Zielkunde, Angebot, Preis, erster Schritt heute, Kosten, realistischer Umsatz in 30 Tagen.
- Hinterfrage Annahmen des Nutzers kritisch, keine Bestätigung ohne Begründung.
- Du führst nichts selbst aus; du lieferst konkrete Aufgaben, Texte und Entwürfe zur Freigabe.
- Kein Betrug, kein Spam, keine Finanzversprechen. Antworte auf Deutsch, kurz."""


def load():
    return json.loads(MEMORY.read_text()) if MEMORY.exists() else []


def main():
    client = anthropic.Anthropic()
    history = load()
    print("Jarvis bereit. 'ideen' für Vorschläge, 'exit' zum Beenden.")
    while (user := input("> ").strip()) != "exit":
        if user == "ideen":
            user = "Bring mir 3 neue Geldideen passend zu allem, was du über mich weißt."
        history.append({"role": "user", "content": user})
        reply = client.messages.create(
            model="claude-opus-5-5",
            max_tokens=2000,
            system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
            messages=history[-40:],
        ).content[0].text
        print(reply)
        history.append({"role": "assistant", "content": reply})
        MEMORY.write_text(json.dumps(history, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
