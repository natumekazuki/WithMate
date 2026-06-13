import assert from "node:assert/strict";
import test from "node:test";

import { MateTalkService } from "../../src-electron/mate-talk-service.js";
import type { MateProfile } from "../../src/mate/mate-state.js";

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

test("MateTalkService は入力を正規化して provider 応答を返す", async () => {
  const assistantInputs: unknown[] = [];
  const service = new MateTalkService({
    getMateProfile: () => PROFILE,
    getMateProfileContextText: async (profile) => {
      assert.equal(profile.id, "mate-1");
      return "core context\n- friendly";
    },
    now: () => new Date("2026-05-04T01:02:03.000Z"),
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
  assert.deepEqual(assistantInputs, [{
    userMessage: "hello",
    mateProfile: {
      id: "mate-1",
      displayName: "Buddy",
      description: "",
      themeMain: "",
      themeSub: "",
      contextText: "core context\n- friendly",
    },
  }]);
});

test("MateTalkService は provider 未設定時に fallback 応答を返す", async () => {
  const service = new MateTalkService({
    getMateProfile: () => PROFILE,
    now: () => new Date("2026-05-04T01:02:03.000Z"),
  });

  const result = await service.runTurn({ message: "  hello  " });

  assert.deepEqual(result, {
    mateId: "mate-1",
    userMessage: "hello",
    assistantMessage: "受け取ったよ。",
    createdAt: "2026-05-04T01:02:03.000Z",
  });
});

test("MateTalkService は選択された provider/model/depth を provider 呼び出しへ渡す", async () => {
  const assistantInputs: unknown[] = [];
  const service = new MateTalkService({
    getMateProfile: () => PROFILE,
    generateAssistantMessage: async (input) => {
      assistantInputs.push(input);
      return "ok";
    },
  });

  await service.runTurn({
    message: "hello",
    provider: "copilot",
    model: "claude-sonnet-4.5",
    reasoningEffort: "medium",
  });

  assert.deepEqual(assistantInputs, [{
    userMessage: "hello",
    provider: "copilot",
    model: "claude-sonnet-4.5",
    reasoningEffort: "medium",
    mateProfile: {
      id: "mate-1",
      displayName: "Buddy",
      description: "",
      themeMain: "",
      themeSub: "",
    },
  }]);
});

test("MateTalkService は参照 payload と通常 Session 相当の実行権限を provider 呼び出しへ渡す", async () => {
  const assistantInputs: unknown[] = [];
  const service = new MateTalkService({
    getMateProfile: () => PROFILE,
    generateAssistantMessage: async (input) => {
      assistantInputs.push(input);
      return "ok";
    },
  });

  await service.runTurn({
    message: "hello",
    attachments: [{ path: "C:/workspace/readme.md", kind: "file" }],
    additionalDirectories: ["C:/shared/context"],
    approvalMode: "on-request",
    codexSandboxMode: "danger-full-access",
  });

  assert.deepEqual(assistantInputs, [{
    userMessage: "hello",
    attachments: [{ path: "C:/workspace/readme.md", kind: "file" }],
    additionalDirectories: ["C:/shared/context"],
    approvalMode: "on-request",
    codexSandboxMode: "danger-full-access",
    mateProfile: {
      id: "mate-1",
      displayName: "Buddy",
      description: "",
      themeMain: "",
      themeSub: "",
    },
  }]);
});

test("MateTalkService は provider の空文字/空白応答を fallback 応答に変換する", async () => {
  const service = new MateTalkService({
    getMateProfile: () => PROFILE,
    now: () => new Date("2026-05-04T01:02:03.000Z"),
    generateAssistantMessage: async () => "   ",
  });

  const result = await service.runTurn({ message: "  hello  " });

  assert.equal(result.assistantMessage, "受け取ったよ。");
});

test("MateTalkService は getMateProfileContextText の例外でも visible turn を失敗させず provider 呼び出しを継続する", async () => {
  const assistantInputs: unknown[] = [];
  const service = new MateTalkService({
    getMateProfile: () => PROFILE,
    now: () => new Date("2026-05-04T01:02:03.000Z"),
    getMateProfileContextText: async () => {
      throw new Error("context failed");
    },
    generateAssistantMessage: async (input) => {
      assistantInputs.push(input);
      return `${input.mateProfile.displayName}、${input.userMessage}に応答するよ。`;
    },
  });

  const result = await service.runTurn({ message: "  hello  " });

  assert.equal(result.assistantMessage, "Buddy、helloに応答するよ。");
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

test("MateTalkService は空入力と Mate 未作成を拒否する", async () => {
  const service = new MateTalkService({
    getMateProfile: () => null,
  });

  await assert.rejects(() => service.runTurn({ message: " " }), { message: "メッセージを入力してね。" });
  await assert.rejects(() => service.runTurn({ message: "hello" }), { message: "Mate が見つかりません。" });
});

test("MateTalkService は provider 応答の生成失敗を呼び出し元へ返す", async () => {
  const service = new MateTalkService({
    getMateProfile: () => PROFILE,
    now: () => new Date("2026-05-04T01:02:03.000Z"),
    generateAssistantMessage: async () => {
      throw new Error("provider error");
    },
  });

  await assert.rejects(() => service.runTurn({ message: "  hello  " }), /provider error/);
});
