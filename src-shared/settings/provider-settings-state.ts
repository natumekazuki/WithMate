import { DEFAULT_PROVIDER_ID, normalizeProviderId } from "./model-catalog.js";
import {
  DEFAULT_CHAT_LAYOUT_PREFERENCE,
  normalizeChatLayoutPreference,
  type ChatLayoutPreference,
} from "./chat-layout-preference.js";
import {
  createDefaultKeyboardShortcutSettings,
  normalizeKeyboardShortcutSettings,
  type KeyboardShortcutSettings,
} from "./keyboard-shortcut-state.js";
import {
  normalizeModelAvailability,
  type ModelAvailabilitySettings,
} from "./model-availability.js";
import {
  normalizeWithMateAutoReview,
  type WithMateAutoReviewSettings,
} from "./withmate-auto-review.js";

/** アプリ全体に保存する通知・表示・操作の設定と、Provider やモデル利用の設定。 */
export type AppSettings = {
  launchAtLoginEnabled: boolean;
  sessionTurnNotificationEnabled: boolean;
  sessionApprovalNotificationEnabled: boolean;
  sessionTurnNotificationResponsePreviewEnabled: boolean;
  characterDefinitionEnabled: boolean;
  currentDateEnabled: boolean;
  autoCollapseActionDockOnSend: boolean;
  scrollToLatestOnSend: boolean;
  previewWheelZoomStep: number;
  chatLayoutPreference: ChatLayoutPreference;
  keyboardShortcuts: KeyboardShortcutSettings;
  glossaryProactiveCreateLimit: number | null;
  modelAvailability: ModelAvailabilitySettings;
  withMateAutoReview: WithMateAutoReviewSettings | null;
  codingProviderSettings: Record<string, ProviderAppSettings>;
};

/** Provider ごとの有効状態、API キー、スキルや指示ファイルを探すパスの設定。 */
export type ProviderAppSettings = {
  enabled: boolean;
  apiKey: string;
  skillRootPath: string;
  skillRelativePath?: string;
  instructionRelativePath?: string;
};

/** 未設定の Provider を無効かつ認証情報・パスなしで扱うときの基準値。 */
export const DEFAULT_PROVIDER_APP_SETTINGS: ProviderAppSettings = {
  enabled: false,
  apiKey: "",
  skillRootPath: "",
  skillRelativePath: "",
  instructionRelativePath: "",
};
/** 初期設定で Glossary の自発的な項目作成に適用する件数上限。 */
export const DEFAULT_GLOSSARY_PROACTIVE_CREATE_LIMIT = 5;
/** 自発的な Glossary 項目作成の上限に指定できる最小件数。 */
export const GLOSSARY_PROACTIVE_CREATE_LIMIT_MIN = 0;
/** 自発的な Glossary 項目作成の上限に指定できる最大件数。 */
export const GLOSSARY_PROACTIVE_CREATE_LIMIT_MAX = 100;
/** プレビューのホイールズーム幅が未指定の場合に使うパーセントポイント。 */
export const PREVIEW_WHEEL_ZOOM_STEP_DEFAULT = 5;
/** プレビューのホイールズーム幅に指定できる最小パーセントポイント。 */
export const PREVIEW_WHEEL_ZOOM_STEP_MIN = 1;
/** プレビューのホイールズーム幅に指定できる最大パーセントポイント。 */
export const PREVIEW_WHEEL_ZOOM_STEP_MAX = 100;

/** ホイールズーム幅が設定範囲内の有限な整数か確認する。 */
export function isPreviewWheelZoomStep(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= PREVIEW_WHEEL_ZOOM_STEP_MIN &&
    value <= PREVIEW_WHEEL_ZOOM_STEP_MAX
  );
}

/** 新規利用時の設定を生成する。Provider は既定の Codex のみ有効で、スキルや鍵の指定は空にする。 */
export function createDefaultAppSettings(): AppSettings {
  return {
    launchAtLoginEnabled: false,
    sessionTurnNotificationEnabled: true,
    sessionApprovalNotificationEnabled: true,
    sessionTurnNotificationResponsePreviewEnabled: false,
    characterDefinitionEnabled: true,
    currentDateEnabled: true,
    autoCollapseActionDockOnSend: true,
    scrollToLatestOnSend: true,
    previewWheelZoomStep: PREVIEW_WHEEL_ZOOM_STEP_DEFAULT,
    chatLayoutPreference: { ...DEFAULT_CHAT_LAYOUT_PREFERENCE },
    keyboardShortcuts: createDefaultKeyboardShortcutSettings(),
    glossaryProactiveCreateLimit: DEFAULT_GLOSSARY_PROACTIVE_CREATE_LIMIT,
    modelAvailability: {},
    withMateAutoReview: null,
    codingProviderSettings: {
      [DEFAULT_PROVIDER_ID]: {
        enabled: true,
        apiKey: "",
        skillRootPath: "",
        skillRelativePath: "",
        instructionRelativePath: "",
      },
    },
  };
}

/** 欠落した有効状態には Provider ごとの既定値を使い、文字列でない鍵やパスは空にする。 */
function normalizeProviderAppSettings(
  value: unknown,
  defaultEnabled: boolean,
): ProviderAppSettings {
  if (!value || typeof value !== "object") {
    return {
      enabled: defaultEnabled,
      apiKey: "",
      skillRootPath: "",
      skillRelativePath: "",
      instructionRelativePath: "",
    };
  }

  const candidate = value as Partial<ProviderAppSettings>;
  return {
    enabled:
      typeof candidate.enabled === "boolean"
        ? candidate.enabled
        : defaultEnabled,
    apiKey: typeof candidate.apiKey === "string" ? candidate.apiKey : "",
    skillRootPath:
      typeof candidate.skillRootPath === "string"
        ? candidate.skillRootPath
        : "",
    skillRelativePath:
      typeof candidate.skillRelativePath === "string"
        ? candidate.skillRelativePath
        : "",
    instructionRelativePath:
      typeof candidate.instructionRelativePath === "string"
        ? candidate.instructionRelativePath
        : "",
  };
}

/** ルートと相対パスの余分な境界区切りを除いて結合し、どちらかが空ならルートだけを返す。 */
export function resolveProviderSkillRootPath(
  settings: ProviderAppSettings,
): string {
  const rootDirectory = settings.skillRootPath.trim().replace(/[\\/]+$/g, "");
  const skillRelativePath = (settings.skillRelativePath ?? "")
    .trim()
    .replace(/^[\\/]+|[\\/]+$/g, "");
  if (!rootDirectory || !skillRelativePath) {
    return rootDirectory;
  }

  return `${rootDirectory}/${skillRelativePath}`;
}

/** 作成上限として範囲内の整数を受け入れ、未指定・不正値を null で表す。 */
export function normalizeGlossaryProactiveCreateLimit(
  value: unknown,
): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= GLOSSARY_PROACTIVE_CREATE_LIMIT_MIN &&
    value <= GLOSSARY_PROACTIVE_CREATE_LIMIT_MAX
    ? value
    : null;
}

/** 保存値を項目ごとに復元する。明示された不正なズーム幅は拒否し、OpenCode の API キーは復元しない。 */
export function normalizeAppSettings(value: unknown): AppSettings {
  const defaults = createDefaultAppSettings();
  if (!value || typeof value !== "object") {
    return defaults;
  }

  const candidate = value as Partial<AppSettings>;
  const previewWheelZoomStep =
    candidate.previewWheelZoomStep === undefined
      ? PREVIEW_WHEEL_ZOOM_STEP_DEFAULT
      : candidate.previewWheelZoomStep;
  if (!isPreviewWheelZoomStep(previewWheelZoomStep)) {
    throw new Error(
      "Preview wheel zoom step must be an integer between 1 and 100 percentage points",
    );
  }
  const rawCodingProviderSettings =
    candidate.codingProviderSettings &&
    typeof candidate.codingProviderSettings === "object"
      ? candidate.codingProviderSettings
      : null;
  const codingProviderSettings: Record<string, ProviderAppSettings> = {};
  if (rawCodingProviderSettings) {
    for (const [providerId, providerSettingsValue] of Object.entries(
      rawCodingProviderSettings,
    )) {
      const normalizedProviderId = normalizeProviderId(providerId);
      codingProviderSettings[normalizedProviderId] =
        normalizeProviderAppSettings(
          providerSettingsValue,
          normalizedProviderId === DEFAULT_PROVIDER_ID,
        );
      if (normalizedProviderId === "opencode") {
        codingProviderSettings[normalizedProviderId].apiKey = "";
      }
    }
  }
  if (!codingProviderSettings[DEFAULT_PROVIDER_ID]) {
    codingProviderSettings[DEFAULT_PROVIDER_ID] = {
      ...defaults.codingProviderSettings[DEFAULT_PROVIDER_ID],
    };
  }
  return {
    launchAtLoginEnabled:
      typeof candidate.launchAtLoginEnabled === "boolean"
        ? candidate.launchAtLoginEnabled
        : false,
    sessionTurnNotificationEnabled:
      typeof candidate.sessionTurnNotificationEnabled === "boolean"
        ? candidate.sessionTurnNotificationEnabled
        : true,
    sessionApprovalNotificationEnabled:
      typeof candidate.sessionApprovalNotificationEnabled === "boolean"
        ? candidate.sessionApprovalNotificationEnabled
        : true,
    sessionTurnNotificationResponsePreviewEnabled:
      typeof candidate.sessionTurnNotificationResponsePreviewEnabled ===
      "boolean"
        ? candidate.sessionTurnNotificationResponsePreviewEnabled
        : false,
    characterDefinitionEnabled:
      typeof candidate.characterDefinitionEnabled === "boolean"
        ? candidate.characterDefinitionEnabled
        : true,
    currentDateEnabled:
      typeof candidate.currentDateEnabled === "boolean"
        ? candidate.currentDateEnabled
        : true,
    autoCollapseActionDockOnSend:
      typeof candidate.autoCollapseActionDockOnSend === "boolean"
        ? candidate.autoCollapseActionDockOnSend
        : true,
    scrollToLatestOnSend:
      typeof candidate.scrollToLatestOnSend === "boolean"
        ? candidate.scrollToLatestOnSend
        : true,
    previewWheelZoomStep,
    chatLayoutPreference: normalizeChatLayoutPreference(
      candidate.chatLayoutPreference,
    ),
    keyboardShortcuts: normalizeKeyboardShortcutSettings(
      candidate.keyboardShortcuts,
    ),
    glossaryProactiveCreateLimit: normalizeGlossaryProactiveCreateLimit(
      candidate.glossaryProactiveCreateLimit,
    ),
    modelAvailability: normalizeModelAvailability(candidate.modelAvailability),
    withMateAutoReview: normalizeWithMateAutoReview(
      candidate.withMateAutoReview,
    ),
    codingProviderSettings,
  };
}

/** 指定 Provider の設定を既定値で補って返し、OpenCode には保存値にかかわらず API キーを渡さない。 */
export function getProviderAppSettings(
  settings: AppSettings,
  providerId: string | null | undefined,
): ProviderAppSettings {
  const normalizedProviderId = normalizeProviderId(providerId);
  const providerSettings = normalizeProviderAppSettings(
    settings.codingProviderSettings[normalizedProviderId],
    normalizedProviderId === DEFAULT_PROVIDER_ID,
  );
  return normalizedProviderId === "opencode"
    ? { ...providerSettings, apiKey: "" }
    : providerSettings;
}
