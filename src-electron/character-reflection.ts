import type {
  AuditLogicalPrompt,
  AuditTransportPayload,
  CharacterProfile,
  Session,
} from "../src/app-state.js";
import { getCharacterReflectionProviderSettings, type AppSettings } from "../src/provider-settings-state.js";
import {
  normalizeCharacterReflectionOutput,
  type CharacterMemoryDelta,
  type CharacterMemoryEntry,
  type CharacterReflectionOutput,
  type SessionMemory,
} from "../src/memory-state.js";
import type { ModelReasoningEffort } from "../src/model-catalog.js";

export const CHARACTER_REFLECTION_CHAR_DELTA_THRESHOLD = 1200;
export const CHARACTER_REFLECTION_MESSAGE_DELTA_THRESHOLD = 6;
export const CHARACTER_REFLECTION_COOLDOWN_MS = 5 * 60 * 1000;

export type CharacterReflectionTriggerReason = "session-start" | "context-growth";

export type CharacterReflectionPrompt = {
  systemText: string;
  userText: string;
  outputSchema: typeof CHARACTER_REFLECTION_OUTPUT_SCHEMA;
};

export type CharacterReflectionResolvedSettings = {
  model: string;
  reasoningEffort: ModelReasoningEffort;
};

export type CharacterReflectionContextSnapshot = {
  messageCount: number;
  charCount: number;
};

export type CharacterReflectionCheckpoint = CharacterReflectionContextSnapshot & {
  reflectedAt: string;
};

export const CHARACTER_REFLECTION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    memoryDelta: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            entries: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  category: {
                    type: "string",
                    enum: ["preference", "relationship", "shared_moment", "tone", "boundary"],
                  },
                  title: { type: "string" },
                  detail: { type: "string" },
                  keywords: {
                    type: "array",
                    items: { type: "string" },
                  },
                  evidence: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: ["category", "title", "detail"],
              },
            },
          },
          required: ["entries"],
        },
      ],
    },
    monologue: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            mood: {
              type: "string",
              enum: ["spark", "calm", "warm"],
            },
          },
          required: ["text", "mood"],
        },
      ],
    },
  },
  required: ["memoryDelta", "monologue"],
} as const;

function renderRecentMessages(messages: Session["messages"]): string {
  const recentMessages = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-12);
  if (recentMessages.length === 0) {
    return "(messages なし)";
  }

  return recentMessages
    .map((message, index) => `${index + 1}. ${message.role}\n${message.text.trim() || "(空メッセージ)"}`)
    .join("\n\n");
}

function renderCharacterMemoryEntries(entries: CharacterMemoryEntry[]): string {
  if (entries.length === 0) {
    return "(Character Memory なし)";
  }

  return entries
    .slice(0, 8)
    .map((entry, index) => {
      const keywords = entry.keywords.length > 0 ? ` keywords=${entry.keywords.join(", ")}` : "";
      return `${index + 1}. [${entry.category}] ${entry.title}\n${entry.detail}${keywords}`;
    })
    .join("\n\n");
}

function renderSessionMemory(sessionMemory: SessionMemory): string {
  const lines = [
    sessionMemory.goal.trim() ? `goal: ${sessionMemory.goal.trim()}` : "",
    sessionMemory.openQuestions.length > 0 ? `openQuestions: ${sessionMemory.openQuestions.join(" / ")}` : "",
    sessionMemory.nextActions.length > 0 ? `nextActions: ${sessionMemory.nextActions.join(" / ")}` : "",
  ].filter((line) => line.length > 0);

  return lines.length > 0 ? lines.join("\n") : "(Session Memory の要約なし)";
}

export function getCharacterReflectionSettings(
  appSettings: AppSettings,
  providerId: string,
): CharacterReflectionResolvedSettings {
  const settings = getCharacterReflectionProviderSettings(appSettings, providerId);
  return {
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
  };
}

export function buildCharacterReflectionContextSnapshot(session: Session): CharacterReflectionContextSnapshot {
  const relevantMessages = session.messages.filter((message) => message.role === "user" || message.role === "assistant");
  return {
    messageCount: relevantMessages.length,
    charCount: relevantMessages.reduce((sum, message) => sum + message.text.trim().length, 0),
  };
}

export function shouldTriggerCharacterReflection(
  current: CharacterReflectionContextSnapshot,
  checkpoint: CharacterReflectionCheckpoint | null,
  triggerReason: CharacterReflectionTriggerReason,
  now = Date.now(),
): boolean {
  if (triggerReason === "session-start") {
    return true;
  }

  if (!checkpoint) {
    return current.messageCount > 0 || current.charCount > 0;
  }

  const reflectedAtMs = Date.parse(checkpoint.reflectedAt);
  if (!Number.isNaN(reflectedAtMs) && now - reflectedAtMs < CHARACTER_REFLECTION_COOLDOWN_MS) {
    return false;
  }

  const charDelta = current.charCount - checkpoint.charCount;
  const messageDelta = current.messageCount - checkpoint.messageCount;
  return charDelta >= CHARACTER_REFLECTION_CHAR_DELTA_THRESHOLD
    || messageDelta >= CHARACTER_REFLECTION_MESSAGE_DELTA_THRESHOLD;
}

export function buildCharacterReflectionPrompt(input: {
  session: Session;
  sessionMemory: SessionMemory;
  character: CharacterProfile;
  characterMemoryEntries: CharacterMemoryEntry[];
  triggerReason: CharacterReflectionTriggerReason;
}): CharacterReflectionPrompt {
  const { session, sessionMemory, character, characterMemoryEntries, triggerReason } = input;
  const monologueOnly = triggerReason === "session-start";
  const systemText = [
    "あなたは WithMate の Character Reflection 抽出器です。",
    "返答は JSON object のみを返してください。",
    "Markdown や説明文、コードフェンスは出さないでください。",
    "扱うのは coding task の知識ではなく、ユーザーとキャラクターの関係性だけです。",
    "project knowledge、task decision、workspace 情報そのものを Character Memory に保存しないでください。",
    monologueOnly
      ? "今回は SessionStart のため monologue のみ生成し、memoryDelta は null にしてください。"
      : "今回は通常 reflection のため、必要なら memoryDelta と monologue を両方返してください。",
    "memoryDelta は保守的に返し、明確な preference / relationship / shared_moment / tone / boundary だけを入れてください。",
    "monologue は短く、キャラクターの内心として自然な 1〜3 文にしてください。",
    "不明な内容は推測しないでください。",
  ].join("\n");

  const userText = [
    "# Session",
    `taskTitle: ${session.taskTitle}`,
    `characterName: ${character.name}`,
    `trigger: ${triggerReason}`,
    "",
    "# Character Prompt",
    character.roleMarkdown.trim() || "(character prompt なし)",
    "",
    "# Session Memory Summary",
    renderSessionMemory(sessionMemory),
    "",
    "# Existing Character Memory",
    renderCharacterMemoryEntries(characterMemoryEntries),
    "",
    "# Recent Conversation",
    renderRecentMessages(session.messages),
    "",
    "# Output Rules",
    monologueOnly
      ? "- memoryDelta は null にする"
      : "- 関係性更新が不要なら memoryDelta は null にしてよい",
    "- monologue は不要なら null にしてよい",
    "- memoryDelta.entries は重複を避ける",
    "- title と detail は短く具体的にする",
    "- coding task の決定事項は memoryDelta に入れない",
    "",
    "# Output JSON shape",
    '{"memoryDelta": {"entries":[{"category":"relationship","title":"...","detail":"...","keywords":["..."],"evidence":["..."]}]} | null, "monologue": {"text":"...","mood":"spark|calm|warm"} | null}',
  ].join("\n");

  return {
    systemText,
    userText,
    outputSchema: CHARACTER_REFLECTION_OUTPUT_SCHEMA,
  };
}

export function buildCharacterReflectionLogicalPrompt(
  prompt: CharacterReflectionPrompt,
): AuditLogicalPrompt {
  return {
    systemText: prompt.systemText,
    inputText: prompt.userText,
    composedText: `${prompt.systemText}\n\n${prompt.userText}`.trim(),
  };
}

export function buildCharacterReflectionTransportPayload(
  provider: string,
  settings: CharacterReflectionResolvedSettings,
  triggerReason: CharacterReflectionTriggerReason,
): AuditTransportPayload {
  return {
    summary: "Character reflection payload",
    fields: [
      { label: "provider", value: provider },
      { label: "model", value: settings.model },
      { label: "reasoningEffort", value: settings.reasoningEffort },
      { label: "trigger", value: triggerReason },
    ],
  };
}

export function parseCharacterReflectionOutputText(rawText: string): CharacterReflectionOutput | null {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }

  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fencedMatch ? fencedMatch[1] ?? "" : trimmed;

  try {
    return normalizeCharacterReflectionOutput(JSON.parse(jsonText));
  } catch {
    return null;
  }
}

export function hasCharacterMemoryDeltaContent(memoryDelta: CharacterMemoryDelta | null): boolean {
  return !!memoryDelta && memoryDelta.entries.length > 0;
}
