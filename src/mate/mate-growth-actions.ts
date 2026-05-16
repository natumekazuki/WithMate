import type { MateGrowthApplyResult } from "./mate-growth-apply-result.js";
import type {
  MateGrowthEventActionResult,
  MateGrowthEventListItem,
} from "./mate-growth-events-state.js";
import {
  type MateGrowthSettings,
  type MateStorageState,
  type UpdateMateGrowthSettingsInput,
} from "./mate-state.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";
import { buildApplyPendingGrowthFeedback } from "./mate-growth-feedback.js";

export type HomeMateGrowthApplyApi = Pick<WithMateWindowApi, "applyPendingGrowth">;

export async function applyHomePendingGrowth(api: HomeMateGrowthApplyApi): Promise<string> {
  const result: MateGrowthApplyResult = await api.applyPendingGrowth();
  return buildApplyPendingGrowthFeedback(result);
}

export type HomeMateGrowthApi = Pick<
  WithMateWindowApi,
  | "applyPendingGrowth"
  | "listMateGrowthEvents"
  | "correctMateGrowthEvent"
  | "disableMateGrowthEvent"
  | "forgetMateGrowthEvent"
  | "updateMateGrowthSettings"
  | "resetMate"
>;

export type HomeMateGrowthEventListRefresher<TApi> = (
  api: TApi,
  options?: { isActive?: () => boolean; silent?: boolean },
) => Promise<void>;

export type HomeMateGrowthStatusRefresher<TApi> = (
  api: TApi,
  options?: { isActive?: () => boolean },
) => Promise<MateStorageState>;

export type UpsertMateGrowthEventListItem = (
  current: readonly MateGrowthEventListItem[],
  nextEvent: MateGrowthEventListItem | null,
) => MateGrowthEventListItem[];

export const upsertMateGrowthEventListItem: UpsertMateGrowthEventListItem = (current, nextEvent) => {
  if (nextEvent === null) {
    return current as MateGrowthEventListItem[];
  }

  const existingIndex = current.findIndex((event) => event.id === nextEvent.id);
  if (existingIndex === -1) {
    return [nextEvent, ...current];
  }

  return current.map((event) => event.id === nextEvent.id ? nextEvent : event);
};

type EventActionOptions = {
  api: HomeMateGrowthApi | null;
  setMateGrowthEventsFeedback: (message: string) => void;
  upsertMateGrowthEventListItem: (nextEvent: MateGrowthEventListItem | null) => void;
  setMateGrowthEventBusyTarget: (target: string | null) => void;
  mateState: MateStorageState | null;
  mateGrowthEventBusyTarget: string | null;
  eventId?: string;
  statement?: string;
};

type EventActionResultProvider = (api: HomeMateGrowthApi) => Promise<MateGrowthEventActionResult>;

export type HandleApplyPendingGrowthInput<TApi extends HomeMateGrowthApi = HomeMateGrowthApi> = {
  api: TApi | null;
  mateGrowthApplying: boolean;
  mateState: MateStorageState | null;
  setMateGrowthApplying: (busy: boolean) => void;
  setSettingsFeedback: (message: string) => void;
  refreshMateStatus: HomeMateGrowthStatusRefresher<TApi>;
  refreshMateGrowthEvents: HomeMateGrowthEventListRefresher<TApi>;
};

export async function handleApplyPendingGrowth<TApi extends HomeMateGrowthApi>(
  input: HandleApplyPendingGrowthInput<TApi>,
): Promise<void> {
  if (input.mateGrowthApplying) {
    return;
  }

  if (input.mateState !== "active") {
    input.setSettingsFeedback("Mate がアクティブなときのみ手動適用できるよ。");
    return;
  }

  if (!input.api) {
    input.setSettingsFeedback("Mate API が利用できないよ。");
    return;
  }

  input.setMateGrowthApplying(true);
  input.setSettingsFeedback("Mate 成長を適用中...");
  try {
    input.setSettingsFeedback(await applyHomePendingGrowth(input.api));
    await input.refreshMateStatus(input.api);
    await input.refreshMateGrowthEvents(input.api, { silent: true });
  } catch (error) {
    input.setSettingsFeedback(error instanceof Error ? error.message : "Mate 成長の適用に失敗したよ。");
  } finally {
    input.setMateGrowthApplying(false);
  }
}

export type HandleReloadMateGrowthEventsInput<TApi> = {
  api: TApi | null;
  mateState: MateStorageState | null;
  setMateGrowthEventsFeedback: (message: string) => void;
  refreshMateGrowthEvents: HomeMateGrowthEventListRefresher<TApi>;
};

export async function handleReloadMateGrowthEvents<TApi>(
  input: HandleReloadMateGrowthEventsInput<TApi>,
): Promise<void> {
  if (input.mateState !== "active") {
    input.setMateGrowthEventsFeedback("Mate 作成後に確認してね。");
    return;
  }

  if (!input.api) {
    input.setMateGrowthEventsFeedback("Mate API が利用できないよ。");
    return;
  }

  await input.refreshMateGrowthEvents(input.api);
}

export type HandleBeginCorrectMateGrowthEventInput = {
  eventId: string;
  statement: string;
  setCorrectingMateGrowthEventId: (eventId: string | null) => void;
  setCorrectingMateGrowthEventStatement: (statement: string) => void;
};

export function handleBeginCorrectMateGrowthEvent(input: HandleBeginCorrectMateGrowthEventInput): void {
  input.setCorrectingMateGrowthEventId(input.eventId);
  input.setCorrectingMateGrowthEventStatement(input.statement);
}

export type HandleCancelCorrectMateGrowthEventInput = {
  setCorrectingMateGrowthEventId: (eventId: string | null) => void;
  setCorrectingMateGrowthEventStatement: (statement: string) => void;
};

export function handleCancelCorrectMateGrowthEvent(input: HandleCancelCorrectMateGrowthEventInput): void {
  input.setCorrectingMateGrowthEventId(null);
  input.setCorrectingMateGrowthEventStatement("");
}

export type HandleCorrectMateGrowthEventInput = EventActionOptions & {
  statement: string;
  setCancelCorrectMateGrowthEvent: () => void;
  runCorrectAction: EventActionResultProvider;
};

export async function handleCorrectMateGrowthEvent(input: HandleCorrectMateGrowthEventInput): Promise<void> {
  const eventId = input.eventId;
  if (!eventId) {
    return;
  }
  if (input.mateGrowthEventBusyTarget !== null) {
    return;
  }

  if (input.mateState !== "active") {
    input.setMateGrowthEventsFeedback("Mate 作成後に操作してね。");
    return;
  }

  if (!input.api) {
    input.setMateGrowthEventsFeedback("Mate API が利用できないよ。");
    return;
  }

  input.setMateGrowthEventBusyTarget(eventId);
  input.setMateGrowthEventsFeedback("");
  try {
    const result = await input.runCorrectAction(input.api);
    input.upsertMateGrowthEventListItem(result.event);
    input.upsertMateGrowthEventListItem(result.createdEvent ?? null);
    input.setCancelCorrectMateGrowthEvent();
    input.setMateGrowthEventsFeedback("Growth Event を修正したよ。");
  } catch (error) {
    input.setMateGrowthEventsFeedback(error instanceof Error ? error.message : "Growth Event の修正に失敗したよ。");
  } finally {
    input.setMateGrowthEventBusyTarget(null);
  }
}

export type HandleDisableMateGrowthEventInput = EventActionOptions & {
  runDisableAction: EventActionResultProvider;
};

export async function handleDisableMateGrowthEvent(input: HandleDisableMateGrowthEventInput): Promise<void> {
  const eventId = input.eventId;
  if (!eventId) {
    return;
  }
  if (input.mateGrowthEventBusyTarget !== null) {
    return;
  }

  if (input.mateState !== "active") {
    input.setMateGrowthEventsFeedback("Mate 作成後に操作してね。");
    return;
  }

  if (!input.api) {
    input.setMateGrowthEventsFeedback("Mate API が利用できないよ。");
    return;
  }

  input.setMateGrowthEventBusyTarget(eventId);
  input.setMateGrowthEventsFeedback("");
  try {
    const result = await input.runDisableAction(input.api);
    input.upsertMateGrowthEventListItem(result.event);
    input.setMateGrowthEventsFeedback("Growth Event を無効化したよ。");
  } catch (error) {
    input.setMateGrowthEventsFeedback(error instanceof Error ? error.message : "Growth Event の無効化に失敗したよ。");
  } finally {
    input.setMateGrowthEventBusyTarget(null);
  }
}

export type HandleForgetMateGrowthEventInput = EventActionOptions & {
  runForgetAction: EventActionResultProvider;
};

export async function handleForgetMateGrowthEvent(input: HandleForgetMateGrowthEventInput): Promise<void> {
  const eventId = input.eventId;
  if (!eventId) {
    return;
  }
  if (input.mateGrowthEventBusyTarget !== null) {
    return;
  }

  if (input.mateState !== "active") {
    input.setMateGrowthEventsFeedback("Mate 作成後に操作してね。");
    return;
  }

  if (!input.api) {
    input.setMateGrowthEventsFeedback("Mate API が利用できないよ。");
    return;
  }

  input.setMateGrowthEventBusyTarget(eventId);
  input.setMateGrowthEventsFeedback("");
  try {
    const result = await input.runForgetAction(input.api);
    input.upsertMateGrowthEventListItem(result.event);
    input.setMateGrowthEventsFeedback("Growth Event を忘却済みにしたよ。");
  } catch (error) {
    input.setMateGrowthEventsFeedback(error instanceof Error ? error.message : "Growth Event の忘却に失敗したよ。");
  } finally {
    input.setMateGrowthEventBusyTarget(null);
  }
}

export type HandleUpdateMateGrowthSettingsInput = {
  api: HomeMateGrowthApi | null;
  input: UpdateMateGrowthSettingsInput;
  mateGrowthBusy: boolean;
  mateState: MateStorageState | null;
  setMateGrowthBusy: (busy: boolean) => void;
  setMateGrowthFeedback: (message: string) => void;
  setMateGrowthSettings: (settings: MateGrowthSettings | null) => void;
};

export async function handleUpdateMateGrowthSettings(input: HandleUpdateMateGrowthSettingsInput): Promise<void> {
  if (input.mateGrowthBusy) {
    return;
  }

  if (input.mateState === "not_created") {
    input.setMateGrowthFeedback("Mate 作成後に設定してね。");
    return;
  }

  if (!input.api) {
    input.setMateGrowthFeedback("Mate API が利用できないよ。");
    return;
  }

  input.setMateGrowthBusy(true);
  input.setMateGrowthFeedback("");
  try {
    input.setMateGrowthSettings(await input.api.updateMateGrowthSettings(input.input));
    input.setMateGrowthFeedback("Mate Growth 設定を更新したよ。");
  } catch (error) {
    input.setMateGrowthFeedback(error instanceof Error ? error.message : "Mate Growth 設定の更新に失敗したよ。");
  } finally {
    input.setMateGrowthBusy(false);
  }
}
