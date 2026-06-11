import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ModelCatalogProvider } from "../../src/model-catalog.js";
import {
  applyAuxiliaryLaunchDialogState,
  AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK,
  AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK,
  AUXILIARY_LAUNCH_START_FAILED_FEEDBACK,
  buildCreateAuxiliarySessionInput,
  buildAuxiliaryLaunchProviderItems,
  createAuxiliaryLaunchDialogCloseHandler,
  createAuxiliaryLaunchDialogOpenHandler,
  createAuxiliaryLaunchProviderSelectHandler,
  resolveAuxiliaryLaunchFeedbackResetState,
  resolveAuxiliaryLaunchOpenState,
  resolveAuxiliaryLaunchCloseState,
  resolveAuxiliaryLaunchSessionDefaults,
  resolveAuxiliaryLaunchProviderSelectionState,
  resolveAuxiliaryLaunchInitialState,
  resolveAuxiliaryLaunchProviderId,
  resolveAuxiliaryLaunchStartError,
  resolveAuxiliaryLaunchStartProvider,
  resolveAuxiliaryLaunchStartErrorState,
  resolveAuxiliaryLaunchStartErrorFeedback,
} from "../../src/chat/auxiliary-launch-state.js";

function makeProvider(
  id: string,
  label: string,
  options: { hasModel?: boolean } = {},
): ModelCatalogProvider {
  const hasModel = options.hasModel ?? true;
  return {
    id,
    label,
    defaultModelId: hasModel ? "gpt-5.4-mini" : "",
    defaultReasoningEffort: "high",
    models: hasModel
      ? [{
        id: "gpt-5.4-mini",
        label: "GPT 5.4 mini",
        reasoningEfforts: ["high"],
      }]
      : [],
  };
}

describe("auxiliary-launch-state", () => {
  it("provider filter と item 化を provider 条件で行う", () => {
    const providers: ModelCatalogProvider[] = [
      makeProvider("a", "A", { hasModel: false }),
      makeProvider("b", "B"),
      makeProvider("c", "C", { hasModel: false }),
      makeProvider("d", "D"),
    ];
    const items = buildAuxiliaryLaunchProviderItems(providers, (provider) => provider.models.length > 0);

    assert.deepEqual(items, [
      { id: "b", label: "B" },
      { id: "d", label: "D" },
    ]);
  });

  it("create input は parent/provider と launch defaults を引き継ぐ", () => {
    assert.deepEqual(
      buildCreateAuxiliarySessionInput({
        parentSessionId: "session-1",
        provider: "codex",
        defaults: {
          model: "gpt-5.4-mini",
          reasoningEffort: "high",
          customAgentName: "planner",
        },
      }),
      {
        parentSessionId: "session-1",
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "high",
        customAgentName: "planner",
      },
    );
  });

  it("create input は defaults がないとき optional field を undefined にする", () => {
    assert.deepEqual(
      buildCreateAuxiliarySessionInput({
        parentSessionId: "session-1",
        provider: "codex",
        defaults: null,
      }),
      {
        parentSessionId: "session-1",
        provider: "codex",
        model: undefined,
        reasoningEffort: undefined,
        customAgentName: undefined,
      },
    );
  });

  it("launch defaults は同じ provider の場合だけ引き継ぐ", () => {
    const defaults = {
      model: "gpt-5.4-mini",
      reasoningEffort: "high" as const,
      customAgentName: "planner",
    };

    assert.equal(
      resolveAuxiliaryLaunchSessionDefaults({
        providerId: "codex",
        defaultsProviderId: "codex",
        defaults,
      }),
      defaults,
    );
    assert.equal(
      resolveAuxiliaryLaunchSessionDefaults({
        providerId: "copilot",
        defaultsProviderId: "codex",
        defaults,
      }),
      null,
    );
    assert.equal(
      resolveAuxiliaryLaunchSessionDefaults({
        providerId: "codex",
        defaultsProviderId: "codex",
        defaults: null,
      }),
      null,
    );
  });

  it("start error は blocked feedback を provider 未選択より優先する", () => {
    const error = resolveAuxiliaryLaunchStartError({
      providerId: null,
      blockedFeedback: "blocked",
    });

    assert.equal(error?.message, "blocked");
  });

  it("start error は provider 未選択 error を返す", () => {
    const error = resolveAuxiliaryLaunchStartError({
      providerId: null,
    });

    assert.equal(error?.message, AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK);
  });

  it("start error は開始可能なとき null を返す", () => {
    assert.equal(
      resolveAuxiliaryLaunchStartError({
        providerId: "codex",
        blockedFeedback: null,
      }),
      null,
    );
  });

  it("start provider resolution は開始可能な provider id を返す", () => {
    assert.deepEqual(
      resolveAuxiliaryLaunchStartProvider({
        providerId: "codex",
        blockedFeedback: null,
      }),
      {
        status: "ready",
        providerId: "codex",
      },
    );
  });

  it("start provider resolution は blocked feedback を provider 未選択より優先する", () => {
    const result = resolveAuxiliaryLaunchStartProvider({
      providerId: null,
      blockedFeedback: "blocked",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.status === "blocked" ? result.error.message : null, "blocked");
  });

  it("start provider resolution は provider 未選択を blocked にする", () => {
    const result = resolveAuxiliaryLaunchStartProvider({
      providerId: null,
    });

    assert.equal(result.status, "blocked");
    assert.equal(
      result.status === "blocked" ? result.error.message : null,
      AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK,
    );
  });

  it("resolve 初期 provider は current provider を優先し、なければ先頭を使う", () => {
    const items = [
      { id: "b", label: "B" },
      { id: "d", label: "D" },
    ];

    assert.equal(resolveAuxiliaryLaunchProviderId(items, "d"), "d");
    assert.equal(resolveAuxiliaryLaunchProviderId(items, "missing"), "b");
  });

  it("初期 state は provider 解決と feedback を同時に返す", () => {
    const items = [
      { id: "b", label: "B" },
      { id: "d", label: "D" },
    ];

    assert.deepEqual(resolveAuxiliaryLaunchInitialState(items, "d"), {
      providerId: "d",
      feedback: "",
    });
    assert.deepEqual(resolveAuxiliaryLaunchInitialState(items, "missing"), {
      providerId: "b",
      feedback: "",
    });
  });

  it("close state は dialog close と feedback empty を返す", () => {
    assert.deepEqual(resolveAuxiliaryLaunchCloseState(), {
      open: false,
      feedback: "",
    });
  });

  it("provider 選択 state は providerId を引き継ぎ feedback empty を返す", () => {
    assert.deepEqual(resolveAuxiliaryLaunchProviderSelectionState("selected-id"), {
      providerId: "selected-id",
      feedback: "",
    });
  });

  it("start error feedback は Error message を優先し fallback 文言を返す", () => {
    assert.equal(resolveAuxiliaryLaunchStartErrorFeedback(new Error("failed")), "failed");
    assert.equal(resolveAuxiliaryLaunchStartErrorFeedback("failed"), AUXILIARY_LAUNCH_START_FAILED_FEEDBACK);
  });

  it("open state は provider 解決結果と feedback を反映し open を返す", () => {
    const items = [
      { id: "b", label: "B" },
      { id: "d", label: "D" },
    ];

    assert.deepEqual(resolveAuxiliaryLaunchOpenState(items, "d"), {
      open: true,
      providerId: "d",
      feedback: "",
    });
    assert.deepEqual(resolveAuxiliaryLaunchOpenState(items, "missing"), {
      open: true,
      providerId: "b",
      feedback: "",
    });
  });

  it("feedback reset state は feedback 空文字を返す", () => {
    assert.deepEqual(resolveAuxiliaryLaunchFeedbackResetState(), {
      feedback: "",
    });
  });

  it("start error state は feedback のみを返す", () => {
    assert.deepEqual(resolveAuxiliaryLaunchStartErrorState(new Error("failed")), {
      feedback: "failed",
    });
    assert.deepEqual(resolveAuxiliaryLaunchStartErrorState("failed"), {
      feedback: AUXILIARY_LAUNCH_START_FAILED_FEEDBACK,
    });
  });

  it("open handler は開始可能な場合だけ dialog open callback を呼ぶ", () => {
    const events: string[] = [];
    const providers = [{ id: "codex", label: "Codex" }];
    const open = createAuxiliaryLaunchDialogOpenHandler({
      canOpen: () => true,
      providers,
      getSelectedProviderId: () => "codex",
      openAuxiliaryLaunchDialog: (params) => {
        events.push(`${params.selectedProviderId}:${params.providers.map((provider) => provider.id).join(",")}`);
      },
    });
    const blockedOpen = createAuxiliaryLaunchDialogOpenHandler({
      canOpen: () => false,
      providers,
      getSelectedProviderId: () => "codex",
      openAuxiliaryLaunchDialog: () => {
        events.push("blocked");
      },
    });

    open();
    blockedOpen();

    assert.deepEqual(events, ["codex:codex"]);
  });

  it("close handler は close 可能な場合だけ dialog close callback を呼ぶ", () => {
    const events: string[] = [];
    const close = createAuxiliaryLaunchDialogCloseHandler({
      canClose: () => true,
      closeAuxiliaryLaunchDialog: () => events.push("close"),
    });
    const blockedClose = createAuxiliaryLaunchDialogCloseHandler({
      canClose: () => false,
      closeAuxiliaryLaunchDialog: () => events.push("blocked"),
    });

    close();
    blockedClose();

    assert.deepEqual(events, ["close"]);
  });

  it("provider select handler は provider id を select callback へ渡す", () => {
    const values: string[] = [];
    const selectProvider = createAuxiliaryLaunchProviderSelectHandler({
      selectAuxiliaryLaunchProvider: (providerId) => values.push(providerId),
    });

    selectProvider("copilot");

    assert.deepEqual(values, ["copilot"]);
  });

  it("apply した patch は指定フィールドのみ更新する", () => {
    let open = false;
    let providerId: string | null = "keep-provider";
    let feedback = "initial";

    applyAuxiliaryLaunchDialogState(
      (nextOpen) => {
        open = nextOpen;
      },
      (nextProviderId) => {
        providerId = nextProviderId;
      },
      (nextFeedback) => {
        feedback = nextFeedback;
      },
      { open: true, feedback: "" },
    );

    assert.equal(open, true);
    assert.equal(providerId, "keep-provider");
    assert.equal(feedback, "");
  });

  it("provider が空のときは resolveAuxiliaryLaunchProviderId が null を返す", () => {
    const emptyItems: Array<{ id: string; label: string }> = [];

    assert.equal(resolveAuxiliaryLaunchProviderId(emptyItems, "codex"), null);
  });

  it("provider が空のときは初期 state の feedback が空 provider 用になる", () => {
    const emptyItems: Array<{ id: string; label: string }> = [];

    assert.deepEqual(resolveAuxiliaryLaunchInitialState(emptyItems, "codex"), {
      providerId: null,
      feedback: AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK,
    });
  });

  it("feedback 文言は固定文言を使う", () => {
    assert.equal(AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK, "有効な Coding Provider がないよ。");
    assert.equal(AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK, "有効な Coding Provider を選んでね。");
  });
});
