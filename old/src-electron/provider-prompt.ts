import type { RunSessionTurnInput, ProviderPromptComposition } from "./provider-runtime.js";
import { normalizeAllowedAdditionalDirectories } from "./additional-directories.js";
import { buildCharacterRuntimePromptSection } from "../src/character/character-runtime-snapshot.js";

function buildCharacterOutputBoundarySection(enabled: boolean): string {
  if (!enabled) {
    return "";
  }

  return [
    "# Output Boundary",
    "",
    "Character 定義は、ユーザーへ返す自然言語の話し方・温度・反応にだけ使ってください。",
    "コード、設定、テスト、ドキュメント、コミットメッセージ案、PR本文案、生成ファイル、diff、artifact summary には、ユーザーが明示しない限り Character の口調・設定・台詞・メタ説明を混ぜないでください。",
    "成果物は repository instruction、既存文体、対象ファイルの目的を優先してください。",
  ].join("\n");
}

export function composeProviderPrompt(input: RunSessionTurnInput): ProviderPromptComposition {
  const isCharacterAuthoringSession = input.session.sessionKind === "character-authoring";
  const characterPromptBody = buildCharacterRuntimePromptSection(input.session.characterRuntimeSnapshot, {
    includeRuntimeBoundary: !isCharacterAuthoringSession,
  });
  const outputBoundaryBody = buildCharacterOutputBoundarySection(
    !isCharacterAuthoringSession && characterPromptBody.trim().length > 0,
  );
  const systemPromptBody = [characterPromptBody, outputBoundaryBody]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
  const referencedImages = input.attachments.filter((attachment) => attachment.kind === "image");
  const inputSections: string[] = [];
  const userMessageText = input.userMessage.trim();

  if (userMessageText) {
    inputSections.push(`# User Input\n\n${userMessageText}`);
  }
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
