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

test("左右ペイン非表示時は pane track を除き、splitter の再表示操作を残す", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.session-main-grid\s*{[\s\S]*?grid-template-columns:\s*12px\s*minmax\(0,\s*1fr\)\s*12px;/,
  );
  assert.match(
    stylesSource,
    /\.session-left-pane-slot\[hidden\],\s*\.session-right-pane-slot\[hidden\]\s*{\s*display:\s*none;\s*}/,
  );
  assert.match(
    stylesSource,
    /@media \(max-width:\s*1399\.98px\)\s*{[\s\S]*?\.session-workbench-splitter\s*{[\s\S]*?display:\s*block;[\s\S]*?cursor:\s*pointer;[\s\S]*?}/,
  );
  assert.match(
    stylesSource,
    /@media \(max-width:\s*1399\.98px\)\s*{[\s\S]*?\.session-workbench-splitter\.is-static\s*{\s*display:\s*none;\s*}/,
  );
});

test("file preview は条件付き find / feedback の有無にかかわらず本文を固定 scroll row に置く", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.session-file-preview\s*{[\s\S]*?grid-template-rows:\s*auto\s+auto\s+minmax\(0,\s*1fr\)\s+auto;[\s\S]*?grid-template-areas:\s*"header"\s*"find"\s*"content"\s*"feedback";/,
  );
  assert.match(stylesSource, /\.session-file-preview-header\s*{[\s\S]*?grid-area:\s*header;/);
  assert.match(stylesSource, /\.session-file-preview\s*>\s*\.session-content-find\s*{\s*grid-area:\s*find;/);
  assert.match(
    stylesSource,
    /\.session-file-text-scroll,\s*\.session-file-markdown-scroll,\s*\.session-file-image-scroll\s*{\s*grid-area:\s*content;/,
  );
  assert.match(
    stylesSource,
    /\.session-file-preview-status,\s*\.session-file-preview-error,\s*\.session-file-preview-large-warning,\s*\.session-file-preview-metadata\s*{\s*grid-area:\s*content;/,
  );
  assert.match(stylesSource, /\.session-file-preview-feedback\s*{\s*grid-area:\s*feedback;/);
});
