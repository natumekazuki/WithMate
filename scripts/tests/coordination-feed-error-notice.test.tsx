import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CoordinationFeedErrorNotice } from "../../src/session-components.js";

test("Coordination feed取得失敗はstale表示の説明と再試行操作を示す", () => {
  const html = renderToStaticMarkup(
    <CoordinationFeedErrorNotice
      message="表示中の情報は前回取得時点のものです。"
      onRetry={() => undefined}
    />,
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /前回取得時点/);
  assert.match(html, />再試行<\/button>/);
});
