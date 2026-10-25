import { useState } from "react";

export type SettingsFeedbackSource = { action: string; error: boolean };

export function useSettingsFeedback() {
  const [feedback, setFeedback] = useState(() => ({
    message: "",
    errors: new Map<string, string>(),
  }));

  const setSettingsFeedback = (message: string, source: SettingsFeedbackSource) => {
    setFeedback((current) => {
      const errors = new Map(current.errors);
      if (source.error) {
        errors.set(source.action, message);
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
    settingsFeedback: [...feedback.errors.values()].join("\n") || feedback.message,
    setSettingsFeedback,
    clearSettingsFeedback,
  };
}
