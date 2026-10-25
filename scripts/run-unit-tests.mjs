// npm test: Unit-Suite (node --test) in einem eigenen Temp-Verzeichnis, das danach vollständig entfernt wird (scripts/test-temp.mjs).
// Weitere Argumente werden an node --test durchgereicht (z. B. einzelne Testdateien).
import fs from "node:fs";
import path from "node:path";
import { runIsolated } from "./test-temp.mjs";

function testFilesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? testFilesIn(file) : /\.test\.(?:c|m)?js$/.test(entry.name) ? [file] : [];
  });
}

const requestedArgs = process.argv.slice(2);
const requestedTests = requestedArgs.filter((arg) => !arg.startsWith("-") && fs.existsSync(arg));
const nodeOptions = requestedArgs.filter((arg) => !requestedTests.includes(arg));
const defaultTests = testFilesIn("test");
process.exit(runIsolated(["--test", ...nodeOptions, ...(requestedTests.length ? requestedTests : defaultTests)]));
