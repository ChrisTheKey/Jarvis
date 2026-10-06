// Version der Jarvis-Persona: Prüfsumme über persona.md (Zeilenenden vereinheitlicht). Lokal und in der Cloud identisch.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PERSONA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "persona.md");
export const personaVersion = (md = fs.readFileSync(PERSONA_FILE, "utf8")) =>
  crypto.createHash("sha256").update(md.replace(/\r\n/g, "\n")).digest("hex").slice(0, 12);
