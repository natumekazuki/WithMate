import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { createWorkspaceExplorerAction } from "../../src/chat/chat-header-actions.js";

const noop = () => {};

test("createWorkspaceExplorerAction は共通の workspace Explorer action を描画する", () => {
  const html = renderToStaticMarkup(createWorkspaceExplorerAction({ onOpenExplorer: noop }));

  assert.match(html, /class="drawer-toggle compact secondary"/);
  assert.match(html, /type="button"/);
  assert.match(html, />Explorer<\/button>/);
  assert.doesNotMatch(html, /disabled/);
});

test("createWorkspaceExplorerAction は disabled state を反映する", () => {
  const html = renderToStaticMarkup(createWorkspaceExplorerAction({
    disabled: true,
    onOpenExplorer: noop,
  }));

  assert.match(html, /disabled=""/);
});
