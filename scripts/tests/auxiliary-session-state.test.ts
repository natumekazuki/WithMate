import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAuxiliarySessionApprovalModeChange,
  applyAuxiliarySessionCodexSandboxModeChange,
  addAuxiliarySessionAdditionalDirectory,
  applyAuxiliarySessionPatch,
  applyAuxiliarySessionComposerDraftPatch,
  applyAuxiliarySessionCustomAgentPatch,
  applyAuxiliarySessionModelChange,
  applyAuxiliarySessionReasoningEffortChange,
  applyAuxiliarySessionModelSelectionPatch,
  applyAuxiliarySessionRuntimeOptionsPatch,
  buildAuxiliaryDraftSaveRequest,
  buildEditableActiveAuxiliarySessionPatch,
  buildAuxiliarySessionRunningTransition,
  buildAuxiliaryPreview,
  removeAuxiliarySessionAdditionalDirectory,
  resolveAuxiliarySessionDisplayAfterMessageIndex,
  resolveAuxiliarySessionSendPreflight,
  resolveAuxiliarySessionSendTarget,
  resolveEditableActiveAuxiliarySession,
  resolveAuxiliaryPreview,
  normalizeAuxiliarySession,
  type AuxiliarySession,
} from "../../src/auxiliary-session-state.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";

const providerCatalog = {
  id: "codex",
  label: "Codex",
  defaultModelId: "gpt-5.4",
  defaultReasoningEffort: "medium",
  models: [
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      reasoningEfforts: ["low", "medium", "high"],
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 mini",
      reasoningEfforts: ["minimal", "low"],
    },
  ],
} satisfies ModelCatalogProvider;

function createAuxiliarySession(overrides: Partial<AuxiliarySession> = {}): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "session-1",
    status: "active",
    runState: "idle",
    title: "Auxiliary",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "medium",
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    composerDraft: "",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: "",
    ...overrides,
  };
}

// @test-value v2
// kind = "invariant"
// claim = "渡された確定assistant応答だけをMarkdown平文化し、previewをUnicode上限内へ投影する"
// oracle = { type = "contract", ref = "issue-710-preview-final-response" }
// fault = "中間／tool／失敗メッセージを確定応答として扱うか、Markdown記号や長文をそのまま一覧previewへ採用する"
// observable = "buildAuxiliaryPreviewの返却文字列"
// observation_boundary = "declaration"
// scope = "auxiliary-preview"
// lifecycle = "permanent"
// @end-test-value
test("buildAuxiliaryPreview は確定応答の冒頭をMarkdown平文化して使う", () => {
  assert.equal(
    buildAuxiliaryPreview([
      { role: "user", text: "調べて" },
      { role: "assistant", text: "途中のログ", accent: true },
      { role: "assistant", text: "別の本文" },
    ], "**設定の問題**は `config_file.ts` です。\n続き。"),
    "設定の問題は config_file.ts です。 続き。",
  );
  const longUnicode = `🌙${"猫屋敷美紅".repeat(80)}`;
  const limited = buildAuxiliaryPreview([{ role: "assistant", text: longUnicode }], longUnicode);
  assert.equal(Array.from(limited).length, 240);
  assert.equal(limited.startsWith("🌙猫屋敷美紅"), true);
  assert.equal(buildAuxiliaryPreview([], "`__private_id__` と `a > b * 2`\n\n```ts\nconst _id = ~mask;\n```"), "__private_id__ と a > b * 2 const _id = ~mask;");
});

// @test-value v2
// kind = "invariant"
// claim = "confirmed finalがないpreviewはassistant joinを採用せず最新user本文へ限定する"
// oracle = { type = "contract", ref = "issue-710-preview-legacy-safe-fallback" }
// fault = "旧Auxiliaryのassistant中間block結合値を最終応答として一覧へ表示する"
// observable = "buildAuxiliaryPreviewの返却文字列"
// observation_boundary = "declaration"
// scope = "auxiliary-preview"
// lifecycle = "permanent"
// @end-test-value
test("buildAuxiliaryPreview はconfirmed finalなしではuser previewへ戻す", () => {
  assert.equal(
    buildAuxiliaryPreview([
      { role: "user", text: "元の依頼" },
      { role: "assistant", text: "中間A" },
      { role: "assistant", text: "中間B" },
      { role: "user", text: "追加の依頼" },
    ]),
    "追加の依頼",
  );
});

// @test-value v2
// kind = "invariant"
// claim = "新しい確定応答がないstreaming／失敗では保存済みpreviewを維持する"
// oracle = { type = "contract", ref = "issue-710-preview-stability" }
// fault = "未確定の失敗通知やstreaming途中の本文で前回previewを巻き戻す"
// observable = "resolveAuxiliaryPreviewの返却文字列"
// observation_boundary = "declaration"
// scope = "auxiliary-preview"
// lifecycle = "permanent"
// @end-test-value
test("resolveAuxiliaryPreview は応答なしの失敗やstreamingで前回値を保つ", () => {
  assert.equal(
    resolveAuxiliaryPreview([
      { role: "user", text: "次の依頼" },
      { role: "assistant", text: "失敗しました", accent: true },
    ], "前回の確定応答"),
    "前回の確定応答",
  );
});

// @test-value v2
// kind = "invariant"
// claim = "normalizeAuxiliarySessionは不正な新形式Character snapshotを旧形式の欠落として扱わない"
// oracle = { type = "contract", ref = "issue-710-character-snapshot-identity" }
// fault = "不正snapshotをlegacy欠落として正規化し、後段のidentity検査を迂回する"
// observable = "normalizeAuxiliarySessionのcharacterRuntimeSnapshotInvalid"
// observation_boundary = "declaration"
// scope = "auxiliary-session-state-normalization"
// lifecycle = "permanent"
// @end-test-value
test("normalizeAuxiliarySession は不正な新形式snapshotを識別する", () => {
  const session = normalizeAuxiliarySession({
    id: "aux-invalid",
    parentSessionId: "session-1",
    characterRuntimeSnapshot: { characterId: "char-1", definitionMarkdown: 42 },
  });
  assert.equal(session?.characterRuntimeSnapshotInvalid, true);
});

// @test-value v2
// kind = "invariant"
// claim = "新形式AuxiliaryのcharacterIdとsnapshot.characterIdの不一致・片欠けはlegacy fallbackへ変換しない"
// oracle = { type = "contract", ref = "issue-710 Character identity consistency" }
// fault = "別Characterのsnapshotを親Characterへ黙って差し替える"
// observable = "normalizeAuxiliarySessionのcharacterRuntimeSnapshotInvalid"
// observation_boundary = "declaration"
// scope = "auxiliary-character-migration"
// lifecycle = "permanent"
// @end-test-value
test("normalizeAuxiliarySession は新形式Character identityの不一致と片欠けを識別する", () => {
  const snapshot = {
    characterId: "char-snapshot",
    name: "Character",
    description: "",
    iconFilePath: "",
    theme: { main: "#6f8cff", sub: "#6fb8c7" },
    definitionMarkdown: "# Character",
    definitionSha256: "sha",
    definitionByteSize: 11,
    snapshotAt: "2026-08-01T00:00:00.000Z",
  };
  const mismatch = normalizeAuxiliarySession({
    id: "aux-mismatch",
    parentSessionId: "session-1",
    characterId: "char-other",
    characterRuntimeSnapshot: snapshot,
  });
  const missingId = normalizeAuxiliarySession({
    id: "aux-missing-id",
    parentSessionId: "session-1",
    characterRuntimeSnapshot: snapshot,
  });
  const missingSnapshot = normalizeAuxiliarySession({
    id: "aux-legacy",
    parentSessionId: "session-1",
    characterId: "char-legacy",
  });

  assert.equal(mismatch?.characterRuntimeSnapshotInvalid, true);
  assert.equal(missingId?.characterRuntimeSnapshotInvalid, true);
  assert.equal(missingSnapshot?.characterRuntimeSnapshotInvalid, true);
  assert.equal(normalizeAuxiliarySession({ id: "aux-legacy", parentSessionId: "session-1" })?.characterRuntimeSnapshotInvalid, false);
});

test("applyAuxiliarySessionPatch は指定 field と updatedAt だけを更新する", () => {
  const session = createAuxiliarySession();

  assert.deepEqual(
    applyAuxiliarySessionPatch(
      session,
      {
        approvalMode: "on-request",
        codexSandboxMode: "read-only",
      },
      "2026-01-02T00:00:00.000Z",
    ),
    {
      ...session,
      approvalMode: "on-request",
      codexSandboxMode: "read-only",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("applyAuxiliarySessionRuntimeOptionsPatch は runtime option と updatedAt だけを更新する", () => {
  const session = createAuxiliarySession({
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write",
  });

  assert.deepEqual(
    applyAuxiliarySessionRuntimeOptionsPatch(
      session,
      {
        approvalMode: "on-request",
        codexSandboxMode: "read-only",
      },
      "2026-01-02T00:00:00.000Z",
    ),
    {
      ...session,
      approvalMode: "on-request",
      codexSandboxMode: "read-only",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("applyAuxiliarySessionApprovalModeChange は approval mode と updatedAt だけを更新する", () => {
  const session = createAuxiliarySession({
    approvalMode: "untrusted",
  });

  assert.deepEqual(
    applyAuxiliarySessionApprovalModeChange(
      session,
      "on-request",
      "2026-01-02T00:00:00.000Z",
    ),
    {
      ...session,
      approvalMode: "on-request",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("applyAuxiliarySessionCodexSandboxModeChange は sandbox mode と updatedAt だけを更新する", () => {
  const session = createAuxiliarySession({
    codexSandboxMode: "workspace-write",
  });

  assert.deepEqual(
    applyAuxiliarySessionCodexSandboxModeChange(
      session,
      "read-only",
      "2026-01-02T00:00:00.000Z",
    ),
    {
      ...session,
      codexSandboxMode: "read-only",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("applyAuxiliarySessionModelSelectionPatch は model selection と updatedAt だけを更新する", () => {
  const session = createAuxiliarySession({
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "medium",
  });

  assert.deepEqual(
    applyAuxiliarySessionModelSelectionPatch(
      session,
      {
        catalogRevision: 2,
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      },
      "2026-01-02T00:00:00.000Z",
    ),
    {
      ...session,
      catalogRevision: 2,
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("addAuxiliarySessionAdditionalDirectory は重複を避けて directory と updatedAt を更新する", () => {
  const session = createAuxiliarySession({
    allowedAdditionalDirectories: ["C:/workspace/existing"],
  });

  assert.deepEqual(
    addAuxiliarySessionAdditionalDirectory(
      session,
      "C:/workspace/next",
      "2026-01-02T00:00:00.000Z",
    ),
    {
      ...session,
      allowedAdditionalDirectories: ["C:/workspace/existing", "C:/workspace/next"],
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
  assert.deepEqual(
    addAuxiliarySessionAdditionalDirectory(
      session,
      "C:/workspace/existing",
      "2026-01-02T00:00:00.000Z",
    ),
    {
      ...session,
      allowedAdditionalDirectories: ["C:/workspace/existing"],
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("removeAuxiliarySessionAdditionalDirectory は指定 directory と updatedAt を更新する", () => {
  const session = createAuxiliarySession({
    allowedAdditionalDirectories: ["C:/workspace/keep", "C:/workspace/remove"],
  });

  assert.deepEqual(
    removeAuxiliarySessionAdditionalDirectory(
      session,
      "C:/workspace/remove",
      "2026-01-02T00:00:00.000Z",
    ),
    {
      ...session,
      allowedAdditionalDirectories: ["C:/workspace/keep"],
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("applyAuxiliarySessionComposerDraftPatch は draft と updatedAt だけを更新する", () => {
  const session = createAuxiliarySession({
    composerDraft: "before",
  });

  assert.deepEqual(
    applyAuxiliarySessionComposerDraftPatch(session, "after", "2026-01-02T00:00:00.000Z"),
    {
      ...session,
      composerDraft: "after",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("applyAuxiliarySessionCustomAgentPatch は custom agent と updatedAt だけを更新する", () => {
  const session = createAuxiliarySession({
    customAgentName: "reviewer",
  });

  assert.deepEqual(
    applyAuxiliarySessionCustomAgentPatch(session, "planner", "2026-01-02T00:00:00.000Z"),
    {
      ...session,
      customAgentName: "planner",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("applyAuxiliarySessionModelChange は model selection と updatedAt だけを更新する", () => {
  const session = createAuxiliarySession({
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "high",
  });

  assert.deepEqual(
    applyAuxiliarySessionModelChange(
      session,
      providerCatalog,
      "gpt-5.4-mini",
      2,
      "2026-01-02T00:00:00.000Z",
    ),
    {
      ...session,
      catalogRevision: 2,
      model: "gpt-5.4-mini",
      reasoningEffort: "minimal",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("applyAuxiliarySessionReasoningEffortChange は reasoning effort と updatedAt だけを更新する", () => {
  const session = createAuxiliarySession({
    catalogRevision: 1,
    model: "gpt-5.4-mini",
    reasoningEffort: "low",
  });

  assert.deepEqual(
    applyAuxiliarySessionReasoningEffortChange(
      session,
      providerCatalog,
      "minimal",
      2,
      "2026-01-02T00:00:00.000Z",
    ),
    {
      ...session,
      catalogRevision: 2,
      model: "gpt-5.4-mini",
      reasoningEffort: "minimal",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("applyAuxiliarySessionReasoningEffortChange は model catalog validation error を維持する", () => {
  const session = createAuxiliarySession({
    model: "gpt-5.4-mini",
    reasoningEffort: "low",
  });

  assert.throws(
    () => applyAuxiliarySessionModelChange(
      session,
      providerCatalog,
      "missing-model",
      2,
      "2026-01-02T00:00:00.000Z",
    ),
    /selected model/,
  );
  assert.throws(
    () => applyAuxiliarySessionReasoningEffortChange(
      session,
      providerCatalog,
      "xhigh",
      2,
      "2026-01-02T00:00:00.000Z",
    ),
    /selected depth/,
  );
});

test("buildAuxiliaryDraftSaveRequest は保存すべき draft request を作る", () => {
  const currentSession = createAuxiliarySession({
    composerDraft: "draft text",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.deepEqual(
    buildAuxiliaryDraftSaveRequest({
      currentSession,
      targetSessionId: currentSession.id,
      draft: "draft text",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }),
    {
      ...currentSession,
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("buildAuxiliaryDraftSaveRequest は古い draft save を無視する", () => {
  const currentSession = createAuxiliarySession({
    composerDraft: "newer draft",
  });

  assert.equal(
    buildAuxiliaryDraftSaveRequest({
      currentSession,
      targetSessionId: currentSession.id,
      draft: "stale draft",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }),
    null,
  );
  assert.equal(
    buildAuxiliaryDraftSaveRequest({
      currentSession: createAuxiliarySession({ id: "aux-other", composerDraft: "stale draft" }),
      targetSessionId: currentSession.id,
      draft: "stale draft",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }),
    null,
  );
  assert.equal(
    buildAuxiliaryDraftSaveRequest({
      currentSession: null,
      targetSessionId: currentSession.id,
      draft: "stale draft",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }),
    null,
  );
});

test("resolveAuxiliarySessionSendPreflight は送信文を trim する", () => {
  assert.deepEqual(
    resolveAuxiliarySessionSendPreflight({
      activeSession: createAuxiliarySession(),
      messageText: "  hello  ",
    }),
    {
      blockedReason: null,
      blockedMessage: "",
      userMessage: "hello",
    },
  );
});

test("resolveAuxiliarySessionSendPreflight は送信前 block 理由を返す", () => {
  assert.deepEqual(
    resolveAuxiliarySessionSendPreflight({
      activeSession: createAuxiliarySession(),
      messageText: "   ",
    }),
    {
      blockedReason: "empty-message",
      blockedMessage: "送信するメッセージが空だよ。",
      userMessage: "",
    },
  );
  assert.deepEqual(
    resolveAuxiliarySessionSendPreflight({
      activeSession: createAuxiliarySession({ runState: "running" }),
      messageText: "hello",
    }),
    {
      blockedReason: "running",
      blockedMessage: "Auxiliary Session はまだ実行中だよ。",
      userMessage: "hello",
    },
  );
  assert.deepEqual(
    resolveAuxiliarySessionSendPreflight({
      activeSession: createAuxiliarySession(),
      composerBlockedReason: "blocked",
      messageText: "hello",
    }),
    {
      blockedReason: "composer-blocked",
      blockedMessage: "blocked",
      userMessage: "hello",
    },
  );
});

test("resolveAuxiliarySessionSendTarget は保存後の送信対象 session を返す", () => {
  const activeSession = createAuxiliarySession({ title: "active" });
  const currentSession = createAuxiliarySession({ title: "current" });

  assert.deepEqual(
    resolveAuxiliarySessionSendTarget({
      activeSession,
      currentSession: null,
    }),
    {
      blockedReason: null,
      session: activeSession,
    },
  );
  assert.deepEqual(
    resolveAuxiliarySessionSendTarget({
      activeSession,
      currentSession,
    }),
    {
      blockedReason: null,
      session: currentSession,
    },
  );
});

test("resolveAuxiliarySessionSendTarget は session 変更と running を区別する", () => {
  const activeSession = createAuxiliarySession();

  assert.deepEqual(
    resolveAuxiliarySessionSendTarget({
      activeSession,
      currentSession: createAuxiliarySession({ id: "aux-other" }),
    }),
    {
      blockedReason: "session-changed",
      session: null,
    },
  );
  assert.deepEqual(
    resolveAuxiliarySessionSendTarget({
      activeSession,
      currentSession: createAuxiliarySession({ runState: "running" }),
    }),
    {
      blockedReason: "running",
      session: null,
    },
  );
});

test("resolveEditableActiveAuxiliarySession は保存対象の active session を返す", () => {
  const activeSession = createAuxiliarySession();
  const currentSession = createAuxiliarySession({ title: "current" });

  assert.equal(
    resolveEditableActiveAuxiliarySession({
      activeSession,
      currentSession: null,
    }),
    activeSession,
  );
  assert.equal(
    resolveEditableActiveAuxiliarySession({
      activeSession,
      currentSession,
    }),
    currentSession,
  );
  assert.equal(
    resolveEditableActiveAuxiliarySession({
      activeSession,
      currentSession: createAuxiliarySession({ id: "aux-other" }),
    }),
    null,
  );
  assert.equal(
    resolveEditableActiveAuxiliarySession({
      activeSession,
      currentSession: createAuxiliarySession({ runState: "running" }),
    }),
    null,
  );
});

test("buildEditableActiveAuxiliarySessionPatch は保存対象 session に recipe を適用する", () => {
  const activeSession = createAuxiliarySession({ title: "active" });
  const currentSession = createAuxiliarySession({ title: "current" });

  assert.deepEqual(
    buildEditableActiveAuxiliarySessionPatch({
      activeSession,
      currentSession,
      recipe: (current) => ({ ...current, title: "next" }),
    }),
    {
      ...currentSession,
      title: "next",
    },
  );
  assert.equal(
    buildEditableActiveAuxiliarySessionPatch({
      activeSession,
      currentSession: createAuxiliarySession({ id: "aux-other" }),
      recipe: (current) => ({ ...current, title: "next" }),
    }),
    null,
  );
  assert.equal(
    buildEditableActiveAuxiliarySessionPatch({
      activeSession,
      currentSession: createAuxiliarySession({ runState: "running" }),
      recipe: (current) => ({ ...current, title: "next" }),
    }),
    null,
  );
});

test("resolveAuxiliarySessionDisplayAfterMessageIndex は初回 Auxiliary anchor を解決する", () => {
  assert.equal(
    resolveAuxiliarySessionDisplayAfterMessageIndex({
      auxiliaryMessageCount: 0,
      currentDisplayAfterMessageIndex: null,
      parentMessageCount: 5,
    }),
    4,
  );
  assert.equal(
    resolveAuxiliarySessionDisplayAfterMessageIndex({
      auxiliaryMessageCount: 1,
      currentDisplayAfterMessageIndex: 2,
      parentMessageCount: 5,
    }),
    2,
  );
  assert.equal(
    resolveAuxiliarySessionDisplayAfterMessageIndex({
      auxiliaryMessageCount: 0,
      currentDisplayAfterMessageIndex: 3,
      parentMessageCount: null,
    }),
    3,
  );
});

test("buildAuxiliarySessionRunningTransition は初回 anchor update と running state を組み立てる", () => {
  const session = createAuxiliarySession({
    composerDraft: "draft text",
    displayAfterMessageIndex: null,
    messages: [],
    updatedAt: "2026-05-30T00:00:00.000Z",
  });

  assert.deepEqual(
    buildAuxiliarySessionRunningTransition({
      session,
      userMessage: "next message",
      parentMessageCount: 4,
      updatedAt: "2026-05-31T00:00:00.000Z",
    }),
    {
      anchorUpdateSession: {
        ...session,
        displayAfterMessageIndex: 3,
      },
      runningSession: {
        ...session,
        runState: "running",
        composerDraft: "",
        displayAfterMessageIndex: 3,
        updatedAt: "2026-05-31T00:00:00.000Z",
        messages: [{ role: "user", text: "next message" }],
      },
    },
  );
});

test("buildAuxiliarySessionRunningTransition は既存 anchor では保存用 update を作らない", () => {
  const session = createAuxiliarySession({
    composerDraft: "draft text",
    displayAfterMessageIndex: 2,
    messages: [{ role: "user", text: "previous" }],
    updatedAt: "2026-05-30T00:00:00.000Z",
  });

  const result = buildAuxiliarySessionRunningTransition({
    session,
    userMessage: "next message",
    parentMessageCount: 4,
    updatedAt: "2026-05-31T00:00:00.000Z",
  });

  assert.equal(result.anchorUpdateSession, null);
  assert.deepEqual(result.runningSession, {
    ...session,
    runState: "running",
    composerDraft: "",
    displayAfterMessageIndex: 2,
    updatedAt: "2026-05-31T00:00:00.000Z",
    messages: [
      { role: "user", text: "previous" },
      { role: "user", text: "next message" },
    ],
  });
});
