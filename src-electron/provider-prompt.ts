import type { RunSessionTurnInput, ProviderPromptComposition } from "./provider-runtime.js";
import { normalizeAllowedAdditionalDirectories } from "./additional-directories.js";

export function composeProviderPrompt(input: RunSessionTurnInput): ProviderPromptComposition {
  const systemSections = [
    input.appSettings.systemPromptPrefix.trim(),
    input.character.roleMarkdown.trim() || "キャラクター定義は未設定。",
  ].filter((section) => section.trim().length > 0);

  const systemPromptBody = systemSections.join("\n\n");
  const systemPromptText = systemPromptBody ? `# System Prompt\n\n${systemPromptBody}` : "";
  const referencedImages = input.attachments.filter((attachment) => attachment.kind === "image");
  const inputSections: string[] = [];

  inputSections.push(input.userMessage.trim());
  const inputPromptBody = inputSections.join("\n\n");
  const inputPromptText = inputPromptBody ? `# User Input Prompt\n\n${inputPromptBody}` : "";
  const composedPromptText = [systemPromptText, inputPromptText]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");

  return {
    systemBodyText: systemPromptBody,
    inputBodyText: inputPromptBody,
    logicalPrompt: {
      systemText: systemPromptText,
      inputText: inputPromptText,
      composedText: composedPromptText,
    },
    imagePaths: referencedImages.map((attachment) => attachment.absolutePath),
    additionalDirectories: normalizeAllowedAdditionalDirectories(
      input.session.workspacePath,
      input.session.allowedAdditionalDirectories,
    ),
  };
}

export function isCanceledProviderMessage(message: string): boolean {
  return /abort|aborted|cancel|canceled|cancelled/i.test(message);
}
