import {
  GLOSSARY_PROACTIVE_CREATE_LIMIT_MAX,
  GLOSSARY_PROACTIVE_CREATE_LIMIT_MIN,
  getProviderAppSettings,
  type AppSettings,
  type ProviderAppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import type { KeyboardShortcutSettings } from "../../src-shared/settings/keyboard-shortcut-state.js";

/** メッセージ送信時にアクションドックを閉じるかを下書きに設定する。 */
export function updateAutoCollapseActionDockOnSend(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    autoCollapseActionDockOnSend: enabled,
  };
}

/** キャラクター定義をプロンプトに含めるかを下書きに設定する。 */
export function updateCharacterDefinitionEnabled(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    characterDefinitionEnabled: enabled,
  };
}

/** 現在日付をプロンプトに含めるかを下書きに設定する。 */
export function updateCurrentDateEnabled(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    currentDateEnabled: enabled,
  };
}

/** メッセージ送信時に最新位置へスクロールするかを下書きに設定する。 */
export function updateScrollToLatestOnSend(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    scrollToLatestOnSend: enabled,
  };
}

/** プラットフォーム別の上書きを含むショートカット設定を下書きで置き換える。 */
export function updateKeyboardShortcuts(
  draft: AppSettings,
  keyboardShortcuts: KeyboardShortcutSettings,
): AppSettings {
  return {
    ...draft,
    keyboardShortcuts,
  };
}

/** プレビューのホイール操作一段分のズーム量を、数値のまま下書きに反映する。 */
export function updatePreviewWheelZoomStep(
  draft: AppSettings,
  value: number,
): AppSettings {
  return { ...draft, previewWheelZoomStep: value };
}

/** セッション応答完了の通知設定を下書きで更新する。承認通知と本文表示は変更しない。 */
export function updateSessionTurnNotificationEnabled(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    sessionTurnNotificationEnabled: enabled,
  };
}

/** セッションの承認待ち通知だけを下書きで切り替える。 */
export function updateSessionApprovalNotificationEnabled(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return { ...draft, sessionApprovalNotificationEnabled: enabled };
}

/** 応答完了通知に応答のプレビューを載せるかを下書きで更新する。 */
export function updateSessionTurnNotificationResponsePreviewEnabled(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    sessionTurnNotificationResponsePreviewEnabled: enabled,
  };
}

/** OS ログイン時に起動する設定の下書きだけを変更し、実際の登録は行わない。 */
export function updateLaunchAtLoginEnabled(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    launchAtLoginEnabled: enabled,
  };
}

/** 用語集の能動登録上限を上下限内に収める。空欄や整数以外は null として保持する。 */
export function updateGlossaryProactiveCreateLimitDraft(
  draft: AppSettings,
  rawValue: string,
): AppSettings {
  if (!rawValue.trim()) {
    return { ...draft, glossaryProactiveCreateLimit: null };
  }
  const parsed = Number(rawValue);
  const limit = Number.isInteger(parsed)
    ? Math.min(
        GLOSSARY_PROACTIVE_CREATE_LIMIT_MAX,
        Math.max(GLOSSARY_PROACTIVE_CREATE_LIMIT_MIN, parsed),
      )
    : null;
  return { ...draft, glossaryProactiveCreateLimit: limit };
}

/** 対象プロバイダーの有効・無効をアプリ設定の下書き全体に反映する。 */
export function updateCodingProviderEnabledDraft(
  draft: AppSettings,
  providerId: string,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    codingProviderSettings: updateCodingProviderEnabled(
      draft,
      providerId,
      enabled,
    ),
  };
}

/** 対象プロバイダーのルートパス変更をアプリ設定の下書き全体に反映する。 */
export function updateCodingProviderSkillRootPathDraft(
  draft: AppSettings,
  providerId: string,
  skillRootPath: string,
): AppSettings {
  return {
    ...draft,
    codingProviderSettings: updateCodingProviderSkillRootPath(
      draft,
      providerId,
      skillRootPath,
    ),
  };
}

/** 対象プロバイダーのスキル相対パスをアプリ設定の下書きに反映する。 */
export function updateCodingProviderSkillRelativePathDraft(
  draft: AppSettings,
  providerId: string,
  skillRelativePath: string,
): AppSettings {
  return {
    ...draft,
    codingProviderSettings: updateCodingProviderSkillRelativePath(
      draft,
      providerId,
      skillRelativePath,
    ),
  };
}

/** 対象プロバイダーの指示ファイル相対パスをアプリ設定の下書きに反映する。 */
export function updateCodingProviderInstructionRelativePathDraft(
  draft: AppSettings,
  providerId: string,
  instructionRelativePath: string,
): AppSettings {
  return {
    ...draft,
    codingProviderSettings: updateCodingProviderInstructionRelativePath(
      draft,
      providerId,
      instructionRelativePath,
    ),
  };
}

/** プロバイダー設定の一覧をコピーし、指定プロバイダーの有効フラグだけを変更する。 */
export function updateCodingProviderEnabled(
  draft: AppSettings,
  providerId: string,
  enabled: boolean,
): Record<string, ProviderAppSettings> {
  return {
    ...draft.codingProviderSettings,
    [providerId]: {
      ...getProviderAppSettings(draft, providerId),
      enabled,
    },
  };
}

/** 指定プロバイダーのルートパスだけを差し替えた一覧を返し、相対パスは保つ。 */
export function updateCodingProviderSkillRootPath(
  draft: AppSettings,
  providerId: string,
  skillRootPath: string,
): Record<string, ProviderAppSettings> {
  return {
    ...draft.codingProviderSettings,
    [providerId]: {
      ...getProviderAppSettings(draft, providerId),
      skillRootPath,
    },
  };
}

/** スキルの相対パスだけを差し替えたプロバイダー設定一覧を返す。ルートとの結合は行わない。 */
export function updateCodingProviderSkillRelativePath(
  draft: AppSettings,
  providerId: string,
  skillRelativePath: string,
): Record<string, ProviderAppSettings> {
  return {
    ...draft.codingProviderSettings,
    [providerId]: {
      ...getProviderAppSettings(draft, providerId),
      skillRelativePath,
    },
  };
}

/** 指定プロバイダーの指示ファイル相対パスだけを差し替えた一覧を返す。 */
export function updateCodingProviderInstructionRelativePath(
  draft: AppSettings,
  providerId: string,
  instructionRelativePath: string,
): Record<string, ProviderAppSettings> {
  return {
    ...draft.codingProviderSettings,
    [providerId]: {
      ...getProviderAppSettings(draft, providerId),
      instructionRelativePath,
    },
  };
}
