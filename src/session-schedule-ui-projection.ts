import type {
  SessionScheduleFire,
  SessionScheduleProjection,
  SessionScheduleState,
  SessionScheduleTrigger,
} from "./session-schedule.js";
import type { ComposerAttachment } from "./runtime-state.js";
import {
  buildComposerReferenceInsertionState,
  removePathReferenceTokensFromDraft,
} from "./session-composer-paths.js";

export type ScheduleTriggerProjection = SessionScheduleTrigger;
export type ScheduleStatusProjection = SessionScheduleState;
export type ScheduleLastFireStatus = "success" | "error";

export type ScheduleSummaryProjection = Pick<
  SessionScheduleProjection,
  "id" | "sessionId" | "revision" | "name" | "state" | "trigger" | "nextFireAt"
> & {
  sessionTitle: string;
  status: ScheduleStatusProjection;
  lastFireAt: string | null;
  lastFireStatus: ScheduleLastFireStatus | null;
};

export function projectScheduleLastFire(
  fire: Pick<SessionScheduleFire, "state" | "updatedAt"> | null,
): {
  lastFireAt: string | null;
  lastFireStatus: ScheduleLastFireStatus | null;
} {
  if (!fire || (fire.state !== "enqueued" && fire.state !== "failed")) {
    return {
      lastFireAt: null,
      lastFireStatus: null,
    };
  }
  return {
    lastFireAt: fire.updatedAt,
    lastFireStatus: fire.state === "failed" ? "error" : "success",
  };
}

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

export function resolveSystemScheduleTimeZone(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
  if (!timeZone) {
    throw new Error("PCのローカルタイムゾーンを取得できませんでした。");
  }
  return timeZone;
}

export function cloneScheduleDraft(
  draft: ScheduleDraftProjection,
): ScheduleDraftProjection {
  return {
    ...draft,
    trigger: { ...draft.trigger },
    attachments: [...draft.attachments],
  };
}

export function buildScheduleDraftComposerState(
  prompt: string,
  attachments: readonly ComposerAttachment[],
): Pick<ScheduleDraftProjection, "prompt" | "attachments"> {
  const attachmentPaths = attachments.map((attachment) => attachment.absolutePath);
  const removalTargets = attachments.flatMap((attachment) => [
    attachment.absolutePath,
    attachment.displayPath,
    attachment.workspaceRelativePath,
  ]).filter((path): path is string => Boolean(path));
  const promptWithoutReferences = removePathReferenceTokensFromDraft(prompt, removalTargets);
  const insertion = buildComposerReferenceInsertionState(
    promptWithoutReferences,
    promptWithoutReferences.length,
    attachments.map((attachment) => ({
      path: attachment.absolutePath,
      presentation: attachment.source === "markdown-image" ? "image" : "path",
    })),
  );

  return {
    prompt: insertion?.draft ?? promptWithoutReferences,
    attachments: attachmentPaths,
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
