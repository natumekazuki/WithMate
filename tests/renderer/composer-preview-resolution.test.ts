import assert from "node:assert/strict";
import test from "node:test";

import {
  createComposerPreviewRequest,
  type ComposerPreviewRequestApi,
} from "../../src/chat/use-composer-preview-resolution.js";

function createApi(events: string[]): ComposerPreviewRequestApi {
  return {
    async previewComposerInput(sessionId, message) {
      events.push(`session:${sessionId}:${message}`);
      return { attachments: [], errors: [] };
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "preview対象Sessionまたはdesktop APIがない場合は要求を生成しない"
// oracle = { type = "contract", ref = "src/chat/use-composer-preview-resolution.ts#createComposerPreviewRequest" }
// fault = "対象未確定のpreview callbackが生成され誤ったSessionへ要求する"
// observable = "request生成結果のnullとAPI要求の不在"
// observation_boundary = "public-boundary"
// scope = "composer-preview-target-validation"
// lifecycle = "permanent"
// @end-test-value
test("createComposerPreviewRequest は api または session id がなければ null を返す", () => {
  const events: string[] = [];
  const api = createApi(events);

  assert.equal(createComposerPreviewRequest({ api: null, sessionId: "s1" }), null);
  assert.equal(createComposerPreviewRequest({ api, sessionId: null }), null);
  assert.deepEqual(events, []);
});

// @test-value v2
// kind = "contract"
// claim = "preview要求は指定Session IDと入力本文をAPIへ保持して渡す"
// oracle = { type = "contract", ref = "src/chat/use-composer-preview-resolution.ts#createComposerPreviewRequest" }
// fault = "preview要求先または本文を取り違える"
// observable = "APIに届くSession IDと本文"
// observation_boundary = "public-boundary"
// scope = "composer-preview-request"
// lifecycle = "permanent"
// @end-test-value
test("createComposerPreviewRequest は session preview request を作る", async () => {
  const events: string[] = [];
  const request = createComposerPreviewRequest({
    api: createApi(events),
    sessionId: "s1",
  });

  await request?.("hello");

  assert.deepEqual(events, ["session:s1:hello"]);
});
