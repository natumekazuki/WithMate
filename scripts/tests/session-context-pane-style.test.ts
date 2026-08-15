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

test("Session header menu は固定高の Header Dock に切られず中央領域へ重ねて表示する", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.session-header-dock-slot\s*{\s*position:\s*relative;\s*z-index:\s*30;\s*overflow:\s*visible;\s*}/,
  );
  assert.match(
    stylesSource,
    /\.session-action-dock-slot\s*{\s*overflow:\s*hidden;\s*}/,
  );
});

test("selection action overlay は Session layout の stacking context 内で surface と modal の間を所有する", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.session-chat-layout\s*{[\s\S]*?isolation:\s*isolate;[\s\S]*?}/,
  );
  assert.match(
    stylesSource,
    /\.session-selection-action-overlay\s*{\s*position:\s*fixed;\s*z-index:\s*35;\s*inset:\s*0;\s*pointer-events:\s*none;\s*}/,
  );
  assert.match(
    stylesSource,
    /\.message-response-actions\s*{[\s\S]*?position:\s*fixed;[\s\S]*?pointer-events:\s*auto;[\s\S]*?}/,
  );
});

test("左右ペインは固定 track 構成の幅と内容を滑らかに開閉する", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.session-chat-layout\.layout-priority-side-pane\s*{[\s\S]*?grid-template-columns:[\s\S]*?var\(--session-left-pane-track-width\)[\s\S]*?minmax\(0,\s*1fr\)[\s\S]*?var\(--session-right-pane-track-width\)[\s\S]*?}/,
  );
  assert.match(
    stylesSource,
    /\.session-left-pane-slot\.is-hidden,\s*\.session-right-pane-slot\.is-hidden\s*{[\s\S]*?visibility:\s*hidden;[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;/,
  );
  assert.match(
    stylesSource,
    /@media \(max-width:\s*1399\.98px\)\s*{[\s\S]*?\.session-dock-splitter\.edge-left,[\s\S]*?\.session-dock-splitter\.edge-right\s*{[\s\S]*?display:\s*block;[\s\S]*?cursor:\s*pointer;[\s\S]*?}/,
  );
  assert.match(
    stylesSource,
    /@media \(max-width:\s*1399\.98px\)\s*{[\s\S]*?\.session-dock-splitter\.edge-left\.is-static,[\s\S]*?\.session-dock-splitter\.edge-right\.is-static\s*{\s*display:\s*none;\s*}/,
  );
  assert.match(
    stylesSource,
    /@media \(max-width:\s*1399\.98px\)\s*{[\s\S]*?\.session-chat-layout\.layout-priority-side-pane,[\s\S]*?grid-template-areas:\s*"header"\s*"top-split"\s*"left-pane"\s*"left-split"\s*"main"\s*"right-split"\s*"right-pane"\s*"bottom-split"\s*"action-dock";/,
  );
  assert.match(
    stylesSource,
    /\.session-chat-layout\.layout-priority-side-pane\.is-left-pane-visible,[\s\S]*?grid-template-areas:\s*"header"\s*"top-split"\s*"left-pane"\s*"left-split"\s*"main"\s*"right-split"\s*"right-pane"\s*"bottom-split"\s*"action-dock";/,
  );
  assert.match(
    stylesSource,
    /\.session-chat-layout\.layout-priority-side-pane\.is-right-pane-visible,[\s\S]*?grid-template-areas:\s*"header"\s*"top-split"\s*"left-pane"\s*"left-split"\s*"main"\s*"right-split"\s*"right-pane"\s*"bottom-split"\s*"action-dock";/,
  );
});

test("splitter が選んだ優先軸に応じて side pane または上下 dock を全長表示する", async () => {
  const [componentSource, chatWindowSource, sessionProjectionSource, companionProjectionSource, stylesSource] = await Promise.all([
    readFile("src/session-components.tsx", "utf8"),
    readFile("src/chat/chat-window.tsx", "utf8"),
    readFile("src/chat/session-chat-projection.tsx", "utf8"),
    readFile("src/chat/companion-chat-projection.tsx", "utf8"),
    readFile("src/styles.css", "utf8"),
  ]);

  assert.match(componentSource, /layout-priority-\$\{[\s\S]*?layoutPriority === "side-pane-first" \? "side-pane" : "dock"/);
  assert.match(componentSource, /session-chat-layout[\s\S]*?is-left-pane-visible[\s\S]*?is-right-pane-visible/);
  assert.match(componentSource, /session-header-dock-slot.*?is-hidden[\s\S]*?aria-hidden={!isHeaderVisible}/);
  assert.doesNotMatch(componentSource, /className="session-header-dock-slot"\s+hidden=/);
  assert.match(stylesSource, /\.session-chat-layout\.layout-priority-side-pane\s*{[\s\S]*?"left-pane left-split header right-split right-pane"[\s\S]*?"left-pane left-split action-dock right-split right-pane"/);
  assert.match(stylesSource, /\.session-chat-layout\.layout-priority-dock\s*{[\s\S]*?"header header header header header"[\s\S]*?"action-dock action-dock action-dock action-dock action-dock"/);
  assert.match(stylesSource, /\.session-chat-layout\s*{[\s\S]*?grid-template-rows:[\s\S]*?var\(--session-header-dock-row-height\)[\s\S]*?minmax\(280px, 1fr\)[\s\S]*?var\(--session-action-dock-row-height\);/);
  assert.match(stylesSource, /\.session-chat-layout\.is-header-visible\s*{[\s\S]*?--session-header-dock-row-height:\s*64px;/);
  assert.match(
    stylesSource,
    /\.session-chat-layout\.is-action-dock-expanded\s*{[\s\S]*?--session-action-dock-row-height:\s*max\([\s\S]*?min\([\s\S]*?var\(--session-action-dock-height, 320px\),[\s\S]*?40dvh,[\s\S]*?calc\(100dvh - var\(--session-header-dock-row-height\) - 342px\)/,
  );
  assert.match(chatWindowSource, /session-action-dock-content session-action-dock-expanded-content/);
  assert.match(stylesSource, /\.session-action-dock-slot\.is-expanded \.composer > :not\(\.composer-input-row\)\s*{[\s\S]*?flex:\s*0 0 auto;/);
  assert.match(stylesSource, /\.session-action-dock-slot\.is-expanded \.composer-input-row\s*{[\s\S]*?flex:\s*1 1 auto;/);
  assert.match(stylesSource, /\.session-action-dock-slot\.is-expanded \.composer-box textarea\s*{[\s\S]*?height:\s*100%;[\s\S]*?resize:\s*none;/);
  assert.doesNotMatch(sessionProjectionSource, /isHeaderResizing|onStartHeaderResize/);
  assert.doesNotMatch(companionProjectionSource, /isHeaderResizing|onStartHeaderResize/);
});

test("splitter の枠は各 track に収まり、modal より背面に残る", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.session-chat-layout\s*{[\s\S]*?--session-dock-splitter-size:\s*20px;[\s\S]*?grid-template-rows:[\s\S]*?var\(--session-dock-splitter-size\)[\s\S]*?minmax\(280px,\s*1fr\)[\s\S]*?var\(--session-dock-splitter-size\);/,
  );
  assert.match(
    stylesSource,
    /\.session-chat-layout\.layout-priority-side-pane\s*{[\s\S]*?grid-template-columns:[\s\S]*?var\(--session-dock-splitter-size\)[\s\S]*?minmax\(0,\s*1fr\)[\s\S]*?var\(--session-dock-splitter-size\);/,
  );
  assert.match(
    stylesSource,
    /\.session-dock-splitter\.edge-left,[\s\S]*?\.session-dock-splitter\.edge-right\s*{[\s\S]*?width:\s*var\(--session-dock-splitter-size\);/,
  );
  assert.match(
    stylesSource,
    /\.session-dock-splitter\.edge-top,[\s\S]*?\.session-dock-splitter\.edge-bottom\s*{[\s\S]*?height:\s*var\(--session-dock-splitter-size\);/,
  );
  assert.match(
    stylesSource,
    /\.session-dock-splitter::before\s*{[\s\S]*?inset:\s*8px;/,
  );
  assert.match(
    stylesSource,
    /\.session-dock-splitter\.edge-top::before,[\s\S]*?\.session-dock-splitter\.edge-bottom::before\s*{[\s\S]*?inset:\s*8px;/,
  );
  assert.match(
    stylesSource,
    /\.session-dock-splitter-chevron\s*{[\s\S]*?box-sizing:\s*border-box;[\s\S]*?width:\s*12px;[\s\S]*?height:\s*24px;/,
  );
  assert.match(
    stylesSource,
    /\.session-dock-splitter\.edge-top \.session-dock-splitter-chevron,\s*\.session-dock-splitter\.edge-bottom \.session-dock-splitter-chevron\s*{\s*width:\s*24px;\s*height:\s*12px;/,
  );
  assert.match(
    stylesSource,
    /\.launch-modal,\s*\.diff-modal\s*{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*40;/,
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

  assert.match(componentSource, /layout-priority-\$\{[\s\S]*?layoutPriority === "side-pane-first" \? "side-pane" : "dock"/);
  assert.match(componentSource, /session-chat-layout[\s\S]*?is-left-pane-visible[\s\S]*?is-right-pane-visible/);
  assert.match(componentSource, /session-header-dock-slot.*?is-hidden[\s\S]*?aria-hidden={!isHeaderVisible}/);
  assert.doesNotMatch(componentSource, /className="session-header-dock-slot"\s+hidden=/);
  assert.match(stylesSource, /\.session-chat-layout\.layout-priority-side-pane\s*{[\s\S]*?"left-pane left-split header right-split right-pane"[\s\S]*?"left-pane left-split action-dock right-split right-pane"/);
  assert.match(stylesSource, /\.session-chat-layout\.layout-priority-dock\s*{[\s\S]*?"header header header header header"[\s\S]*?"action-dock action-dock action-dock action-dock action-dock"/);
  assert.match(stylesSource, /\.session-chat-layout\s*{[\s\S]*?grid-template-rows:[\s\S]*?var\(--session-header-dock-row-height\)[\s\S]*?minmax\(280px, 1fr\)[\s\S]*?var\(--session-action-dock-row-height\);/);
  assert.match(stylesSource, /\.session-chat-layout\.is-header-visible\s*{[\s\S]*?--session-header-dock-row-height:\s*64px;/);
  assert.match(
    stylesSource,
    /\.session-chat-layout\.is-action-dock-expanded\s*{[\s\S]*?--session-action-dock-row-height:\s*max\([\s\S]*?min\([\s\S]*?var\(--session-action-dock-height, 320px\),[\s\S]*?40dvh,[\s\S]*?calc\(100dvh - var\(--session-header-dock-row-height\) - 342px\)/,
  );
  assert.match(chatWindowSource, /session-action-dock-content session-action-dock-expanded-content/);
  assert.match(stylesSource, /\.session-action-dock-slot\.is-expanded \.composer > :not\(\.composer-input-row\)\s*{[\s\S]*?flex:\s*0 0 auto;/);
  assert.match(stylesSource, /\.session-action-dock-slot\.is-expanded > \.session-action-dock\s*{\s*overflow:\s*hidden;/);
  assert.match(stylesSource, /\.session-action-dock-slot\.is-expanded \.composer-input-row\s*{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-height:\s*0;/);
  assert.match(stylesSource, /\.session-action-dock-slot\.is-expanded \.composer-box textarea\s*{[\s\S]*?height:\s*100%;[\s\S]*?overflow-y:\s*auto;[\s\S]*?resize:\s*none;/);
  assert.doesNotMatch(sessionProjectionSource, /isHeaderResizing|onStartHeaderResize/);
  assert.doesNotMatch(companionProjectionSource, /isHeaderResizing|onStartHeaderResize/);
});

test("固定高のSession Headerは操作群を折り返さずタイトルを残り幅へ収める", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");
  const controlsRule = stylesSource.match(/\.session-window-controls\s*{([^}]*)}/)?.[1] ?? "";
  const titleRule = stylesSource.match(/\.session-title-shell\s*{([^}]*)}/)?.[1] ?? "";

  assert.match(stylesSource, /\.session-page \.session-top-bar\s*{\s*container-type:\s*inline-size;/);
  assert.match(controlsRule, /flex:\s*0 0 auto;/);
  assert.match(controlsRule, /flex-wrap:\s*nowrap;/);
  assert.match(titleRule, /flex:\s*1 1 0;/);
  assert.match(
    stylesSource,
    /@container \(max-width:\s*960px\)\s*{[\s\S]*?\.session-window-controls\s*{[\s\S]*?gap:\s*4px;[\s\S]*?\.session-window-control-group-label\s*{[\s\S]*?font-size:\s*0\.6rem;[\s\S]*?\.session-page \.session-window-control-group \.drawer-toggle\s*{[\s\S]*?font-size:\s*0\.75rem;/,
  );
});

test("Session 四辺の開閉は共通 motion を使い、resize 中と reduced-motion で補間を止める", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.session-chat-layout\s*{[\s\S]*?--session-dock-motion-duration:\s*220ms;[\s\S]*?--session-dock-motion-easing:\s*cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\);[\s\S]*?transition:[\s\S]*?grid-template-rows\s+var\(--session-dock-motion-duration\)/,
  );
  assert.match(
    stylesSource,
    /--session-action-dock-row-height:\s*var\(--session-action-dock-compact-height,\s*54px\);/,
  );
  assert.match(
    stylesSource,
    /\.session-chat-layout:has\(> \.session-dock-splitter\.edge-bottom\.is-active\)[\s\S]*?transition-duration:\s*0ms;/,
  );
  assert.match(
    stylesSource,
    /@media \(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*?\.session-chat-layout\s*{[\s\S]*?--session-dock-motion-duration:\s*0ms;/,
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
    /\.session-file-preview-loading,\s*\.session-file-preview-error,\s*\.session-file-preview-large-warning,\s*\.session-file-preview-metadata\s*{\s*grid-area:\s*content;/,
  );
  assert.match(stylesSource, /\.session-file-preview-feedback\s*{\s*grid-area:\s*feedback;/);
});

test("個別の file preview window は外周surfaceを保ちDiff本文だけをloading表示にする", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.file-preview-window-page\s*{[\s\S]*?background:\s*linear-gradient\(180deg,\s*#0f131a\s*0%,\s*#151a22\s*100%\);/,
  );
  assert.match(
    stylesSource,
    /\.file-preview-window-page\s*>\s*\.session-file-preview\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*0;/,
  );
  assert.match(stylesSource, /\.file-preview-loading-content\s*{[\s\S]*?grid-area:\s*content;/);
  assert.match(
    stylesSource,
    /\.session-file-preview-spinner\s*{[\s\S]*?width:\s*24px;[\s\S]*?animation:\s*session-file-preview-spin\s+720ms\s+linear\s+infinite;/,
  );
  assert.match(
    stylesSource,
    /@media \(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*?\.file-preview-loading-title,[\s\S]*?animation:\s*none;/,
  );
  assert.match(
    stylesSource,
    /@media \(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*?\.session-file-preview-spinner\s*{\s*animation:\s*none;/,
  );
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
    /\.session-file-markdown \.message-inline-code\s*{\s*background:\s*rgba\(255,\s*255,\s*255,\s*0\.08\);\s*color:\s*var\(--ink\);\s*}/,
  );
  assert.match(
    stylesSource,
    /\.session-file-markdown a \.message-inline-code\s*{\s*color:\s*inherit;\s*}/,
  );
  assert.match(
    stylesSource,
    /\.session-file-markdown \.message-mermaid-error\s*{\s*color:\s*var\(--session-file-error\);\s*}/,
  );
});

test("Markdown preview はchatと同じ本文line-heightとblock間隔を使う", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.message-body\.rich-text,\s*\.session-file-markdown\.rich-text\s*{[\s\S]*?display:\s*grid;[\s\S]*?gap:\s*8px;[\s\S]*?line-height:\s*1\.6;/,
  );
  assert.match(stylesSource, /\.message-paragraph\s*{[\s\S]*?margin:\s*0;[\s\S]*?line-height:\s*1\.6;/);
});

test("Markdown heading と thematic break は階層と全幅の区切りを視認できる", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(stylesSource, /\.message-heading\.level-1\s*{[\s\S]*?font-size:\s*1\.25rem;/);
  assert.match(stylesSource, /\.message-heading\.level-2\s*{[\s\S]*?font-size:\s*1\.125rem;/);
  assert.match(stylesSource, /\.message-heading\.level-3\s*{[\s\S]*?font-size:\s*1\.05rem;/);
  assert.match(stylesSource, /\.message-heading\.level-4\s*{[\s\S]*?font-size:\s*1rem;/);
  assert.match(stylesSource, /\.message-heading\.level-5\s*{[\s\S]*?font-size:\s*0\.95rem;/);
  assert.match(stylesSource, /\.message-heading\.level-6\s*{[\s\S]*?font-size:\s*0\.9rem;/);
  assert.match(
    stylesSource,
    /\.message-divider\s*{[\s\S]*?width:\s*100%;[\s\S]*?border:\s*0;[\s\S]*?border-block-start:\s*1px solid var\(--line\);/,
  );
});

test("Markdown list はlogical paddingと階層ごとのmarkerを持つ", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.message-list\s*{[\s\S]*?padding-inline-start:\s*1\.5em;[\s\S]*?list-style-position:\s*outside;/,
  );
  assert.match(stylesSource, /\.message-list:not\(\.ordered\)\s*{\s*list-style-type:\s*disc;/);
  assert.match(
    stylesSource,
    /\.message-list \.message-list:not\(\.ordered\)\s*{\s*list-style-type:\s*circle;/,
  );
  assert.match(
    stylesSource,
    /\.message-list \.message-list \.message-list:not\(\.ordered\)\s*{\s*list-style-type:\s*square;/,
  );
  assert.match(stylesSource, /\.message-list\s*>\s*li::marker\s*{\s*color:\s*currentColor;/);
  assert.doesNotMatch(stylesSource, /\.message-list\s*{[^}]*padding-left:/);
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
