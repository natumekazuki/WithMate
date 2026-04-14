import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageRichText } from "../../src/MessageRichText.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
  assert.match(html, /<button class="message-inline-link" type="button" title="src\/App\.tsx">file<\/button>/);
});

test("MessageRichText は先頭空白付き Markdown 行でも停止せずに render できる", () => {
  const input = ["  # title", "", "  - item", "  1. first", "", "  ```ts", "const answer = 42;", "  ```"].join("\n");
  const script = `
    import React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { MessageRichText } from "./src/MessageRichText.tsx";

    const html = renderToStaticMarkup(React.createElement(MessageRichText, { text: ${JSON.stringify(input)} }));
    console.log(html);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 2_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /<h3 class="message-heading level-1">title<\/h3>/);
  assert.match(result.stdout, /<ul class="message-list"><li>item<\/li><\/ul>/);
  assert.match(result.stdout, /<ol class="message-list ordered"><li>first<\/li><\/ol>/);
  assert.match(result.stdout, /<pre class="message-code-block"><code>const answer = 42;<\/code><\/pre>/);
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
    /<ul class="message-list"><li><button class="message-inline-link" type="button" title="src\/App\.tsx">file<\/button><\/li><li><code class="message-inline-code">literal<\/code><\/li><\/ul>/,
  );
  assert.match(html, /<ol class="message-list ordered"><li><strong class="message-inline-strong">step<\/strong><\/li><\/ol>/);
  assert.match(html, /<p class="message-paragraph">tail paragraph<\/p>/);
});
