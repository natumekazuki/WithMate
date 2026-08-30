import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Glossary検索は新しいrevisionのresponseを待つ間に旧結果を表示しない", async () => {
  const source = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const effectStart = source.indexOf("const requestId = ++glossarySearchRequestIdRef.current;");
  const requestStart = source.indexOf("void withmateApi.searchSessionGlossary", effectStart);
  const clearEntries = source.indexOf("setGlossarySearchEntries([]);", effectStart);
  const clearTotal = source.indexOf("setGlossarySearchTotal(0);", effectStart);
  const revisionGuard = source.indexOf("isGlossarySearchRevisionCurrent(", requestStart);

  assert.notEqual(effectStart, -1);
  assert.ok(clearEntries > effectStart && clearEntries < requestStart);
  assert.ok(clearTotal > effectStart && clearTotal < requestStart);
  assert.ok(revisionGuard > requestStart);
});
