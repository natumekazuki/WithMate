import type { RunSessionTurnInput, ProviderPromptComposition } from "./provider-runtime.js";
import { normalizeAllowedAdditionalDirectories } from "./additional-directories.js";

export function composeProviderPrompt(input: RunSessionTurnInput): ProviderPromptComposition {
  const systemPromptPrefixText = input.appSettings.systemPromptPrefix.trim()
    ? `# System Prompt\n\n${input.appSettings.systemPromptPrefix.trim()}`
    : "";
  const characterText = input.character.roleMarkdown.trim()
    ? `# Character\n\n${input.character.roleMarkdown.trim()}`
    : "# Character\n\nキャラクター定義は未設定。";
  const systemSections = [systemPromptPrefixText, characterText].filter((section) => section.trim().length > 0);
  const systemPromptBody = systemSections.join("\n\n");
  const projectContextText = input.projectContextText?.trim();
  const projectContextSection = projectContextText ? `# Project Context\n\n${projectContextText}` : "";
  const referencedImages = input.attachments.filter((attachment) => attachment.kind === "image");
  const inputSections: string[] = [];

  if (projectContextSection) {
    inputSections.push(projectContextSection);
  }

  inputSections.push(`# User Input\n\n${input.userMessage.trim()}`);
  const inputPromptBody = inputSections.join("\n\n");
  const inputPromptText = inputPromptBody;
  const composedPromptText = [systemPromptBody, inputPromptText]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");

  return {
    systemBodyText: systemPromptBody,
    inputBodyText: inputPromptBody,
    logicalPrompt: {
      systemText: systemPromptBody,
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
