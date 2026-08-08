import assert from "node:assert/strict";

import { inspectValidationModelPreflight, VALIDATION_MODEL_SELECTION } from "./validation-model-preflight.mjs";

const capabilities = Object.freeze({
  imageGeneration: true,
  namespaceTools: true,
  webSearch: true,
});

function modelEntry(overrides = {}) {
  return {
    id: VALIDATION_MODEL_SELECTION.model,
    model: VALIDATION_MODEL_SELECTION.model,
    hidden: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: VALIDATION_MODEL_SELECTION.reasoningEffort },
    ],
    ...overrides,
  };
}

function catalogRequest({ visible, complete }) {
  return async (method, params) => {
    if (method === "modelProvider/capabilities/read") return capabilities;
    if (method === "model/list") {
      return {
        data: structuredClone(params.includeHidden ? complete : visible),
        nextCursor: null,
      };
    }
    throw new Error(`unexpected method: ${method}`);
  };
}

async function inspectCatalog({ visible, complete }) {
  return inspectValidationModelPreflight(catalogRequest({ visible, complete }));
}

const luna = modelEntry();
const hiddenModel = {
  id: "hidden-model",
  model: "hidden-model",
  hidden: true,
};

const accepted = await inspectCatalog({ visible: [luna], complete: [luna, hiddenModel] });
assert.equal(accepted?.model.model, VALIDATION_MODEL_SELECTION.model);
assert.equal(accepted?.model.reasoningEffort, "high");
assert.notEqual(accepted?.model.reasoningEffort, "ultra");
assert.equal(accepted?.model.defaultReasoningEffort, "medium");

for (const malformedHidden of [undefined, "false", 0, null]) {
  const malformed = modelEntry({ hidden: malformedHidden });
  assert.equal(
    await inspectCatalog({ visible: [malformed], complete: [malformed] }),
    undefined,
    `Luna hidden=${String(malformedHidden)} must fail closed`,
  );
}

for (const malformedDefault of [undefined, "", "unsupported"]) {
  const malformed = modelEntry({ defaultReasoningEffort: malformedDefault });
  assert.equal(
    await inspectCatalog({ visible: [malformed], complete: [malformed] }),
    undefined,
    `Luna defaultReasoningEffort=${String(malformedDefault)} must fail closed`,
  );
}

const missingHigh = modelEntry({
  supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
});
assert.equal(await inspectCatalog({ visible: [missingHigh], complete: [missingHigh] }), undefined);

const completeOnlyNonHidden = {
  id: "complete-only-visible-model",
  model: "complete-only-visible-model",
  hidden: false,
};
assert.equal(
  await inspectCatalog({ visible: [luna], complete: [luna, completeOnlyNonHidden] }),
  undefined,
  "complete-only non-hidden IDs must fail the exact visible-set contract",
);

const hiddenLuna = modelEntry({ hidden: true });
assert.equal((await inspectCatalog({ visible: [], complete: [hiddenLuna] }))?.model.hidden, true);

console.log(
  JSON.stringify({
    ok: true,
    selection: VALIDATION_MODEL_SELECTION,
    negativeContracts: [
      "malformed_hidden",
      "malformed_default_reasoning_effort",
      "unsupported_default_reasoning_effort",
      "missing_selected_reasoning_effort",
      "complete_only_non_hidden_model",
    ],
  }),
);
