import type { RunSessionTurnInput, ProviderPromptComposition } from "./provider-runtime.js";
import { normalizeAllowedAdditionalDirectories } from "./additional-directories.js";

function renderBulletSection(title: string, values: string[], maxItems: number): string {
  const trimmed = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, maxItems);
  if (trimmed.length === 0) {
    return "";
  }

  return `${title}:\n${trimmed.map((value) => `- ${value}`).join("\n")}`;
}

function renderSessionMemorySection(input: RunSessionTurnInput): string {
  const sections = [
    input.sessionMemory.goal.trim() ? `Goal:\n- ${input.sessionMemory.goal.trim()}` : "",
    renderBulletSection("Decisions", input.sessionMemory.decisions, 5),
    renderBulletSection("Open Questions", input.sessionMemory.openQuestions, 5),
    renderBulletSection("Next Actions", input.sessionMemory.nextActions, 5),
    renderBulletSection("Notes", input.sessionMemory.notes, 3),
  ].filter((section) => section.trim().length > 0);

  if (sections.length === 0) {
    return "";
  }

  return `# Session Memory\n\n${sections.join("\n\n")}`.trim();
}

function renderProjectMemorySection(input: RunSessionTurnInput): string {
  if (input.projectMemoryEntries.length === 0) {
    return "";
  }

  const lines = input.projectMemoryEntries
    .map((entry) => `- [${entry.category}] ${entry.detail.trim()}`)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return "";
  }

  return `# Project Memory\n\n${lines.join("\n")}`.trim();
}

export function composeProviderPrompt(input: RunSessionTurnInput): ProviderPromptComposition {
  const systemPromptText = input.appSettings.systemPromptPrefix.trim()
    ? `# System Prompt\n\n${input.appSettings.systemPromptPrefix.trim()}`
    : "";
  const characterText = input.character.roleMarkdown.trim()
    ? `# Character\n\n${input.character.roleMarkdown.trim()}`
    : "# Character\n\nキャラクター定義は未設定。";
  const systemSections = [systemPromptText, characterText].filter((section) => section.trim().length > 0);
  const systemPromptBody = systemSections.join("\n\n");
  const referencedImages = input.attachments.filter((attachment) => attachment.kind === "image");
  const inputSections: string[] = [];

  const sessionMemoryText = renderSessionMemorySection(input);
  if (sessionMemoryText) {
    inputSections.push(sessionMemoryText);
  }

  const projectMemoryText = renderProjectMemorySection(input);
  if (projectMemoryText) {
    inputSections.push(projectMemoryText);
  }

  inputSections.push(`# User Input\n\n${input.userMessage.trim()}`);
  const inputPromptBody = inputSections.join("\n\n");
  const inputPromptText = inputPromptBody;
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
