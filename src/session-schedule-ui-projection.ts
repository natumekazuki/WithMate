import type {
  SessionScheduleProjection,
  SessionScheduleState,
  SessionScheduleTrigger,
} from "./session-schedule.js";

export type ScheduleTriggerProjection = SessionScheduleTrigger;
export type ScheduleStatusProjection = SessionScheduleState;

export type ScheduleSummaryProjection = Pick<
  SessionScheduleProjection,
  "id" | "sessionId" | "revision" | "name" | "state" | "trigger" | "nextFireAt"
> & {
  sessionTitle: string;
  status: ScheduleStatusProjection;
  lastFireResult?: string | null;
  lastExecutionId?: string | null;
};

export type ScheduleDraftProjection = {
  id?: string;
  sessionId: string;
  name: string;
  trigger: ScheduleTriggerProjection;
  prompt: string;
  attachments: readonly string[];
  model: string;
  reasoningEffort: string;
  approvalMode: string;
  sandboxMode: string;
  customAgent: string | null;
};

export type ScheduleWorkspaceLoadState = "loading" | "loaded" | "error";
export type ScheduleWorkspaceMode = "list" | "create" | "edit";

export type ScheduleWorkspaceProjection = {
  mode: ScheduleWorkspaceMode;
  state: "loading" | "empty" | "list" | "editor" | "error";
  canMutate: boolean;
  schedules: readonly ScheduleSummaryProjection[];
  draft: ScheduleDraftProjection | null;
  errorMessage: string | null;
};

export function cloneScheduleDraft(
  draft: ScheduleDraftProjection,
): ScheduleDraftProjection {
  return {
    ...draft,
    trigger: { ...draft.trigger },
    attachments: [...draft.attachments],
  };
}

export function buildScheduleWorkspaceProjection(input: {
  mode: ScheduleWorkspaceMode;
  loadState: ScheduleWorkspaceLoadState;
  schedules: readonly ScheduleSummaryProjection[];
  draft?: ScheduleDraftProjection | null;
  errorMessage?: string | null;
  canMutate?: boolean;
}): ScheduleWorkspaceProjection {
  const errorMessage = input.errorMessage?.trim() || null;
  const state =
    input.loadState === "loading"
      ? "loading"
      : input.loadState === "error"
        ? "error"
        : input.mode === "list"
          ? input.schedules.length === 0
            ? "empty"
            : "list"
          : "editor";

  return {
    mode: input.mode,
    state,
    canMutate: input.canMutate ?? true,
    schedules: input.schedules,
    draft: input.draft ? cloneScheduleDraft(input.draft) : null,
    errorMessage,
  };
}
