import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { ProcessRunOutputExporter } from "../../src/main/run-output-exporter.js";

const [helperPath, destination] = process.argv.slice(2);
if (helperPath === undefined || destination === undefined) throw new TypeError("Probe arguments are required.");

const controller = new AbortController();
const exporter = new ProcessRunOutputExporter({
  executablePath: process.execPath,
  helperUrl: pathToFileURL(helperPath),
  abortGraceMs: 50,
});
const abortTimer = setTimeout(() => controller.abort(), 250);
const startedAt = Date.now();

try {
  const result = await exporter.prepare(
    { kind: "explicit_absolute_path", authority: "cli_user_selection", absolutePath: destination },
    { byteLength: 0, contentSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex") },
    controller.signal,
  );
  process.stdout.write(`${JSON.stringify({ status: result.status, elapsedMs: Date.now() - startedAt })}\n`);
} finally {
  clearTimeout(abortTimer);
}
