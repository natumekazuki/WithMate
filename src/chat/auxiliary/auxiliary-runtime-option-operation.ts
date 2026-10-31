import type { ApprovalMode } from "../../../src-shared/settings/approval-mode.js";
import type { CodexSandboxMode } from "../../../src-shared/settings/codex-sandbox-mode.js";
import type { CodexSpeed } from "../../../src-shared/settings/codex-speed.js";
import type { CodexReviewer } from "../../../src-shared/settings/codex-reviewer.js";
import {
  applyAuxiliarySessionApprovalModeChange,
  applyAuxiliarySessionRuntimeOptionsPatch,
  applyAuxiliarySessionCodexSandboxModeChange,
  applyAuxiliarySessionCodexSpeedChange,
  applyAuxiliarySessionCodexReviewerChange,
  applyAuxiliarySessionModelChange,
  applyAuxiliarySessionReasoningEffortChange,
  type AuxiliarySession,
} from "../../../src-shared/auxiliary/auxiliary-session-state.js";
import type { ModelCatalogItem, ModelCatalogProvider, ModelReasoningEffort } from "../../../src-shared/settings/model-catalog.js";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import { captureSessionExecutionOptions } from "../../../src-shared/session/session-execution-options.js";
import type { ConfirmedReviewerChange } from "../../../src-shared/session/session-mutation-contract.js";
import type { AuxiliarySessionBinding } from "../use-auxiliary-workspace.js";

export class AuxiliaryExecutionOptionsOwner {
  private readonly revisions = new Map<string, number>();

  async update(input: {
    api: Pick<WithMateWindowApi, "setAuxiliaryExecutionOptions" | "getAuxiliarySession" | "reportRendererLog"> | null;
    binding: Pick<AuxiliarySessionBinding, "getSession" | "setExecutionSelection">;
    isReadOnly: boolean;
    recipe: (current: AuxiliarySession) => AuxiliarySession;
    confirmedReviewerChange?: ConfirmedReviewerChange;
    onFeedback: (feedback: { ownerId: string; message: string } | null) => void;
  }): Promise<void> {
    const { api, binding } = input;
    const current = binding.getSession();
    if (!api || !current || input.isReadOnly) return;
    const next = input.recipe(current);
    if (next === current) return;
    if (input.confirmedReviewerChange && (current.provider !== "claude"
      || current.codexReviewer !== "auto-review"
      || current.approvalMode !== input.confirmedReviewerChange.previousApprovalMode)) return;
    if (!input.confirmedReviewerChange && current.approvalMode === "never" && next.codexReviewer !== current.codexReviewer) return;
    const key = `${current.id}:${current.createdAt}`;
    const revision = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.set(key, revision);
    const isCurrent = () => {
      const latest = binding.getSession();
      return this.revisions.get(key) === revision && latest?.id === current.id && latest.createdAt === current.createdAt;
    };
    input.onFeedback(null);
    binding.setExecutionSelection(next);
    void api.setAuxiliaryExecutionOptions({
      auxiliarySessionId: current.id,
      parentSessionId: current.parentSessionId,
      createdAt: current.createdAt,
      executionOptions: captureSessionExecutionOptions(next),
      ...(input.confirmedReviewerChange ? { confirmedReviewerChange: input.confirmedReviewerChange } : {}),
    }).then((result) => {
      if (result.status === "accepted" && !result.checkpointSaved) {
        void api.reportRendererLog({ level: "error", kind: "renderer.auxiliary-execution-options.failed", message: "Auxiliary execution options could not be saved", data: { auxiliarySessionId: current.id } });
      }
    }).catch((error: unknown) => {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      input.onFeedback({ ownerId: current.id, message: `Execution options were not changed: ${message}` });
      void api.getAuxiliarySession(current.id).then((accepted) => {
        const latest = binding.getSession();
        if (!isCurrent() || !latest || accepted?.id !== current.id || accepted.createdAt !== current.createdAt) return;
        binding.setExecutionSelection({ ...latest, ...captureSessionExecutionOptions(accepted) });
      }).catch(() => undefined);
    });
  }
}

type UpdateActiveAuxiliarySession = (
  recipe: (current: AuxiliarySession) => AuxiliarySession,
  confirmedReviewerChange?: ConfirmedReviewerChange,
) => Promise<void>;

export async function runAuxiliaryApprovalModeChangeOperation(input: {
  approvalMode: ApprovalMode;
  confirmedReviewerChange?: ConfirmedReviewerChange;
  updateActiveAuxiliarySession: UpdateActiveAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  await input.updateActiveAuxiliarySession((current) => (
    input.confirmedReviewerChange
      ? applyAuxiliarySessionRuntimeOptionsPatch(current, { approvalMode: input.approvalMode, codexReviewer: "user" }, input.createTimestampLabel())
      : applyAuxiliarySessionApprovalModeChange(current, input.approvalMode, input.createTimestampLabel())
  ), input.confirmedReviewerChange);
}

export async function runAuxiliarySandboxModeChangeOperation(input: {
  codexSandboxMode: CodexSandboxMode;
  updateActiveAuxiliarySession: UpdateActiveAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  await input.updateActiveAuxiliarySession((current) => (
    applyAuxiliarySessionCodexSandboxModeChange(current, input.codexSandboxMode, input.createTimestampLabel())
  ));
}

export async function runAuxiliaryCodexSpeedChangeOperation(input: {
  codexSpeed: CodexSpeed;
  updateActiveAuxiliarySession: UpdateActiveAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  await input.updateActiveAuxiliarySession((current) => (
    applyAuxiliarySessionCodexSpeedChange(current, input.codexSpeed, input.createTimestampLabel())
  ));
}

export async function runAuxiliaryCodexReviewerChangeOperation(input: {
  codexReviewer: CodexReviewer;
  updateActiveAuxiliarySession: UpdateActiveAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  await input.updateActiveAuxiliarySession((current) => (
    applyAuxiliarySessionCodexReviewerChange(current, input.codexReviewer, input.createTimestampLabel())
  ));
}

export async function runAuxiliaryModelChangeOperation(input: {
  model: ModelCatalogItem;
  updateActiveAuxiliarySession: UpdateActiveAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  await input.updateActiveAuxiliarySession((current) => (
    applyAuxiliarySessionModelChange(
      current,
      input.model,
      input.createTimestampLabel(),
    )
  ));
}

export async function runAuxiliaryReasoningEffortChangeOperation(input: {
  reasoningEffort: ModelReasoningEffort;
  providerCatalog: ModelCatalogProvider;
  updateActiveAuxiliarySession: UpdateActiveAuxiliarySession;
  createTimestampLabel: () => string;
}): Promise<void> {
  await input.updateActiveAuxiliarySession((current) => (
    applyAuxiliarySessionReasoningEffortChange(
      current,
      input.providerCatalog,
      input.reasoningEffort,
      input.createTimestampLabel(),
    )
  ));
}
