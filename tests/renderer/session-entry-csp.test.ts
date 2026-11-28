import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sessionEntryUrl = new URL("../../session.html", import.meta.url);

/** メタタグの CSP 本文から、検査対象ディレクティブの許可項目だけを分離する。 */
function readCspDirective(content: string, directiveName: string): string[] {
  const directive = content
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${directiveName} `));
  return directive?.split(/\s+/).slice(1) ?? [];
}

/** 実 Session HTML の CSP にある画像の許可ソースが、Markdown 用の HTTP と HTTPS の両方を含む。 */
test("Session Window CSP は Markdown の HTTP / HTTPS image を許可する", async () => {
  const html = await readFile(sessionEntryUrl, "utf8");
  const csp = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i,
  )?.[1];

  assert.ok(csp);
  const imageSources = readCspDirective(csp, "img-src");
  assert.ok(imageSources.includes("http:"));
  assert.ok(imageSources.includes("https:"));
});
