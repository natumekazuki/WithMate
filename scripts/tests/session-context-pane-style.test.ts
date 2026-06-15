import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Reasoning live details は内側 pre スクロールを作らない", async () => {
  const [componentSource, stylesSource] = await Promise.all([
    readFile("src/session-components.tsx", "utf8"),
    readFile("src/styles.css", "utf8"),
  ]);

  assert.match(
    componentSource,
    /className="command-monitor-details live-run-step-details live-reasoning-details"/,
  );
  assert.match(
    stylesSource,
    /\.live-reasoning-details pre\s*{\s*max-height:\s*none;\s*overflow:\s*visible;\s*}/,
  );
});

test("Command details は長い command と single-line result を折り返せる", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.live-run-command-text\s*{[\s\S]*?display:\s*block;[\s\S]*?min-width:\s*0;[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?word-break:\s*break-word;[\s\S]*?}/,
  );
  assert.match(
    stylesSource,
    /\.live-run-step-details summary\s*{[\s\S]*?min-width:\s*0;[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?word-break:\s*break-word;[\s\S]*?}/,
  );
  assert.match(
    stylesSource,
    /\.live-run-step-details pre\s*{[\s\S]*?min-width:\s*0;[\s\S]*?white-space:\s*pre-wrap;[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?word-break:\s*break-word;[\s\S]*?}/,
  );
});

test("Artifact result details は長い path と本文を折り返せる", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.session-page \.artifact-file-meta code\s*{[\s\S]*?white-space:\s*normal;[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?word-break:\s*break-word;[\s\S]*?}/,
  );
  assert.match(
    stylesSource,
    /\.session-page \.artifact-operation-item p,\s*\.session-page \.artifact-operation-item pre,\s*\.session-page \.artifact-operation-message\s*{[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?word-break:\s*break-word;[\s\S]*?}/,
  );
  assert.match(
    stylesSource,
    /\.session-page \.artifact-operation-item pre\s*{[\s\S]*?white-space:\s*pre-wrap;[\s\S]*?}/,
  );
});
