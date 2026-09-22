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
// observable = "AuditLog見出し、監査カード、呼び出し側の追加表示"
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

  assert.match(html, /<div class="diff-modal"[^>]*aria-labelledby="session-audit-log-title"/);
  assert.match(html, /<h2 id="session-audit-log-title">AuditLog<\/h2>/);
  assert.match(html, /audit-log-card completed/);
  assert.match(html, /session-toast success/);
  assert.doesNotMatch(html, /diff-editor panel/);
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary起動dialogは利用可能なcoding providerと起動操作を表示し、dialogのaccessible nameを提供する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#auxiliary-session-issue-710" }
// fault = "起動可能なprovider・起動操作・dialogのaccessible nameのいずれかが表示結果から欠落する"
// observable = "dialog role/aria-label、CodingProviderの項目名、Codex/Copilot候補、StartAuxiliary操作"
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

  assert.match(html, /<div class="launch-modal" role="dialog" aria-modal="true" aria-label="Start Auxiliary">/);
  assert.match(html, /CodingProvider/);
  assert.match(html, /Codex/);
  assert.match(html, /Copilot/);
  assert.match(html, /StartAuxiliary/);
  assert.doesNotMatch(html, /Reasoning/);
  assert.doesNotMatch(html, /Sandbox/);
});

// @test-value v2
// kind = "regression"
// claim = "Auxiliary起動dialogはprovider catalogのloading/errorを空一覧へ誤変換せず、ready後は有効な先頭候補を選択可能にする"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#auxiliary-session-issue-710" }
// fault = "ロード中・失敗時に通常の空一覧または古いfeedbackを表示するか、ready後のprovider全件がtabIndex -1になって開始できない"
// observable = "loading status、error alert、開始buttonのdisabled、ready-emptyの単一empty説明、ready後の先頭providerのaria-selected/tabIndex"
// observation_boundary = "component-behavior"
// scope = "auxiliary-launch-provider-load-state"
// lifecycle = "permanent"
// impact = "provider catalogの非同期状態を正しく通知し、選択可能なproviderだけを起動対象にする"
// distinction = "ready空一覧だけでなくloading/error/ready遷移とprovider選択の契約を同一dialogで検証する"
// @end-test-value
test("AuxiliaryLaunchProviderDialog は provider catalog の loading/error と ready 選択を区別する", () => {
  const renderDialog = (overrides: Partial<React.ComponentProps<typeof AuxiliaryLaunchProviderDialog>>) =>
    renderToStaticMarkup(
      <AuxiliaryLaunchProviderDialog
        open={true}
        providers={[]}
        selectedProviderId={null}
        feedback="No enabled coding providers."
        starting={false}
        onClose={() => {}}
        onSelectProvider={() => {}}
        onStart={() => {}}
        {...overrides}
      />,
    );

  const loadingHtml = renderDialog({ providerLoadStatus: "loading" });
  assert.match(loadingHtml, /aria-busy="true"/);
  assert.match(loadingHtml, /class="start-session-button"[^>]*disabled/);
  assert.doesNotMatch(loadingHtml, /No enabled coding providers\./);

  const errorHtml = renderDialog({
    providerLoadStatus: "error",
    providerLoadError: "Catalog unavailable.",
  });
  assert.match(errorHtml, /role="alert"[^>]*>Catalog unavailable\.<\/p>/);
  assert.match(errorHtml, /class="start-session-button"[^>]*disabled/);
  assert.doesNotMatch(errorHtml, /No enabled coding providers\./);

  const readyZeroHtml = renderDialog({ providerLoadStatus: "loaded" });
  assert.equal((readyZeroHtml.match(/No enabled coding providers\./g) ?? []).length, 1);
  assert.doesNotMatch(readyZeroHtml, /class="launch-feedback"/);

  const readyHtml = renderDialog({
    providers: [{ id: "codex", label: "Codex" }],
    providerLoadStatus: "loaded",
  });
  assert.match(readyHtml, /aria-selected="true"[^>]*tabindex="0"/);
  assert.match(readyHtml, /class="start-session-button"[^>]*aria-disabled="false"/);
  assert.doesNotMatch(readyHtml, /launch-feedback[^>]*>No enabled coding providers\./);
});
