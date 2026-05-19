import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageRichText } from "../../src/MessageRichText.js";

test("MessageRichText は **bold** を strong として render する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: "plain **message** tail",
    }),
  );

  assert.match(html, /<strong class="message-inline-strong">message<\/strong>/);
});

test("MessageRichText は inline code と link を優先しつつ bold を併用できる", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: "`**literal**` and **bold [file](src/App.tsx)**",
    }),
  );

  assert.match(html, /<code class="message-inline-code">\*\*literal\*\*<\/code>/);
  assert.match(html, /<strong class="message-inline-strong">/);
  assert.match(html, /<a href="src\/App\.tsx">file<\/a>/);
});

test("MessageRichText は code literal 内の local path link 風テキストを改変しない", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "`[log](C:/tmp/log file.txt)`",
        "",
        "```txt",
        "[sample](meeting notes.md)",
        "```",
        "",
        "    [indented](meeting notes.md)",
        "\t[tabbed](meeting notes.md)",
      ].join("\n"),
    }),
  );

  assert.match(html, /<code class="message-inline-code">\[log\]\(C:\/tmp\/log file\.txt\)<\/code>/);
  assert.match(
    html,
    /<pre class="message-code-block"><code class="message-inline-code language-txt">\[sample\]\(meeting notes\.md\)\n<\/code><\/pre>/,
  );
  assert.match(html, /\[indented\]\(meeting notes\.md\)/);
  assert.match(html, /\[tabbed\]\(meeting notes\.md\)/);
});

test("MessageRichText は Markdown image を実画像として描画しない", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "![local](file:///C:/tmp/secret.png)",
        "![embedded](data:image/png;base64,AAAA)",
        "![remote](https://example.test/image.png)",
      ].join("\n"),
    }),
  );

  assert.doesNotMatch(html, /<img\b/);
  assert.doesNotMatch(html, /src=/);
  assert.doesNotMatch(html, /file:\/\/\/C:\/tmp\/secret\.png/);
  assert.doesNotMatch(html, /data:image\/png/);
  assert.doesNotMatch(html, /https:\/\/example\.test\/image\.png/);
});

test("MessageRichText は先頭空白付き Markdown 行でも停止せずに render できる", { timeout: 2_000 }, () => {
  const input = ["  # title", "", "  - item", "  1. first", "", "  ```ts", "const answer = 42;", "  ```"].join("\n");
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: input,
    }),
  );

  assert.match(html, /<h3 class="message-heading level-1">title<\/h3>/);
  assert.match(html, /<ul class="message-list">\s*<li>item<\/li>\s*<\/ul>/);
  assert.match(html, /<ol class="message-list ordered">\s*<li>first<\/li>\s*<\/ol>/);
  assert.match(html, /<pre class="message-code-block"><code class="message-inline-code language-ts">const answer = 42;\n<\/code><\/pre>/);
});

test("MessageRichText は先頭空白付き Markdown を既存 block と inline のまま扱う", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: ["  # **title**", "", "  - [file](src/App.tsx)", "  - `literal`", "", "  1. **step**", "", "tail paragraph"].join(
        "\n",
      ),
    }),
  );

  assert.match(html, /<h3 class="message-heading level-1"><strong class="message-inline-strong">title<\/strong><\/h3>/);
  assert.match(
    html,
    /<ul class="message-list">\s*<li><a href="src\/App\.tsx">file<\/a><\/li>\s*<li><code class="message-inline-code">literal<\/code><\/li>\s*<\/ul>/,
  );
  assert.match(html, /<ol class="message-list ordered">\s*<li><strong class="message-inline-strong">step<\/strong><\/li>\s*<\/ol>/);
  assert.match(html, /<p class="message-paragraph">tail paragraph<\/p>/);
});

test("MessageRichText は 4 文字以上インデントされた block marker を CommonMark の code block として扱う", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: ["    # not heading", "    - not list", "    1. not ordered", "    ```ts"].join("\n"),
    }),
  );

  assert.doesNotMatch(html, /message-heading/);
  assert.doesNotMatch(html, /<ul class="message-list">/);
  assert.doesNotMatch(html, /<ol class="message-list ordered">/);
  assert.match(
    html,
    /<pre class="message-code-block"><code class="message-inline-code"># not heading\n- not list\n1\. not ordered\n```ts\n<\/code><\/pre>/,
  );
});
