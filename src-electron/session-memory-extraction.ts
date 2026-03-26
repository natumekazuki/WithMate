import type {
  AuditLogicalPrompt,
  AuditLogUsage,
  AuditTransportPayload,
  Session,
  SessionMemory,
  SessionMemoryDelta,
} from "../src/app-state.js";
import {
  getMemoryExtractionProviderSettings,
  normalizeSessionMemoryDelta,
  type AppSettings,
} from "../src/app-state.js";
import type { ModelReasoningEffort } from "../src/model-catalog.js";

export const SESSION_MEMORY_EXTRACTION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    goal: {
      anyOf: [
        { type: "string" },
        { type: "null" },
      ],
    },
    decisions: {
      type: "array",
      items: { type: "string" },
    },
    openQuestions: {
      type: "array",
      items: { type: "string" },
    },
    nextActions: {
      type: "array",
      items: { type: "string" },
    },
    notes: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

export type SessionMemoryExtractionPrompt = {
  systemText: string;
  userText: string;
  outputSchema: typeof SESSION_MEMORY_EXTRACTION_OUTPUT_SCHEMA;
};

export type SessionMemoryExtractionRequest = {
  session: Session;
  memory: SessionMemory;
  appSettings: AppSettings;
  usage: AuditLogUsage | null;
  force?: boolean;
};

export type SessionMemoryExtractionResolvedSettings = {
  model: string;
  reasoningEffort: ModelReasoningEffort;
  outputTokensThreshold: number;
};

export type SessionMemoryExtractionTriggerReason =
  | "outputTokensThreshold"
  | "session-window-close"
  | "compact-before";

function renderMessages(messages: Session["messages"]): string {
  if (messages.length === 0) {
    return "(messages なし)";
  }

  return messages
    .slice(-10)
    .map((message, index) => {
      const header = `${index + 1}. ${message.role}`;
      const body = message.text.trim() || "(空メッセージ)";
      return `${header}\n${body}`;
    })
    .join("\n\n");
}

function renderCurrentMemory(memory: SessionMemory): string {
  return JSON.stringify(
    {
      goal: memory.goal,
      decisions: memory.decisions,
      openQuestions: memory.openQuestions,
      nextActions: memory.nextActions,
      notes: memory.notes,
    },
    null,
    2,
  );
}

export function getSessionMemoryExtractionSettings(
  appSettings: AppSettings,
  providerId: string,
): SessionMemoryExtractionResolvedSettings {
  const settings = getMemoryExtractionProviderSettings(appSettings, providerId);
  return {
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    outputTokensThreshold: settings.outputTokensThreshold,
  };
}

export function shouldTriggerSessionMemoryExtraction(
  usage: AuditLogUsage | null,
  outputTokensThreshold: number,
  force = false,
): boolean {
  if (force) {
    return true;
  }

  if (!usage) {
    return false;
  }

  return usage.outputTokens >= outputTokensThreshold;
}

export function buildSessionMemoryExtractionPrompt(
  session: Session,
  memory: SessionMemory,
): SessionMemoryExtractionPrompt {
  const systemText = [
    "あなたは WithMate の Session Memory 抽出器です。",
    "返答は JSON object のみを返してください。",
    "Markdown や説明文、コードフェンスは出さないでください。",
    "今回の会話から Session Memory を更新する差分だけを返してください。",
    "確定していない内容を decisions に入れないでください。",
    "更新不要な field は省略して構いません。",
  ].join("\n");

  const userText = [
    "# Session",
    `provider: ${session.provider}`,
    `taskTitle: ${session.taskTitle}`,
    `workspacePath: ${session.workspacePath}`,
    "",
    "# Current Session Memory",
    renderCurrentMemory(memory),
    "",
    "# Recent Messages",
    renderMessages(session.messages),
    "",
    "# Output JSON shape",
    '{"goal?: string | null, "decisions"?: string[], "openQuestions"?: string[], "nextActions"?: string[], "notes"?: string[]}',
  ].join("\n");

  return {
    systemText,
    userText,
    outputSchema: SESSION_MEMORY_EXTRACTION_OUTPUT_SCHEMA,
  };
}

export function buildSessionMemoryExtractionLogicalPrompt(
  prompt: SessionMemoryExtractionPrompt,
): AuditLogicalPrompt {
  return {
    systemText: prompt.systemText,
    inputText: prompt.userText,
    composedText: `${prompt.systemText}\n\n${prompt.userText}`.trim(),
  };
}

export function buildSessionMemoryExtractionTransportPayload(
  provider: string,
  settings: SessionMemoryExtractionResolvedSettings,
  triggerReason: SessionMemoryExtractionTriggerReason,
): AuditTransportPayload {
  return {
    summary: "Session Memory extraction payload",
    fields: [
      { label: "provider", value: provider },
      { label: "model", value: settings.model },
      { label: "reasoningEffort", value: settings.reasoningEffort },
      { label: "trigger", value: triggerReason },
      { label: "outputTokensThreshold", value: String(settings.outputTokensThreshold) },
    ],
  };
}

export function parseSessionMemoryDeltaText(rawText: string): SessionMemoryDelta | null {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }

  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fencedMatch ? fencedMatch[1] ?? "" : trimmed;

  try {
    const parsed = JSON.parse(jsonText);
    const normalized = normalizeSessionMemoryDelta(parsed);
    const compacted = Object.fromEntries(
      Object.entries(normalized).filter(([, value]) => value !== undefined),
    ) as SessionMemoryDelta;
    return Object.keys(compacted).length > 0 ? compacted : {};
  } catch {
    return null;
  }
}
