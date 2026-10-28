import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionWithApprovalMode,
  buildSessionWithCodexSandboxMode,
  buildSessionWithModelChange,
  buildSessionWithReasoningEffort,
  resolveRuntimeOptionValue,
} from "../../src/settings/runtime-option-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";

const providerCatalog = {
  id: "codex",
  label: "Codex",
  defaultModelId: "gpt-default",
  defaultReasoningEffort: "medium",
  models: [
    {
      id: "gpt-default",
      label: "GPT Default",
      reasoningEfforts: ["low", "medium", "high"],
    },
    {
      id: "gpt-fast",
      label: "GPT Fast",
      defaultReasoningEffort: "minimal",
      reasoningEfforts: ["minimal", "low"],
    },
  ],
} satisfies ModelCatalogProvider;

test("buildSessionWithApprovalMode は approval mode と updatedAt を反映する", () => {
  const session = {
    id: "session-1",
    approvalMode: "on-request" as const,
    provider: "codex",
    updatedAt: "2026-06-07T00:00:00.000Z",
  };

  const nextSession = buildSessionWithApprovalMode(
    session,
    "never",
    "2026-06-07T01:00:00.000Z",
  );

  assert.deepEqual(nextSession, {
    id: "session-1",
    approvalMode: "never",
    provider: "codex",
    updatedAt: "2026-06-07T01:00:00.000Z",
  });
});

test("buildSessionWithApprovalMode は同じ approval mode なら no-op を返す", () => {
  const session = {
    id: "session-1",
    approvalMode: "on-request" as const,
    updatedAt: "2026-06-07T00:00:00.000Z",
  };

  assert.equal(
    buildSessionWithApprovalMode(session, "on-request", "2026-06-07T01:00:00.000Z"),
    null,
  );
});

test("buildSessionWithCodexSandboxMode は sandbox mode と updatedAt を反映する", () => {
  const session = {
    id: "session-1",
    codexSandboxMode: "workspace-write" as const,
    provider: "codex",
    updatedAt: "2026-06-07T00:00:00.000Z",
  };

  const nextSession = buildSessionWithCodexSandboxMode(
    session,
    "read-only",
    "2026-06-07T01:00:00.000Z",
  );

  assert.deepEqual(nextSession, {
    id: "session-1",
    codexSandboxMode: "read-only",
    provider: "codex",
    updatedAt: "2026-06-07T01:00:00.000Z",
  });
});

test("buildSessionWithCodexSandboxMode は同じ sandbox mode なら no-op を返す", () => {
  const session = {
    id: "session-1",
    codexSandboxMode: "workspace-write" as const,
    updatedAt: "2026-06-07T00:00:00.000Z",
  };

  assert.equal(
    buildSessionWithCodexSandboxMode(
      session,
      "workspace-write",
      "2026-06-07T01:00:00.000Z",
    ),
    null,
  );
});

// @test-value v2
// kind = "contract"
// claim = "明示model変更はSDK既定Depthと新しいmodelをpatchへ反映する"
// oracle = { type = "contract", ref = "Issue #879 discovered models and preserved execution selections" }
// fault = "未対応Depthを前modelから引き継ぐかmodel変更を失う"
// observable = "modelとDepthとupdatedAtのpatch"
// observation_boundary = "public-boundary"
// scope = "model-change-patch"
// lifecycle = "permanent"
// @end-test-value
test("buildSessionWithModelChange は model catalog selection を session patch に反映する", () => {
  const session = {
    id: "session-1",
    model: "gpt-default",
    reasoningEffort: "high" as const,
    updatedAt: "2026-06-07T00:00:00.000Z",
  };

  const nextSession = buildSessionWithModelChange(
    session,
    providerCatalog.models.find((model) => model.id === "gpt-fast")!,
    "2026-06-07T01:00:00.000Z",
  );

  assert.deepEqual(nextSession, {
    id: "session-1",
    model: "gpt-fast",
    reasoningEffort: "minimal",
    updatedAt: "2026-06-07T01:00:00.000Z",
  });
});

// @test-value v2
// kind = "contract"
// claim = "明示Depth変更はmodelを変えずDepthと更新日時をpatchへ反映する"
// oracle = { type = "contract", ref = "Issue #879 discovered models and preserved execution selections" }
// fault = "Depth変更が別modelへ変更するか更新を失う"
// observable = "modelとDepthとupdatedAtのpatch"
// observation_boundary = "public-boundary"
// scope = "depth-change-patch"
// lifecycle = "permanent"
// @end-test-value
test("buildSessionWithReasoningEffort は reasoning effort selection を session patch に反映する", () => {
  const session = {
    id: "session-1",
    model: "gpt-fast",
    reasoningEffort: "low" as const,
    updatedAt: "2026-06-07T00:00:00.000Z",
  };

  const nextSession = buildSessionWithReasoningEffort(
    session,
    providerCatalog,
    "minimal",
    "2026-06-07T01:00:00.000Z",
  );

  assert.deepEqual(nextSession, {
    id: "session-1",
    model: "gpt-fast",
    reasoningEffort: "minimal",
    updatedAt: "2026-06-07T01:00:00.000Z",
  });
});

// @test-value v2
// kind = "contract"
// claim = "同じ実行設定の明示更新でも現在値と指定更新日時を返す"
// oracle = { type = "contract", ref = "Issue #879 discovered models and preserved execution selections" }
// fault = "同値選択でpatchを失うか指定日時を捨てる"
// observable = "modelとDepthとupdatedAtのpatch"
// observation_boundary = "public-boundary"
// scope = "same-selection-patch"
// lifecycle = "permanent"
// @end-test-value
test("model / reasoning effort helper は同じ選択でも既存どおり patch を返す", () => {
  const session = {
    id: "session-1",
    model: "gpt-default",
    reasoningEffort: "medium" as const,
    updatedAt: "2026-06-07T00:00:00.000Z",
  };

  assert.deepEqual(
    buildSessionWithModelChange(
      session,
      providerCatalog.models.find((model) => model.id === "gpt-default")!,
      "2026-06-07T01:00:00.000Z",
    ),
    {
      id: "session-1",
      model: "gpt-default",
      reasoningEffort: "medium",
      updatedAt: "2026-06-07T01:00:00.000Z",
    },
  );
  assert.deepEqual(
    buildSessionWithReasoningEffort(
      session,
      providerCatalog,
      "medium",
      "2026-06-07T01:00:00.000Z",
    ),
    {
      id: "session-1",
      model: "gpt-default",
      reasoningEffort: "medium",
      updatedAt: "2026-06-07T01:00:00.000Z",
    },
  );
});

// @test-value v2
// kind = "contract"
// claim = "明示model変更は表示時の候補定義でDepthを解決し、reasoning変更はSDK固有の文字列を保持する"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md#model-ui" }
// fault = "表示候補を更新後一覧で拒否・置換するか、SDK固有のreasoning値を拒否・置換する"
// observable = "model変更のmodelとDepth、reasoning変更の保存値"
// observation_boundary = "public-boundary"
// scope = "runtime option model catalog validation"
// lifecycle = "permanent"
// impact = "表示中の候補を確定できないかSDK固有のDepthを利用できなくなる"
// distinction = "rendererの明示変更helper経由で共有モデル契約の保存への伝播を確認する"
// @end-test-value
test("model helperは選択候補の定義を使いreasoning helperはSDK固有値を保持する", () => {
  const session = {
    id: "session-1",
    model: "gpt-default",
    reasoningEffort: "medium" as const,
    updatedAt: "2026-06-07T00:00:00.000Z",
  };

  assert.deepEqual(
    buildSessionWithModelChange(
      session,
      { id: "displayed-model", label: "Displayed", reasoningEfforts: ["sdk-depth"], defaultReasoningEffort: "sdk-depth" },
      "2026-06-07T01:00:00.000Z",
    ),
    { ...session, model: "displayed-model", reasoningEffort: "sdk-depth", updatedAt: "2026-06-07T01:00:00.000Z" },
  );
  assert.equal(buildSessionWithReasoningEffort(
    session, providerCatalog, "xhigh", "2026-06-07T01:00:00.000Z",
  ).reasoningEffort, "xhigh");
});

test("resolveRuntimeOptionValue は selected value が option にあれば維持する", () => {
  assert.equal(
    resolveRuntimeOptionValue(
      "on-request",
      [
        { value: "never" },
        { value: "on-request" },
      ],
      "untrusted",
    ),
    "on-request",
  );
});

test("resolveRuntimeOptionValue は selected value が option にない場合に先頭 option へ fallback する", () => {
  assert.equal(
    resolveRuntimeOptionValue(
      "danger-full-access",
      [
        { value: "read-only" },
        { value: "workspace-write" },
      ],
      "workspace-write",
    ),
    "read-only",
  );
});

test("resolveRuntimeOptionValue は option が空なら fallback value を返す", () => {
  assert.equal(resolveRuntimeOptionValue("custom", [], "fallback"), "fallback");
});
