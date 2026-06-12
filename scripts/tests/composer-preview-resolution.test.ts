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
    async previewCompanionComposerInput(sessionId, message) {
      events.push(`companion:${sessionId}:${message}`);
      return { attachments: [], errors: [] };
    },
  };
}

test("createComposerPreviewRequest は api または session id がなければ null を返す", () => {
  const events: string[] = [];
  const api = createApi(events);

  assert.equal(createComposerPreviewRequest({ api: null, mode: "session", sessionId: "s1" }), null);
  assert.equal(createComposerPreviewRequest({ api, mode: "session", sessionId: null }), null);
  assert.deepEqual(events, []);
});

test("createComposerPreviewRequest は session preview request を作る", async () => {
  const events: string[] = [];
  const request = createComposerPreviewRequest({
    api: createApi(events),
    mode: "session",
    sessionId: "s1",
  });

  await request?.("hello");

  assert.deepEqual(events, ["session:s1:hello"]);
});

test("createComposerPreviewRequest は companion preview request を作る", async () => {
  const events: string[] = [];
  const request = createComposerPreviewRequest({
    api: createApi(events),
    mode: "companion",
    sessionId: "c1",
  });

  await request?.("review");

  assert.deepEqual(events, ["companion:c1:review"]);
});
