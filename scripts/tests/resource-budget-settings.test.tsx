import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";

import type { WithMateWindowApi } from "../../src/withmate-window-api.js";
import type { ResourceBudget, ResourceBudgetConfigureInput } from "../../src/resource-budget.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createBudget(revision: number, totalTurns: number): ResourceBudget {
  const dimensions = Object.fromEntries([
    "concurrentTurns", "queuedTurns", "totalTurns", "retries",
    "sessions", "workItems", "delegations", "storageBytes",
  ].map((dimension) => [dimension, {
    hardLimit: dimension === "totalTurns" ? totalTurns : 100,
    softLimit: null,
    committed: 0,
    reserved: 0,
    allocatedToChildren: 0,
    available: dimension === "totalTurns" ? totalTurns : 100,
    softLimitExceeded: false,
    measurement: "known",
    unknownSince: null,
  }])) as ResourceBudget["dimensions"];
  return {
    contractRevision: 1,
    accountId: "budget-root-1",
    accountKind: "root",
    rootSessionId: "root-1",
    ownerSessionId: "root-1",
    appliesToSessionId: "root-1",
    allocationSource: "owned",
    rootManagedDimensions: [],
    parentAccountId: null,
    authorityGrantId: null,
    authorityGrantRevision: null,
    expiresAt: null,
    revokedAt: null,
    deadlineAt: "2026-10-31T00:00:00.000Z",
    retryPerExecutionLimit: 3,
    revision,
    dimensions,
    alerts: [],
    meteredUsage: [],
    meteredUsageTruncated: false,
    meteredUsageSummary: {
      knownTokens: 0,
      knownProviderUsage: 0,
      monetaryCostByCurrency: {},
      unknownRecords: { tokens: 0, monetary_cost: 0, provider_usage: 0 },
    },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

// @test-value v2
// kind = "invariant"
// claim = "Resource budget Settings UIは同一draftのresponse消失後retryで同じidempotency keyを送り、成功後の次変更は新revisionと新keyで送る"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md" }
// fault = "response消失後の同一draft retryでkeyを変えるか、成功後の次変更へ古いrevisionまたはkeyを再利用する"
// observable = "DOMから保存操作したときconfigureResourceBudgetへ渡る3回のrequest"
// observation_boundary = "component-behavior"
// scope = "Resource budget Settings save retry"
// lifecycle = "permanent"
// distinction = "storage replayや入力validationではなく実Componentの保存retry identity遷移だけを検証する"
// @end-test-value
test("Resource budget Settings はresponse消失時の再保存と成功後の次保存を正しいidentityで送る", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousElement = globalThis.Element;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "Element", { value: dom.window.Element, configurable: true });
  Object.defineProperty(globalThis, "Node", { value: dom.window.Node, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

  const configureRequests: ResourceBudgetConfigureInput[] = [];
  const api = {
    listSessionSummaryPage: async () => ({
      entries: [{ id: "root-1", taskTitle: "Root 1" }],
      nextCursor: null,
      hasMore: false,
    }),
    getResourceBudget: async () => createBudget(1, 1_000),
    configureResourceBudget: async (input: ResourceBudgetConfigureInput) => {
      configureRequests.push(input);
      if (configureRequests.length === 1) throw new Error("response lost");
      return createBudget(input.expectedRevision + 1, input.hardLimits?.totalTurns ?? 1_000);
    },
  } as unknown as WithMateWindowApi;
  Object.defineProperty(dom.window, "withmate", { value: api, configurable: true });

  const { createRoot } = await import("react-dom/client");
  const { ResourceBudgetSettings } = await import("../../src/settings/ResourceBudgetSettings.js");
  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  const root = createRoot(rootElement);
  const flush = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  const findTotalTurnsInput = () => Array.from(rootElement.querySelectorAll("label"))
    .find((label) => label.textContent?.includes("累積 Turnの hard limit"))
    ?.querySelector<HTMLInputElement>("input");
  const setInputValue = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
      assert.ok(setter);
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await flush();
    });
  };
  const clickSave = async () => {
    const button = Array.from(rootElement.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent === "Resource budget を保存");
    assert.ok(button);
    assert.equal(button.disabled, false);
    await act(async () => {
      button.click();
      await flush();
    });
  };

  try {
    await act(async () => {
      root.render(<ResourceBudgetSettings />);
      await flush();
      await flush();
    });

    const firstInput = findTotalTurnsInput();
    assert.ok(firstInput);
    await setInputValue(firstInput, "2000");
    await clickSave();
    await clickSave();

    const secondInput = findTotalTurnsInput();
    assert.ok(secondInput);
    await setInputValue(secondInput, "3000");
    await clickSave();

    assert.equal(configureRequests.length, 3);
    assert.deepEqual(configureRequests[0], configureRequests[1]);
    assert.equal(configureRequests[0]?.expectedRevision, 1);
    assert.deepEqual(configureRequests[0]?.hardLimits, { totalTurns: 2_000 });
    assert.equal(configureRequests[2]?.expectedRevision, 2);
    assert.deepEqual(configureRequests[2]?.hardLimits, { totalTurns: 3_000 });
    assert.notEqual(configureRequests[2]?.idempotencyKey, configureRequests[1]?.idempotencyKey);
  } finally {
    await act(async () => root.unmount());
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
    Object.defineProperty(globalThis, "Element", { value: previousElement, configurable: true });
    Object.defineProperty(globalThis, "Node", { value: previousNode, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: previousNavigator, configurable: true });
    dom.window.close();
  }
});
