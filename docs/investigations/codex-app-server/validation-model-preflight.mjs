const MODEL_CATALOG_PAGE_LIMIT = 100;
const MAX_MODEL_CATALOG_PAGES = 20;

export const VALIDATION_MODEL_SELECTION = Object.freeze({
  model: "gpt-5.6-luna",
  reasoningEffort: "high",
});

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnique(values) {
  return new Set(values).size === values.length;
}

function haveSameMembers(left, right) {
  if (left.length !== right.length) return false;
  const rightMembers = new Set(right);
  return left.every((value) => rightMembers.has(value));
}

function modelEvidence(entry) {
  if (
    !isPlainObject(entry) ||
    entry.id !== VALIDATION_MODEL_SELECTION.model ||
    entry.model !== VALIDATION_MODEL_SELECTION.model ||
    typeof entry.hidden !== "boolean" ||
    typeof entry.defaultReasoningEffort !== "string" ||
    entry.defaultReasoningEffort.length === 0 ||
    !Array.isArray(entry.supportedReasoningEfforts)
  ) {
    return undefined;
  }
  const supportedReasoningEfforts = entry.supportedReasoningEfforts.map((option) =>
    isPlainObject(option) && typeof option.reasoningEffort === "string" && option.reasoningEffort.length > 0
      ? option.reasoningEffort
      : undefined,
  );
  if (
    supportedReasoningEfforts.includes(undefined) ||
    !isUnique(supportedReasoningEfforts) ||
    !supportedReasoningEfforts.includes(entry.defaultReasoningEffort) ||
    !supportedReasoningEfforts.includes(VALIDATION_MODEL_SELECTION.reasoningEffort)
  ) {
    return undefined;
  }
  return {
    model: VALIDATION_MODEL_SELECTION.model,
    modelId: entry.id,
    hidden: entry.hidden,
    reasoningEffort: VALIDATION_MODEL_SELECTION.reasoningEffort,
    defaultReasoningEffort: entry.defaultReasoningEffort,
    supportedReasoningEfforts,
  };
}

function providerCapabilitiesEvidence(value) {
  if (
    !isPlainObject(value) ||
    typeof value.imageGeneration !== "boolean" ||
    typeof value.namespaceTools !== "boolean" ||
    typeof value.webSearch !== "boolean"
  ) {
    return undefined;
  }
  return {
    imageGeneration: value.imageGeneration,
    namespaceTools: value.namespaceTools,
    webSearch: value.webSearch,
  };
}

async function readModelCatalog(requestResult, includeHidden) {
  let cursor;
  const observedCursors = new Set();
  const entries = [];
  for (let page = 0; page < MAX_MODEL_CATALOG_PAGES; page += 1) {
    const result = await requestResult("model/list", {
      limit: MODEL_CATALOG_PAGE_LIMIT,
      includeHidden,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!isPlainObject(result) || !Array.isArray(result.data) || result.data.length > MODEL_CATALOG_PAGE_LIMIT) {
      return undefined;
    }
    entries.push(...result.data);
    const nextCursor = result.nextCursor;
    if (nextCursor === null || nextCursor === undefined) return { entries, pages: page + 1 };
    if (typeof nextCursor !== "string" || nextCursor.length === 0 || observedCursors.has(nextCursor)) {
      return undefined;
    }
    observedCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return undefined;
}

export async function inspectValidationModelPreflight(requestResult) {
  const providerCapabilities = providerCapabilitiesEvidence(await requestResult("modelProvider/capabilities/read", {}));
  if (providerCapabilities === undefined) return undefined;
  const [visibleCatalog, completeCatalog] = await Promise.all([
    readModelCatalog(requestResult, false),
    readModelCatalog(requestResult, true),
  ]);
  if (visibleCatalog === undefined || completeCatalog === undefined) return undefined;

  const visibleIds = visibleCatalog.entries.map((entry) => entry?.id);
  const completeIds = completeCatalog.entries.map((entry) => entry?.id);
  if (
    visibleIds.some((id) => typeof id !== "string") ||
    completeIds.some((id) => typeof id !== "string") ||
    !isUnique(visibleIds) ||
    !isUnique(completeIds) ||
    visibleCatalog.entries.some((entry) => entry?.hidden !== false) ||
    completeCatalog.entries.some((entry) => typeof entry?.hidden !== "boolean")
  ) {
    return undefined;
  }
  const completeNonHiddenIds = completeCatalog.entries.filter((entry) => !entry.hidden).map((entry) => entry.id);
  if (!haveSameMembers(visibleIds, completeNonHiddenIds)) return undefined;

  const completeEntry = completeCatalog.entries.find(
    (entry) => entry?.id === VALIDATION_MODEL_SELECTION.model && entry?.model === VALIDATION_MODEL_SELECTION.model,
  );
  const model = modelEvidence(completeEntry);
  if (model === undefined) return undefined;
  const visibleEntry = visibleCatalog.entries.find(
    (entry) => entry?.id === VALIDATION_MODEL_SELECTION.model && entry?.model === VALIDATION_MODEL_SELECTION.model,
  );
  if ((model.hidden && visibleEntry !== undefined) || (!model.hidden && visibleEntry === undefined)) return undefined;

  return {
    model,
    providerCapabilities,
    visibility: {
      visibleCount: visibleCatalog.entries.length,
      completeCount: completeCatalog.entries.length,
      hiddenCount: completeCatalog.entries.filter((entry) => entry?.hidden === true).length,
      visiblePages: visibleCatalog.pages,
      completePages: completeCatalog.pages,
      validationModelHidden: model.hidden,
      includeHiddenContract: "verified",
    },
  };
}
