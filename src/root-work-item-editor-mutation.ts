import type { RootWorkItem } from "./work-item.js";

export type RootWorkItemEditorInput = {
  expectedRevision: number;
  goal: string;
  scope: string;
  completionCriteria: string;
  authority: string;
  progressSummary: string;
  blockers: string[];
  nextAction: string;
};

export class RootWorkItemEditorSaveError extends Error {
  constructor(
    message: string,
    readonly contractRevisionCommitted: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RootWorkItemEditorSaveError";
  }
}

export async function saveRootWorkItemEditor(
  initial: RootWorkItem,
  input: RootWorkItemEditorInput,
  deps: {
    revise(request: {
      goal: string;
      scope: string;
      completionCriteria: string;
      authority: string;
      expectedRevision: number;
      idempotencyKey: string;
    }): Promise<RootWorkItem>;
    appendProgress(request: {
      type: "progress";
      summary: string;
      blockers: string[];
      nextAction: string;
      expectedRevision: number;
      idempotencyKey: string;
    }): Promise<RootWorkItem>;
    createIdempotencyKey(): string;
  },
): Promise<RootWorkItem> {
  let current = initial;
  let contractRevisionCommitted = false;
  try {
    const contractChanged = current.goal !== input.goal
      || current.scope !== input.scope
      || current.completionCriteria !== input.completionCriteria
      || current.authority !== input.authority;
    if (contractChanged) {
      current = await deps.revise({
        goal: input.goal,
        scope: input.scope,
        completionCriteria: input.completionCriteria,
        authority: input.authority,
        expectedRevision: input.expectedRevision,
        idempotencyKey: deps.createIdempotencyKey(),
      });
      contractRevisionCommitted = true;
    }
    const progressChanged = current.progressSummary !== input.progressSummary
      || current.nextAction !== input.nextAction
      || current.blockers.length !== input.blockers.length
      || current.blockers.some((blocker, index) => blocker !== input.blockers[index]);
    if (progressChanged) {
      current = await deps.appendProgress({
        type: "progress",
        summary: input.progressSummary,
        blockers: input.blockers,
        nextAction: input.nextAction,
        expectedRevision: contractRevisionCommitted ? current.revision : input.expectedRevision,
        idempotencyKey: deps.createIdempotencyKey(),
      });
    }
    return current;
  } catch (error) {
    throw new RootWorkItemEditorSaveError(
      error instanceof Error ? error.message : "Root WorkItemの更新に失敗しました。",
      contractRevisionCommitted,
      { cause: error },
    );
  }
}
