import { useMemo } from "react";

import { BackNavigationButton } from "./back-navigation-button.js";
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
    ? `${trigger.expression} · ${trigger.timeZone}`
    : `${trigger.localDateTime} · ${trigger.timeZone}`;
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
  return (
    <section
      className="schedule-workspace-list"
      aria-labelledby="schedule-list-title"
    >
      <div className="schedule-workspace-toolbar">
        <h1 id="schedule-list-title">スケジュール</h1>
        {!isHome ? (
          <ScheduleIconButton
            label="スケジュールを作成"
            icon="＋"
            onClick={canMutate ? onCreate : undefined}
          />
        ) : null}
      </div>
      <div className="schedule-list" role="list" aria-label="スケジュール一覧">
        {schedules.map((schedule) => (
          <article
            key={schedule.id}
            className={`schedule-list-row status-${schedule.status}`}
            role="listitem"
          >
            <div className="schedule-list-main">
              <div className="schedule-list-heading">
                <strong>{schedule.name}</strong>
                <span className="schedule-status" data-status={schedule.status}>
                  {statusLabel(schedule.status)}
                </span>
              </div>
              <span className="schedule-list-session">
                {isHome ? schedule.sessionTitle : "このSession"}
              </span>
              <span className="schedule-list-trigger">
                {formatTrigger(schedule.trigger)}
              </span>
              <span className="schedule-list-next">
                次回:{" "}
                {schedule.nextFireAt
                  ? new Date(schedule.nextFireAt).toLocaleString()
                  : "—"}
              </span>
              {schedule.lastFireResult ? (
                <span className="schedule-list-result">
                  直近: {schedule.lastFireResult}
                </span>
              ) : null}
              {schedule.lastExecutionId ? (
                <span className="schedule-list-execution">
                  Execution: {schedule.lastExecutionId}
                </span>
              ) : null}
            </div>
            <div
              className="schedule-list-actions"
              role="group"
              aria-label={`${schedule.name} の操作`}
            >
              {isHome ? (
                <ScheduleIconButton
                  label="所有Sessionを開く"
                  icon="↗"
                  onClick={() => onOpenSession?.(schedule.sessionId)}
                />
              ) : (
                <>
                  <ScheduleIconButton
                    label="スケジュールを編集"
                    icon="✎"
                    onClick={() => onEdit?.(schedule)}
                  />
                  <ScheduleIconButton
                    label="今すぐ実行"
                    icon="▶"
                    onClick={() => onRunNow?.(schedule)}
                  />
                  {schedule.status === "paused" ? (
                    <ScheduleIconButton
                      label="スケジュールを再開"
                      icon="▶"
                      onClick={() => onResume?.(schedule)}
                    />
                  ) : schedule.status === "active" ? (
                    <ScheduleIconButton
                      label="スケジュールを一時停止"
                      icon="Ⅱ"
                      onClick={() => onPause?.(schedule)}
                    />
                  ) : null}
                  <ScheduleIconButton
                    label="スケジュールを削除"
                    icon="⌫"
                    danger
                    onClick={() => onDelete?.(schedule)}
                  />
                </>
              )}
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
}: Pick<ScheduleWorkspaceProps, "draft" | "onDraftChange" | "onBack">) {
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

  return (
    <section
      className="schedule-workspace-editor"
      aria-labelledby="schedule-editor-title"
    >
      <div className="schedule-workspace-editor-toolbar">
        <BackNavigationButton label="スケジュール一覧へ戻る" onBack={onBack} />
        <h1 id="schedule-editor-title">
          {currentDraft.id ? "スケジュールを編集" : "スケジュールを作成"}
        </h1>
      </div>
      <div className="schedule-editor-fields">
        <label>
          <span>名前</span>
          <input
            value={currentDraft.name}
            onChange={(event) => update({ name: event.target.value })}
          />
        </label>
        <label>
          <span>実行形式</span>
          <select
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
        </label>
        {currentDraft.trigger.type === "cron" ? (
          <label>
            <span>Cron式</span>
            <input
              value={currentDraft.trigger.expression}
              onChange={(event) =>
                updateTrigger({ expression: event.target.value })
              }
              placeholder="分 時 日 月 曜日"
            />
          </label>
        ) : (
          <label>
            <span>実行日時</span>
            <input
              type="datetime-local"
              value={currentDraft.trigger.localDateTime}
              onChange={(event) =>
                updateTrigger({ localDateTime: event.target.value })
              }
            />
          </label>
        )}
        <label>
          <span>タイムゾーン</span>
          <input
            value={currentDraft.trigger.timeZone}
            onChange={(event) =>
              updateTrigger({ timeZone: event.target.value })
            }
            placeholder="Asia/Tokyo"
          />
        </label>
      </div>
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
      className={`schedule-workspace${projection.mode === "list" ? " is-list" : " is-editor"}`}
      data-schedule-state={projection.state}
    >
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
            <h1 id="schedule-list-title">スケジュール</h1>
            {!props.isHome ? (
              <ScheduleIconButton
                label="スケジュールを作成"
                icon="＋"
                onClick={props.onCreate}
              />
            ) : null}
          </div>
          <p>スケジュールはありません。</p>
        </section>
      ) : projection.state === "editor" ? (
        <ScheduleEditor
          draft={projection.draft}
          onDraftChange={props.onDraftChange}
          onBack={props.onBack}
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
