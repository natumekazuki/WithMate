import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AuxiliaryLaunchProviderDialog } from "../../src/chat/AuxiliaryLaunchProviderDialog.js";
import { ChatSessionModals } from "../../src/chat/chat-session-modals.js";
import type { AuditLogSummary } from "../../src-shared/session/runtime-state.js";

function createAuditLogSummary(): AuditLogSummary {
  return {
    id: 1,
    sessionId: "session-1",
    createdAt: "2026-05-11T00:00:00.000Z",
    phase: "completed",
    provider: "codex",
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
    approvalMode: "never",
    threadId: "thread-1",
    assistantTextPreview: "preview",
    operations: [{ type: "analysis", summary: "operation" }],
    usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2 },
    errorMessage: "",
    detailAvailable: true,
  };
}

// @test-value v2
// kind = "contract"
// claim = "共有modalは呼び出し側の追加表示を同じfragmentへ描画する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
// fault = "共有modalまたは追加childrenが描画結果から欠落する"
// observable = "Audit Log見出し、監査カード、呼び出し側の追加表示"
// observation_boundary = "component-behavior"
// scope = "chat-session-modals-shared-content"
// lifecycle = "permanent"
// @end-test-value
test("ChatSessionModals は共有 modal と呼び出し側の追加表示を同じ fragment に描画する", () => {
  const html = renderToStaticMarkup(
    <ChatSessionModals
      selectedDiff={null}
      selectedDiffThemeStyle={{}}
      auditLogProps={{
        open: true,
        entries: [createAuditLogSummary()],
        details: {},
        operationDetails: {},
        hasMore: false,
        loadingMore: false,
        total: 1,
        errorMessage: null,
        onLoadMore: () => {},
        onLoadDetail: () => {},
        onLoadOperationDetail: () => {},
        onClose: () => {},
      }}
      onCloseDiff={() => {}}
      onOpenDiffWindow={() => {}}
    >
      <div className="session-toast success">merged</div>
    </ChatSessionModals>,
  );

  assert.match(html, /<h2>Audit log<\/h2>/);
  assert.match(html, /audit-log-card completed/);
  assert.match(html, /session-toast success/);
  assert.doesNotMatch(html, /diff-editor panel/);
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary起動dialogは利用可能なcoding providerと起動操作を表示する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#auxiliary-session-issue-710" }
// fault = "起動可能なproviderまたは起動操作が表示されない"
// observable = "Coding providerの項目名、Codex/Copilot候補、Start Auxiliary操作"
// observation_boundary = "component-behavior"
// scope = "auxiliary-launch-dialog"
// lifecycle = "permanent"
// @end-test-value
test("AuxiliaryLaunchProviderDialog は Provider だけを選択対象として描画する", () => {
  const html = renderToStaticMarkup(
    <AuxiliaryLaunchProviderDialog
      open={true}
      providers={[
        { id: "codex", label: "Codex" },
        { id: "copilot", label: "Copilot" },
      ]}
      selectedProviderId="copilot"
      feedback=""
      starting={false}
      onClose={() => {}}
      onSelectProvider={() => {}}
      onStart={() => {}}
    />,
  );

  assert.match(html, /Coding provider/);
  assert.match(html, /Codex/);
  assert.match(html, /Copilot/);
  assert.match(html, /Start Auxiliary/);
  assert.doesNotMatch(html, /Reasoning/);
  assert.doesNotMatch(html, /Sandbox/);
});
