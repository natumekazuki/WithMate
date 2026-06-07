import type { ApprovalMode } from "./approval-mode.js";
import type { CodexSandboxMode } from "./codex-sandbox-mode.js";
import {
  resolveModelChangeSelection,
  resolveModelSelection,
  type ModelCatalogProvider,
  type ModelReasoningEffort,
  type ResolvedModelSelection,
} from "./model-catalog.js";

type ApprovalModeSessionLike = {
  approvalMode: ApprovalMode;
};

type CodexSandboxModeSessionLike = {
  codexSandboxMode: CodexSandboxMode;
};

type ModelRuntimeSessionLike = {
  catalogRevision: number;
  model: string;
  reasoningEffort: ModelReasoningEffort;
};

type ModelRuntimeSessionPatch = {
  catalogRevision: number;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  updatedAt: string;
};

type RuntimeOptionValueOption<TValue> = {
  value: TValue;
};

export function buildSessionWithApprovalMode<TSession extends ApprovalModeSessionLike>(
  session: TSession,
  approvalMode: ApprovalMode,
  updatedAt: string,
): (TSession & { approvalMode: ApprovalMode; updatedAt: string }) | null {
  if (approvalMode === session.approvalMode) {
    return null;
  }
  return {
    ...session,
    approvalMode,
    updatedAt,
  };
}

export function buildSessionWithCodexSandboxMode<TSession extends CodexSandboxModeSessionLike>(
  session: TSession,
  codexSandboxMode: CodexSandboxMode,
  updatedAt: string,
): (TSession & { codexSandboxMode: CodexSandboxMode; updatedAt: string }) | null {
  if (codexSandboxMode === session.codexSandboxMode) {
    return null;
  }
  return {
    ...session,
    codexSandboxMode,
    updatedAt,
  };
}

function buildSessionWithResolvedModelSelection<TSession extends ModelRuntimeSessionLike>(
  session: TSession,
  selection: ResolvedModelSelection,
  catalogRevision: number,
  updatedAt: string,
): TSession & ModelRuntimeSessionPatch {
  return {
    ...session,
    catalogRevision,
    model: selection.resolvedModel,
    reasoningEffort: selection.resolvedReasoningEffort,
    updatedAt,
  };
}

export function buildSessionWithModelChange<TSession extends ModelRuntimeSessionLike>(
  session: TSession,
  providerCatalog: ModelCatalogProvider,
  model: string,
  catalogRevision: number,
  updatedAt: string,
): TSession & ModelRuntimeSessionPatch {
  const selection = resolveModelChangeSelection(providerCatalog, model, session.reasoningEffort);
  return buildSessionWithResolvedModelSelection(session, selection, catalogRevision, updatedAt);
}

export function buildSessionWithReasoningEffort<TSession extends ModelRuntimeSessionLike>(
  session: TSession,
  providerCatalog: ModelCatalogProvider,
  reasoningEffort: ModelReasoningEffort,
  catalogRevision: number,
  updatedAt: string,
): TSession & ModelRuntimeSessionPatch {
  const selection = resolveModelSelection(providerCatalog, session.model, reasoningEffort);
  return buildSessionWithResolvedModelSelection(session, selection, catalogRevision, updatedAt);
}

export function resolveRuntimeOptionValue<TValue>(
  selectedValue: TValue,
  options: readonly RuntimeOptionValueOption<TValue>[],
  fallbackValue: TValue,
): TValue {
  if (options.some((option) => option.value === selectedValue)) {
    return selectedValue;
  }

  return options[0]?.value ?? fallbackValue;
}
