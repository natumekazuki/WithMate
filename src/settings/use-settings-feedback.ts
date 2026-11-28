import { useState } from "react";

/** 通知の元になった操作と、失敗時に入力の修正が必要かを表す。 */
export type SettingsFeedbackSource = {
  action: string;
  error: boolean;
  requiresInput?: boolean;
};

/** 入力修正の通知はまとめて表示し、その他の失敗は復旧先の操作ごとに保持する。 */
export function useSettingsFeedback() {
  const [feedback, setFeedback] = useState(() => ({
    message: "",
    errors: new Map<string, { message: string; requiresInput: boolean }>(),
  }));

  /** 操作ごとの失敗を更新し、その操作が成功した場合にだけ対応する失敗を消す。 */
  const setSettingsFeedback = (
    message: string,
    source: SettingsFeedbackSource,
  ) => {
    setFeedback((current) => {
      const errors = new Map(current.errors);
      if (source.error) {
        errors.set(source.action, {
          message,
          requiresInput: source.requiresInput === true,
        });
      } else {
        errors.delete(source.action);
      }
      return { message, errors };
    });
  };

  /** 共通の通知も操作別の失敗もまとめて初期化する。 */
  const clearSettingsFeedback = () => {
    setFeedback({ message: "", errors: new Map() });
  };

  return {
    settingsFeedback:
      [...feedback.errors.values()]
        .filter((error) => error.requiresInput)
        .map((error) => error.message)
        .join("\n") || (feedback.errors.size === 0 ? feedback.message : ""),
    settingsErrors: new Map(
      [...feedback.errors]
        .filter(([, error]) => !error.requiresInput)
        .map(([action, error]) => [action, error.message]),
    ),
    setSettingsFeedback,
    clearSettingsFeedback,
  };
}
