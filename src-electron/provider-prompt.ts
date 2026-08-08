import type { RunSessionTurnInput, ProviderPromptComposition } from "./provider-runtime.js";
import { normalizeAllowedAdditionalDirectories } from "./additional-directories.js";
import { buildCharacterRuntimePromptSection } from "../src/character/character-runtime-snapshot.js";
import type { ConversationTimingContext } from "./conversation-timing.js";

function formatTimingDuration(durationMs: number): string {
  const totalMinutes = Math.floor(durationMs / 60_000);
  if (totalMinutes <= 0) {
    return durationMs > 0 ? "less than 1 minute" : "0 minutes";
  }
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  }
  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  }
  if (minutes > 0 && days === 0) {
    parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  }
  return parts.slice(0, 2).join(" ");
}

function buildConversationTimingSection(context?: ConversationTimingContext): string {
  if (!context) {
    return "";
  }
  const dayLabel = `${context.observedDayOfWeek[0]?.toUpperCase() ?? ""}${context.observedDayOfWeek.slice(1)}`;
  const timingLines = [
    `- Observed local time: ${context.observedAt} (${dayLabel})`,
    context.currentSession
      ? `- Previous completed exchange in this session: ${context.currentSession.lastCompletedAt} (${formatTimingDuration(context.currentSession.elapsedMs)} ago)`
      : "",
    context.sameCharacterOtherSession
      ? `- Latest completed exchange with this character in another session: ${context.sameCharacterOtherSession.lastCompletedAt} (${formatTimingDuration(context.sameCharacterOtherSession.elapsedMs)} ago)`
      : "",
    context.sameCharacterSharedWork && context.sameCharacterSharedWork.totalCompletedTurnDurationMs > 0
      ? `- Completed turn execution time with this character: ${formatTimingDuration(context.sameCharacterSharedWork.todayCompletedTurnDurationMs)} today; ${formatTimingDuration(context.sameCharacterSharedWork.totalCompletedTurnDurationMs)} total`
      : "",
  ].filter(Boolean);

  return [
    "# Conversation Timing",
    "",
    "Use this app-observed timing metadata only as a soft signal for conversational pacing and familiarity.",
    "",
    "- Use same-session timing to decide whether to continue directly or briefly restore context. Other-session timing may adjust familiarity, but does not reveal what was discussed there.",
    "- Use local time only as a weak signal for time-appropriate greetings and conversational tone. Do not infer or judge the user's location, schedule, sleep, work, holidays, or lifestyle.",
    "- Work time is a rough measure of completed work with this character. It is wall-clock turn runtime, including provider execution, tools, and retries; it is not continuous presence or conversation time.",
    "- Prioritize the current user input and tone. Do not routinely quote timing values, guilt the user about an absence, or invent events during a gap.",
    "",
    "Observed values:",
    "",
    ...timingLines,
  ].join("\n");
}

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

function buildToolCallPresenceSection(enabled: boolean): string {
  if (!enabled) {
    return "";
  }

  return [
    "# Tool Call Presence",
    "",
    "tool call や command 実行を伴う場合は、最初の tool call より前に、ユーザーへ1〜3文程度の短い自然言語レスポンスを返してください。",
    "発言は詳細な作業計画や tool call の説明である必要はありません。依頼への相づち、挨拶、キャラクターらしい反応など、会話として自然な内容で構いません。",
    "キャラクターが無言のまま作業へ入り、応答が止まったように見える体験を避けることを優先してください。",
    "開始時の発言を毎回同じ定型句に固定しないでください。",
    "長い作業では適度に途中経過や反応を返してください。ただし、routine な tool call ごとに実況する必要はありません。",
    "tool call が不要な応答では、このルールのためだけに前置きを追加する必要はありません。",
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
  const toolCallPresenceBody = buildToolCallPresenceSection(
    !isCharacterAuthoringSession && characterPromptBody.trim().length > 0,
  );
  const systemPromptBody = [characterPromptBody, outputBoundaryBody, toolCallPresenceBody]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
  const referencedImages = input.attachments.filter((attachment) => attachment.kind === "image");
  const inputSections: string[] = [];
  const userMessageText = input.userMessage.trim();
  const conversationTimingBody = buildConversationTimingSection(input.conversationTimingContext);

  if (conversationTimingBody) {
    inputSections.push(conversationTimingBody);
  }

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
