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
  assert.match(html, /<button class="message-inline-link" type="button" title="src\/App\.tsx">file<\/button>/);
});
