import assert from "node:assert/strict";
import test from "node:test";

import { MateTalkService } from "../../src-electron/mate-talk-service.js";
import type { MateProfile } from "../../src/mate-state.js";

const PROFILE: MateProfile = {
  id: "mate-1",
  state: "active",
  displayName: "Buddy",
  description: "",
  themeMain: "",
  themeSub: "",
  avatarFilePath: "",
  avatarSha256: "",
  avatarByteSize: 0,
  activeRevisionId: null,
  profileGeneration: 1,
  createdAt: "2026-05-04T00:00:00.000Z",
  updatedAt: "2026-05-04T00:00:00.000Z",
  deletedAt: null,
  sections: [],
};

test("MateTalkService は入力を正規化して provider 応答を返し Memory 生成入力を返す", async () => {
  const scheduled: unknown[] = [];
  const assistantInputs: unknown[] = [];
  const service = new MateTalkService({
    getMateProfile: () => PROFILE,
    now: () => new Date("2026-05-04T01:02:03.000Z"),
    scheduleMemoryGeneration: (input) => scheduled.push(input),
    generateAssistantMessage: async (input) => {
      assistantInputs.push(input);
      return `${input.mateProfile.displayName}、${input.userMessage}に応答するよ。`;
    },
  });

  const result = await service.runTurn({ message: "  hello  " });

  assert.deepEqual(result, {
    mateId: "mate-1",
    userMessage: "hello",
    assistantMessage: "Buddy、helloに応答するよ。",
    createdAt: "2026-05-04T01:02:03.000Z",
  });
  assert.deepEqual(scheduled, [{ userMessage: "hello", assistantText: "Buddy、helloに応答するよ。" }]);
  assert.deepEqual(assistantInputs, [{
    userMessage: "hello",
    mateProfile: {
      id: "mate-1",
      displayName: "Buddy",
      description: "",
      themeMain: "",
      themeSub: "",
    },
  }]);
});

test("MateTalkService は provider 未設定時に fallback 応答を返す", async () => {
  const scheduled: unknown[] = [];
  const service = new MateTalkService({
    getMateProfile: () => PROFILE,
    now: () => new Date("2026-05-04T01:02:03.000Z"),
    scheduleMemoryGeneration: (input) => scheduled.push(input),
  });

  const result = await service.runTurn({ message: "  hello  " });

  assert.deepEqual(result, {
    mateId: "mate-1",
    userMessage: "hello",
    assistantMessage: "受け取ったよ。",
    createdAt: "2026-05-04T01:02:03.000Z",
  });
  assert.deepEqual(scheduled, [{ userMessage: "hello", assistantText: "受け取ったよ。" }]);
});

test("MateTalkService は空入力と Mate 未作成を拒否する", async () => {
  const service = new MateTalkService({
    getMateProfile: () => null,
  });

  await assert.rejects(() => service.runTurn({ message: " " }), { message: "メッセージを入力してね。" });
  await assert.rejects(() => service.runTurn({ message: "hello" }), { message: "Mate が見つかりません。" });
});

