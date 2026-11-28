import type { KeyboardShortcutSettings } from "../../src-shared/settings/keyboard-shortcut-state.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import {
  updateAutoCollapseActionDockOnSend,
  updateCharacterDefinitionEnabled,
  updateCurrentDateEnabled,
  updateGlossaryProactiveCreateLimitDraft,
  updateCodingProviderEnabledDraft,
  updateCodingProviderInstructionRelativePathDraft,
  updateCodingProviderSkillRelativePathDraft,
  updateCodingProviderSkillRootPathDraft,
  updateLaunchAtLoginEnabled,
  updateKeyboardShortcuts,
  updateScrollToLatestOnSend,
  updatePreviewWheelZoomStep,
  updateSessionTurnNotificationEnabled,
  updateSessionApprovalNotificationEnabled,
  updateSessionTurnNotificationResponsePreviewEnabled,
} from "./settings-draft.js";

/** 最新の設定下書きを入力にして次の下書きを計算する更新口。 */
type SetSettingsDraft = (
  updater: (current: AppSettings) => AppSettings,
) => void;

/** 設定項目ごとのアクションが更新を渡す共通の下書き設定口。 */
type SettingsDraftActionInput = {
  setSettingsDraft: SetSettingsDraft;
};

/** 指定プロバイダーの有効フラグを現在の下書きに反映する。 */
export function handleChangeProviderEnabled(
  input: SettingsDraftActionInput & {
    providerId: string;
    enabled: boolean;
  },
): void {
  input.setSettingsDraft((current) =>
    updateCodingProviderEnabledDraft(current, input.providerId, input.enabled),
  );
}

/** 入力したプロバイダーのルートパスを下書きに保持する。 */
export function handleChangeProviderSkillRootPath(
  input: SettingsDraftActionInput & {
    providerId: string;
    skillRootPath: string;
  },
): void {
  input.setSettingsDraft((current) =>
    updateCodingProviderSkillRootPathDraft(
      current,
      input.providerId,
      input.skillRootPath,
    ),
  );
}

/** ルートパスを変えず、スキルの相対パス入力を下書きに反映する。 */
export function handleChangeProviderSkillRelativePath(
  input: SettingsDraftActionInput & {
    providerId: string;
    skillRelativePath: string;
  },
): void {
  input.setSettingsDraft((current) =>
    updateCodingProviderSkillRelativePathDraft(
      current,
      input.providerId,
      input.skillRelativePath,
    ),
  );
}

/** 指示ファイルの相対パス入力を指定プロバイダーの下書きへ渡す。 */
export function handleChangeProviderInstructionRelativePath(
  input: SettingsDraftActionInput & {
    providerId: string;
    instructionRelativePath: string;
  },
): void {
  input.setSettingsDraft((current) =>
    updateCodingProviderInstructionRelativePathDraft(
      current,
      input.providerId,
      input.instructionRelativePath,
    ),
  );
}

/** 送信時のアクションドック自動折りたたみを下書きで切り替える。 */
export function handleChangeAutoCollapseActionDockOnSend(
  input: SettingsDraftActionInput & {
    enabled: boolean;
  },
): void {
  input.setSettingsDraft((current) =>
    updateAutoCollapseActionDockOnSend(current, input.enabled),
  );
}

/** キャラクター定義をプロンプトに含めるかの入力を下書きへ渡す。 */
export function handleChangeCharacterDefinitionEnabled(
  input: SettingsDraftActionInput & {
    enabled: boolean;
  },
): void {
  input.setSettingsDraft((current) =>
    updateCharacterDefinitionEnabled(current, input.enabled),
  );
}

/** プロンプトに現在日付を含めるかの入力を下書きへ渡す。 */
export function handleChangeCurrentDateEnabled(
  input: SettingsDraftActionInput & {
    enabled: boolean;
  },
): void {
  input.setSettingsDraft((current) =>
    updateCurrentDateEnabled(current, input.enabled),
  );
}

/** 送信時に最新の表示位置へ移動する設定を下書きへ渡す。 */
export function handleChangeScrollToLatestOnSend(
  input: SettingsDraftActionInput & {
    enabled: boolean;
  },
): void {
  input.setSettingsDraft((current) =>
    updateScrollToLatestOnSend(current, input.enabled),
  );
}

/** 編集後のショートカット設定一式を下書きに反映する。 */
export function handleChangeKeyboardShortcuts(
  input: SettingsDraftActionInput & {
    keyboardShortcuts: KeyboardShortcutSettings;
  },
): void {
  input.setSettingsDraft((current) =>
    updateKeyboardShortcuts(current, input.keyboardShortcuts),
  );
}

/** プレビュー用ホイールズームの増減幅を数値で下書きへ渡す。 */
export function handleChangePreviewWheelZoomStep(
  input: SettingsDraftActionInput & { value: number },
): void {
  input.setSettingsDraft((current) =>
    updatePreviewWheelZoomStep(current, input.value),
  );
}

/** ログイン時に起動するかを下書きへ反映し、この時点では OS に登録しない。 */
export function handleChangeLaunchAtLoginEnabled(
  input: SettingsDraftActionInput & {
    enabled: boolean;
  },
): void {
  input.setSettingsDraft((current) =>
    updateLaunchAtLoginEnabled(current, input.enabled),
  );
}

/** セッション応答完了通知の有効化を、他の通知とは独立して下書きに反映する。 */
export function handleChangeSessionTurnNotificationEnabled(
  input: SettingsDraftActionInput & {
    enabled: boolean;
  },
): void {
  input.setSettingsDraft((current) =>
    updateSessionTurnNotificationEnabled(current, input.enabled),
  );
}

/** セッションが承認待ちになったときの通知設定を下書きに反映する。 */
export function handleChangeSessionApprovalNotificationEnabled(
  input: SettingsDraftActionInput & {
    enabled: boolean;
  },
): void {
  input.setSettingsDraft((current) =>
    updateSessionApprovalNotificationEnabled(current, input.enabled),
  );
}

/** 応答完了通知に応答プレビューを含めるかを下書きへ渡す。 */
export function handleChangeSessionTurnNotificationResponsePreviewEnabled(
  input: SettingsDraftActionInput & {
    enabled: boolean;
  },
): void {
  input.setSettingsDraft((current) =>
    updateSessionTurnNotificationResponsePreviewEnabled(current, input.enabled),
  );
}

/** 用語集の能動登録上限の文字入力を渡し、整数への変換と範囲調整は下書き更新に委ねる。 */
export function handleChangeGlossaryProactiveCreateLimit(
  input: SettingsDraftActionInput & {
    value: string;
  },
): void {
  input.setSettingsDraft((current) =>
    updateGlossaryProactiveCreateLimitDraft(current, input.value),
  );
}
