import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useConversationComposerState } from "../../src/chat/use-conversation-composer-state.js";
import type { ComposerPreview } from "../../src/app-state.js";

const attachmentPreview: ComposerPreview = {
  attachments: [{
    id: "attachment-a", kind: "file", source: "text", absolutePath: "/workspace/a.txt",
    displayPath: "a.txt", workspaceRelativePath: "a.txt", isOutsideWorkspace: false,
  }],
  errors: ["a.txt is unavailable"],
};

async function mountComposer() {
  const dom = new JSDOM("<div id='root'></div>");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let state!: ReturnType<typeof useConversationComposerState>;
  function Probe({ id, draft }: { id: string; draft: string }) {
    state = useConversationComposerState(id, draft);
    return null;
  }
  return {
    get state() { return state as ReturnType<typeof useConversationComposerState>; },
    async render(id: string, draft: string) {
      await act(async () => root.render(React.createElement(Probe, { id, draft })));
    },
    async unmount() {
      await act(async () => root.unmount());
      Object.assign(globalThis, { window: previousWindow, document: previousDocument });
      dom.window.close();
    },
  };
}

// @test-value v2
// kind = "invariant"
// claim = "draft変更時に古い添付errorを解除し、古いdraft向けの遅延previewを再適用しない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 各会話の入力状態と非同期結果の分離" }
// fault = "修正したdraftに古いpreview errorが残り送信を妨げる"
// observable = "draft変更後とMain/Auxiliary切替後のpreview.errors/attachments"
// observation_boundary = "component-behavior"
// scope = "shared-conversation-composer"
// lifecycle = "permanent"
// @end-test-value
test("Agent composer は draft 変更時に stale preview errors を clear する", async () => {
  const view = await mountComposer();
  try {
    await view.render("main", "@a.txt");
    const stalePreview = view.state.setPreview;
    await act(async () => stalePreview(attachmentPreview));
    await view.render("main", "corrected");
    assert.deepEqual(view.state.preview, { attachments: [], errors: [] });
    await act(async () => stalePreview(attachmentPreview));
    assert.deepEqual(view.state.preview, { attachments: [], errors: [] });

    await view.render("aux", "aux draft");
    const auxiliaryPreview = { attachments: [], errors: ["auxiliary warning"] } satisfies ComposerPreview;
    await act(async () => view.state.setPreview(auxiliaryPreview));
    await view.render("main", "corrected");
    assert.deepEqual(view.state.preview, { attachments: [], errors: [] });
    await view.render("aux", "aux draft");
    assert.deepEqual(view.state.preview, auxiliaryPreview);
  } finally {
    await view.unmount();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Companion composerも会話IDごとのpreview状態を保持する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 会話IDごとのdraft・添付・caret所有" }
// fault = "Mainの遅延previewがCompanionの入力状態へ混入する"
// observable = "Companion Main/Auxiliary切替後のpreview.attachments/errors"
// observation_boundary = "component-behavior"
// scope = "shared-conversation-composer"
// lifecycle = "permanent"
// @end-test-value
test("Companion composer は draft 変更時に stale preview errors を clear する", async () => {
  const view = await mountComposer();
  try {
    await view.render("companion-main", "draft");
    const staleMainPreview = view.state.setPreview;
    await act(async () => staleMainPreview(attachmentPreview));
    await view.render("companion-main", "corrected");
    await view.render("companion-aux", "draft");
    const auxiliaryPreview = { attachments: [], errors: ["auxiliary warning"] } satisfies ComposerPreview;
    await act(async () => view.state.setPreview(auxiliaryPreview));
    await act(async () => staleMainPreview({ attachments: [], errors: ["stale main"] }));
    assert.deepEqual(view.state.preview, auxiliaryPreview);
    await view.render("companion-main", "corrected");
    assert.deepEqual(view.state.preview, { attachments: [], errors: [] });
  } finally {
    await view.unmount();
  }
});
