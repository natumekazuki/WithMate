import type { KeyboardShortcutSettings } from "../../src-shared/settings/keyboard-shortcut-state.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { HomeSettingsContentBaseProps } from "./home-settings-content-props.js";
import {
  handleChangeAutoCollapseActionDockOnSend,
  handleChangeCharacterDefinitionEnabled,
  handleChangeCurrentDateEnabled,
  handleChangeGlossaryProactiveCreateLimit,
  handleChangeKeyboardShortcuts,
  handleChangeLaunchAtLoginEnabled,
  handleChangeScrollToLatestOnSend,
  handleChangePreviewWheelZoomStep,
  handleChangeProviderInstructionRelativePath,
  handleChangeProviderEnabled,
  handleChangeProviderSkillRelativePath,
  handleChangeProviderSkillRootPath,
  handleChangeSessionTurnNotificationEnabled,
  handleChangeSessionApprovalNotificationEnabled,
  handleChangeSessionTurnNotificationResponsePreviewEnabled,
} from "./settings-draft-actions.js";

/** 下書き更新と、編集開始時に前回の操作結果を消すための任意の通知。 */
type SettingsDraftHandlersContext = {
  setSettingsDraft: (updater: (current: AppSettings) => AppSettings) => void;
  clearSettingsFeedback?: () => void;
};

/** 保存や参照を含めず、設定画面の入力変更だけを受けるコールバックの組。 */
export type SettingsDraftHandlers = Pick<
  HomeSettingsContentBaseProps,
  | "onChangeAutoCollapseActionDockOnSend"
  | "onChangeCharacterDefinitionEnabled"
  | "onChangeCurrentDateEnabled"
  | "onChangeScrollToLatestOnSend"
  | "onChangePreviewWheelZoomStep"
  | "onChangeKeyboardShortcuts"
  | "onChangeLaunchAtLoginEnabled"
  | "onChangeSessionTurnNotificationEnabled"
  | "onChangeSessionApprovalNotificationEnabled"
  | "onChangeSessionTurnNotificationResponsePreviewEnabled"
  | "onChangeGlossaryProactiveCreateLimit"
  | "onChangeProviderEnabled"
  | "onChangeModelAvailability"
  | "onChangeWithMateAutoReview"
  | "onChangeProviderInstructionRelativePath"
  | "onChangeProviderSkillRootPath"
  | "onChangeProviderSkillRelativePath"
>;

/** 設定画面の入力を下書き更新につなぎ、各編集の前に残っている操作結果を消す。 */
export function buildSettingsDraftHandlers({
  setSettingsDraft,
  clearSettingsFeedback,
}: SettingsDraftHandlersContext): SettingsDraftHandlers {
  /** 前の操作結果をクリアしてから、最新値を起点に更新する関数を渡す。 */
  const updateSettingsDraft = (
    updater: (current: AppSettings) => AppSettings,
  ) => {
    clearSettingsFeedback?.();
    setSettingsDraft(updater);
  };

  return {
    /** モデルと深度の選択を置き換える。null は自動レビューの無効化を表す。 */
    onChangeWithMateAutoReview: (withMateAutoReview) => {
      updateSettingsDraft((current) => ({ ...current, withMateAutoReview }));
    },
    /** プロバイダー別のモデル・サービス無効設定を下書きに置く。 */
    onChangeModelAvailability: (modelAvailability) => {
      updateSettingsDraft((current) => ({ ...current, modelAvailability }));
    },
    /** 送信後にアクションドックを自動で閉じる設定を編集する。 */
    onChangeAutoCollapseActionDockOnSend: (enabled) => {
      handleChangeAutoCollapseActionDockOnSend({
        enabled,
        setSettingsDraft: updateSettingsDraft,
      });
    },
    /** キャラクター定義のプロンプトへの追加を個別に切り替える。 */
    onChangeCharacterDefinitionEnabled: (enabled) => {
      handleChangeCharacterDefinitionEnabled({
        enabled,
        setSettingsDraft: updateSettingsDraft,
      });
    },
    /** 現在日付のプロンプトへの追加を個別に切り替える。 */
    onChangeCurrentDateEnabled: (enabled) => {
      handleChangeCurrentDateEnabled({
        enabled,
        setSettingsDraft: updateSettingsDraft,
      });
    },
    /** 送信後の最新位置へのスクロールを切り替える。 */
    onChangeScrollToLatestOnSend: (enabled) => {
      handleChangeScrollToLatestOnSend({
        enabled,
        setSettingsDraft: updateSettingsDraft,
      });
    },
    /** プレビューのホイールズーム幅の数値を受け取る。 */
    onChangePreviewWheelZoomStep: (value) => {
      handleChangePreviewWheelZoomStep({
        value,
        setSettingsDraft: updateSettingsDraft,
      });
    },
    /** ショートカット画面で編集された設定一式を取り込む。 */
    onChangeKeyboardShortcuts: (
      keyboardShortcuts: KeyboardShortcutSettings,
    ) => {
      handleChangeKeyboardShortcuts({
        keyboardShortcuts,
        setSettingsDraft: updateSettingsDraft,
      });
    },
    /** ログイン時の自動起動を保存前の設定として編集する。 */
    onChangeLaunchAtLoginEnabled: (enabled) => {
      handleChangeLaunchAtLoginEnabled({
        enabled,
        setSettingsDraft: updateSettingsDraft,
      });
    },
    /** セッション応答完了時に通知するかを切り替える。 */
    onChangeSessionTurnNotificationEnabled: (enabled) => {
      handleChangeSessionTurnNotificationEnabled({
        enabled,
        setSettingsDraft: updateSettingsDraft,
      });
    },
    /** セッションの承認要求時に通知するかを切り替える。 */
    onChangeSessionApprovalNotificationEnabled: (enabled) => {
      handleChangeSessionApprovalNotificationEnabled({
        enabled,
        setSettingsDraft: updateSettingsDraft,
      });
    },
    /** 応答完了通知で応答のプレビューを表示するかを切り替える。 */
    onChangeSessionTurnNotificationResponsePreviewEnabled: (enabled) => {
      handleChangeSessionTurnNotificationResponsePreviewEnabled({
        enabled,
        setSettingsDraft: updateSettingsDraft,
      });
    },
    /** 空欄を含む用語集の能動登録上限の入力を、数値の解釈前に受け取る。 */
    onChangeGlossaryProactiveCreateLimit: (value) => {
      handleChangeGlossaryProactiveCreateLimit({
        value,
        setSettingsDraft: updateSettingsDraft,
      });
    },
    /** 対象プロバイダーを特定して有効フラグを切り替える。 */
    onChangeProviderEnabled: (providerId, enabled) => {
      handleChangeProviderEnabled({
        providerId,
        enabled,
        setSettingsDraft: updateSettingsDraft,
      });
    },
    /** プロバイダーごとのルートパスの入力を取り込む。 */
    onChangeProviderSkillRootPath: (providerId, skillRootPath) => {
      handleChangeProviderSkillRootPath({
        providerId,
        skillRootPath,
        setSettingsDraft: updateSettingsDraft,
      });
    },
    /** プロバイダーのルート基準で指定するスキルの相対パスを取り込む。 */
    onChangeProviderSkillRelativePath: (providerId, skillRelativePath) => {
      handleChangeProviderSkillRelativePath({
        providerId,
        skillRelativePath,
        setSettingsDraft: updateSettingsDraft,
      });
    },
    /** プロバイダーの指示ファイルの相対パスを取り込み、スキルのパスは変更しない。 */
    onChangeProviderInstructionRelativePath: (
      providerId,
      instructionRelativePath,
    ) => {
      handleChangeProviderInstructionRelativePath({
        providerId,
        instructionRelativePath,
        setSettingsDraft: updateSettingsDraft,
      });
    },
  };
}
