import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readRendererSource(fileName: "App.tsx" | "CompanionReviewApp.tsx"): Promise<string> {
  return readFile(new URL(`../../src/${fileName}`, import.meta.url), "utf8");
}

test("Agent composer は draft 変更時に stale preview errors を clear する", async () => {
  const source = await readRendererSource("App.tsx");

  assert.match(
    source,
    /useEffect\(\(\) => \{\s*setComposerPreview\(createEmptyComposerPreview\(\)\);\s*\}, \[activeAuxiliarySession\?\.composerDraft, draft\]\);/,
  );
  assert.match(
    source,
    /resolveComposerSendabilityState\(\{\s*runState: selectedSessionRunState,\s*blockedReason: composerBlockedReason,\s*inputErrors: composerPreview\.errors,/,
  );
});

test("Companion composer は draft 変更時に stale preview errors を clear する", async () => {
  const source = await readRendererSource("CompanionReviewApp.tsx");

  assert.match(
    source,
    /useEffect\(\(\) => \{\s*setComposerPreview\(createEmptyComposerPreview\(\)\);\s*\}, \[activeAuxiliarySession\?\.composerDraft, composerText\]\);/,
  );
  assert.match(
    source,
    /resolveComposerSendabilityState\(\{\s*runState: selectedSessionRunState,\s*blockedReason: companionComposerBlockedReason,\s*inputErrors: composerPreview\.errors,/,
  );
});
