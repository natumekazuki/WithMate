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
    /@media \(max-width:\s*1399\.98px\)\s*{[\s\S]*?\.session-dock-splitter\.edge-left,[\s\S]*?\.session-dock-splitter\.edge-right\s*{[\s\S]*?display:\s*block;[\s\S]*?cursor:\s*pointer;[\s\S]*?}/,
  );
  assert.match(
    stylesSource,
    /@media \(max-width:\s*1399\.98px\)\s*{[\s\S]*?\.session-dock-splitter\.edge-left\.is-static,[\s\S]*?\.session-dock-splitter\.edge-right\.is-static\s*{\s*display:\s*none;\s*}/,
  );
});

test("Header と ActionDock は中央・左右ペインの外側に全幅 dock として配置する", async () => {
  const [componentSource, chatWindowSource, sessionProjectionSource, companionProjectionSource, stylesSource] = await Promise.all([
    readFile("src/session-components.tsx", "utf8"),
    readFile("src/chat/chat-window.tsx", "utf8"),
    readFile("src/chat/session-chat-projection.tsx", "utf8"),
    readFile("src/chat/companion-chat-projection.tsx", "utf8"),
    readFile("src/styles.css", "utf8"),
  ]);

  assert.match(componentSource, /session-header-dock-slot[\s\S]*?session-content-grid[\s\S]*?session-action-dock-slot/);
  assert.match(componentSource, /session-chat-layout[\s\S]*?is-header-visible[\s\S]*?is-action-dock-expanded/);
  assert.match(componentSource, /session-header-dock-slot.*?is-hidden[\s\S]*?aria-hidden={!isHeaderVisible}/);
  assert.doesNotMatch(componentSource, /className="session-header-dock-slot"\s+hidden=/);
  assert.match(stylesSource, /\.session-chat-layout\s*{[\s\S]*?grid-template-rows:[\s\S]*?var\(--session-header-dock-row-height\)[\s\S]*?minmax\(280px, 1fr\)[\s\S]*?var\(--session-action-dock-row-height\);/);
  assert.match(stylesSource, /\.session-chat-layout\.is-header-visible\s*{[\s\S]*?--session-header-dock-row-height:\s*64px;/);
  assert.match(
    stylesSource,
    /\.session-chat-layout\.is-action-dock-expanded\s*{[\s\S]*?--session-action-dock-row-height:\s*max\([\s\S]*?min\([\s\S]*?var\(--session-action-dock-height, 320px\),[\s\S]*?40dvh,[\s\S]*?calc\(100dvh - var\(--session-header-dock-row-height\) - 326px\)/,
  );
  assert.match(chatWindowSource, /className="session-action-dock-expanded-content"/);
  assert.match(stylesSource, /\.session-action-dock-slot\.is-expanded \.composer > :not\(\.composer-input-row\)\s*{[\s\S]*?flex:\s*0 0 auto;/);
  assert.match(stylesSource, /\.session-action-dock-slot\.is-expanded \.composer-input-row\s*{[\s\S]*?flex:\s*1 1 auto;/);
  assert.match(stylesSource, /\.session-action-dock-slot\.is-expanded \.composer-box textarea\s*{[\s\S]*?height:\s*100%;[\s\S]*?resize:\s*none;/);
  assert.doesNotMatch(sessionProjectionSource, /isHeaderResizing|onStartHeaderResize/);
  assert.doesNotMatch(companionProjectionSource, /isHeaderResizing|onStartHeaderResize/);
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

test("Markdown preview は暗いsurface上のlinkとMermaid errorへ高contrast色を使う", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.session-file-preview\s*{[\s\S]*?--session-file-link:\s*#93c5fd;[\s\S]*?--session-file-error:\s*#fca5a5;/,
  );
  assert.match(
    stylesSource,
    /\.session-file-markdown a,\s*\.session-file-markdown a:visited\s*{\s*color:\s*var\(--session-file-link\);\s*}/,
  );
  assert.match(
    stylesSource,
    /\.session-file-markdown \.message-mermaid-error\s*{\s*color:\s*var\(--session-file-error\);\s*}/,
  );
});

test("Markdown preview は中央本文を固定幅にせずcontent領域を使う", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.session-file-markdown-scroll\s*{\s*padding:\s*18px\s+10px\s+40px;\s*}/,
  );
  assert.match(
    stylesSource,
    /\.session-file-markdown\s*{\s*width:\s*100%;\s*max-width:\s*none;\s*margin:\s*0;\s*}/,
  );
});
