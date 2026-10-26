import { useState } from "react";

export type SettingsFeedbackSource = { action: string; error: boolean; requiresInput?: boolean };

export function useSettingsFeedback() {
  const [feedback, setFeedback] = useState(() => ({
    message: "",
    errors: new Map<string, { message: string; requiresInput: boolean }>(),
  }));

  const setSettingsFeedback = (message: string, source: SettingsFeedbackSource) => {
    setFeedback((current) => {
      const errors = new Map(current.errors);
      if (source.error) {
        errors.set(source.action, { message, requiresInput: source.requiresInput === true });
      } else {
        errors.delete(source.action);
      }
      return { message, errors };
    });
  };

  const clearSettingsFeedback = () => {
    setFeedback({ message: "", errors: new Map() });
  };

  return {
    settingsFeedback: [...feedback.errors.values()].filter((error) => error.requiresInput)
      .map((error) => error.message).join("\n") || (feedback.errors.size === 0 ? feedback.message : ""),
    settingsErrors: new Map([...feedback.errors].filter(([, error]) => !error.requiresInput)
      .map(([action, error]) => [action, error.message])),
    setSettingsFeedback,
    clearSettingsFeedback,
  };
}
