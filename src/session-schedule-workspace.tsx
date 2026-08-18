import { useMemo } from "react";

import { BackNavigationButton } from "./back-navigation-button.js";
import { listNextSessionScheduleTriggerInstants } from "./session-schedule-trigger.js";
import {
  buildScheduleWorkspaceProjection,
  type ScheduleDraftProjection,
  type ScheduleSummaryProjection,
  type ScheduleWorkspaceLoadState,
  type ScheduleWorkspaceMode,
} from "./session-schedule-ui-projection.js";

export type ScheduleWorkspaceProps = {
  mode: ScheduleWorkspaceMode;
  loadState: ScheduleWorkspaceLoadState;
  schedules: readonly ScheduleSummaryProjection[];
  draft?: ScheduleDraftProjection | null;
  errorMessage?: string | null;
  isHome?: boolean;
  onBack: () => void;
  onCreate?: () => void;
  onEdit?: (schedule: ScheduleSummaryProjection) => void;
  onPause?: (schedule: ScheduleSummaryProjection) => void;
  onResume?: (schedule: ScheduleSummaryProjection) => void;
  onDelete?: (schedule: ScheduleSummaryProjection) => void;
  onRunNow?: (schedule: ScheduleSummaryProjection) => void;
  onOpenSession?: (sessionId: string) => void;
  onDraftChange?: (draft: ScheduleDraftProjection) => void;
  previewNow?: Date;
};

function ScheduleIconButton({
  label,
  icon,
  onClick,
  disabled = false,
  danger = false,
}: {
  label: string;
  icon: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`schedule-icon-button${danger ? " danger" : ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled || !onClick}
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  );
}

function formatTrigger(trigger: ScheduleSummaryProjection["trigger"]): string {
  return trigger.type === "cron"
    ? trigger.expression
    : trigger.localDateTime.replace("T", " ");
}

function formatPreviewInstant(instant: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(instant);
}

function statusLabel(status: ScheduleSummaryProjection["status"]): string {
  switch (status) {
    case "paused":
      return "一時停止中";
    case "completed":
      return "完了";
    default:
      return "有効";
  }
}

function ScheduleList({
  schedules,
  isHome,
  canMutate,
  onCreate,
  onEdit,
  onPause,
  onResume,
  onDelete,
  onRunNow,
  onOpenSession,
}: Pick<
  ScheduleWorkspaceProps,
  | "schedules"
  | "isHome"
  | "onCreate"
  | "onEdit"
  | "onPause"
  | "onResume"
  | "onDelete"
  | "onRunNow"
  | "onOpenSession"
> & { canMutate: boolean }) {
  const renderMain = (schedule: ScheduleSummaryProjection) => (
    <div className="schedule-list-main">
      <div className="schedule-list-heading">
        <strong>{schedule.name}</strong>
        <span className="schedule-status" data-status={schedule.status}>
          {statusLabel(schedule.status)}
        </span>
      </div>
      {isHome ? <span className="schedule-list-session">{schedule.sessionTitle}</span> : null}
      <div className="schedule-list-timing">
        <span className="schedule-list-trigger">
          <span aria-hidden="true">{schedule.trigger.type === "cron" ? "↻" : "◷"}</span>
          {formatTrigger(schedule.trigger)}
        </span>
        <span className="schedule-list-next">
          次回 {schedule.nextFireAt ? new Date(schedule.nextFireAt).toLocaleString() : "—"}
        </span>
      </div>
      {schedule.lastFireResult ? (
        <span className="schedule-list-result">直近: {schedule.lastFireResult}</span>
      ) : null}
      {schedule.lastExecutionId ? (
        <span className="schedule-list-execution">Execution: {schedule.lastExecutionId}</span>
      ) : null}
    </div>
  );

  return (
    <section
      className="schedule-workspace-list"
      aria-labelledby="schedule-list-title"
    >
      <div className="schedule-workspace-toolbar">
        <div className="schedule-workspace-title-group">
          <h1 id="schedule-list-title" className={isHome ? "visually-hidden" : undefined}>スケジュール</h1>
          {!isHome ? <span className="schedule-workspace-count">{schedules.length}</span> : null}
        </div>
        {!isHome ? (
          <ScheduleIconButton
            label="スケジュールを作成"
            icon="＋"
            onClick={canMutate ? onCreate : undefined}
          />
        ) : null}
      </div>
      <div className="schedule-list" aria-label="スケジュール一覧">
        {schedules.map((schedule) => isHome ? (
          <button
            key={schedule.id}
            type="button"
            className={`schedule-list-row schedule-list-row-button status-${schedule.status}`}
            onClick={() => onOpenSession?.(schedule.sessionId)}
          >
            {renderMain(schedule)}
            <span className="schedule-list-open-icon" aria-hidden="true">↗</span>
          </button>
        ) : (
          <article key={schedule.id} className={`schedule-list-row status-${schedule.status}`}>
            {renderMain(schedule)}
            <div className="schedule-list-actions" role="group" aria-label={`${schedule.name} の操作`}>
              <ScheduleIconButton label="スケジュールを編集" icon="✎" onClick={() => onEdit?.(schedule)} />
              <ScheduleIconButton label="今すぐ実行" icon="⚡" onClick={() => onRunNow?.(schedule)} />
              {schedule.status === "paused" ? (
                <ScheduleIconButton label="スケジュールを再開" icon="▶" onClick={() => onResume?.(schedule)} />
              ) : schedule.status === "active" ? (
                <ScheduleIconButton label="スケジュールを一時停止" icon="Ⅱ" onClick={() => onPause?.(schedule)} />
              ) : null}
              <ScheduleIconButton label="スケジュールを削除" icon="⌫" danger onClick={() => onDelete?.(schedule)} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ScheduleEditor({
  draft,
  onDraftChange,
  onBack,
  previewNow,
}: Pick<ScheduleWorkspaceProps, "draft" | "onDraftChange" | "onBack" | "previewNow">) {
  const currentDraft = draft;
  if (!currentDraft) {
    return (
      <p className="schedule-workspace-error" role="alert">
        スケジュールの入力状態を作成できません。
      </p>
    );
  }

  const update = (patch: Partial<ScheduleDraftProjection>) => {
    onDraftChange?.({
      ...currentDraft,
      ...patch,
      trigger: patch.trigger ?? currentDraft.trigger,
    });
  };
  const updateTrigger = (
    patch: Partial<ScheduleDraftProjection["trigger"]>,
  ) => {
    onDraftChange?.({
      ...currentDraft,
      trigger: {
        ...currentDraft.trigger,
        ...patch,
      } as ScheduleDraftProjection["trigger"],
    });
  };
  let preview: Date[] = [];
  let previewError = false;
  if (currentDraft.trigger.type === "cron" && currentDraft.trigger.expression.trim()) {
    try {
      preview = listNextSessionScheduleTriggerInstants(
        currentDraft.trigger,
        previewNow ?? new Date(),
        5,
      );
    } catch {
      previewError = true;
    }
  }

  return (
    <section
      className="schedule-workspace-editor"
      aria-label="スケジュール設定"
    >
      <div className="schedule-workspace-editor-toolbar">
        <BackNavigationButton label="スケジュール一覧へ戻る" onBack={onBack} />
      </div>
      <div className="schedule-editor-fields">
        <div className="schedule-name-field">
          <input
            aria-label="名前"
            placeholder="名前"
            value={currentDraft.name}
            onChange={(event) => update({ name: event.target.value })}
          />
        </div>
        <div>
          <select
            aria-label="実行形式"
            value={currentDraft.trigger.type}
            onChange={(event) =>
              event.target.value === "cron"
                ? onDraftChange?.({
                    ...currentDraft,
                    trigger: {
                      type: "cron",
                      expression: "* * * * *",
                      timeZone: currentDraft.trigger.timeZone,
                    },
                  })
                : onDraftChange?.({
                    ...currentDraft,
                    trigger: {
                      type: "once",
                      localDateTime: "",
                      timeZone: currentDraft.trigger.timeZone,
                    },
                  })
            }
          >
            <option value="cron">Cron</option>
            <option value="once">1回のみ</option>
          </select>
        </div>
        {currentDraft.trigger.type === "cron" ? (
          <div className="schedule-trigger-field">
            <input
              aria-label="Cron式"
              value={currentDraft.trigger.expression}
              onChange={(event) =>
                updateTrigger({ expression: event.target.value })
              }
            />
          </div>
        ) : (
          <div className="schedule-trigger-field">
            <input
              aria-label="実行日時"
              type="datetime-local"
              value={currentDraft.trigger.localDateTime}
              onChange={(event) =>
                updateTrigger({ localDateTime: event.target.value })
              }
            />
          </div>
        )}
      </div>
      {currentDraft.trigger.type === "cron" && (previewError || preview.length > 0) ? (
        <section className="schedule-preview" aria-label="次回の実行予定" aria-live="polite">
          {previewError ? (
            <p className="schedule-preview-error">Cron式を確認してください。</p>
          ) : (
            <ol>
              {preview.map((instant) => (
                <li key={instant.toISOString()}>
                  <time dateTime={instant.toISOString()}>{formatPreviewInstant(instant)}</time>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
    </section>
  );
}

export function ScheduleWorkspace(props: ScheduleWorkspaceProps) {
  const projection = useMemo(
    () =>
      buildScheduleWorkspaceProjection({
        mode: props.mode,
        loadState: props.loadState,
        schedules: props.schedules,
        draft: props.draft,
        errorMessage: props.errorMessage,
        canMutate: !props.isHome,
      }),
    [
      props.mode,
      props.loadState,
      props.schedules,
      props.draft,
      props.errorMessage,
      props.isHome,
    ],
  );

  return (
    <main
      className={`schedule-workspace${projection.mode === "list" ? " is-list" : " is-editor"}${props.isHome ? " is-home" : ""}`}
      data-schedule-state={projection.state}
    >
      {projection.errorMessage && projection.state !== "error" ? (
        <p className="schedule-workspace-error" role="alert">{projection.errorMessage}</p>
      ) : null}
      {projection.state === "loading" ? (
        <div
          className="schedule-workspace-loading"
          role="status"
          aria-live="polite"
        >
          <span className="session-action-dock-spinner" aria-hidden="true" />
          <span className="visually-hidden">スケジュールを読み込み中</span>
        </div>
      ) : projection.state === "error" ? (
        <p className="schedule-workspace-error" role="alert">
          {projection.errorMessage ?? "スケジュールを読み込めませんでした。"}
        </p>
      ) : projection.state === "empty" ? (
        <section
          className="schedule-workspace-empty"
          aria-labelledby="schedule-list-title"
        >
          <div className="schedule-workspace-toolbar">
            <h1 id="schedule-list-title" className={props.isHome ? "visually-hidden" : undefined}>スケジュール</h1>
            {!props.isHome ? (
              <ScheduleIconButton
                label="スケジュールを作成"
                icon="＋"
                onClick={props.onCreate}
              />
            ) : null}
          </div>
          <div className="schedule-empty-copy">
            <span className="schedule-empty-icon" aria-hidden="true">◷</span>
            <p>スケジュールはありません。</p>
          </div>
        </section>
      ) : projection.state === "editor" ? (
        <ScheduleEditor
          draft={projection.draft}
          onDraftChange={props.onDraftChange}
          onBack={props.onBack}
          previewNow={props.previewNow}
        />
      ) : (
        <ScheduleList
          schedules={projection.schedules}
          isHome={props.isHome}
          canMutate={projection.canMutate}
          onCreate={props.onCreate}
          onEdit={props.onEdit}
          onPause={props.onPause}
          onResume={props.onResume}
          onDelete={props.onDelete}
          onRunNow={props.onRunNow}
          onOpenSession={props.onOpenSession}
        />
      )}
    </main>
  );
}
