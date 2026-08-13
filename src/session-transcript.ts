export const PUBLIC_TRANSCRIPT_SCHEMA_VERSION = "withmate-public-transcript-v2" as const;

export const SESSION_TRANSCRIPT_INLINE_DEFAULT_MAX_BYTES = 1024 * 1024;
export const SESSION_TRANSCRIPT_INLINE_HARD_MAX_BYTES = 8 * 1024 * 1024;
export const SESSION_TRANSCRIPT_FOLDER_DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const SESSION_TRANSCRIPT_FOLDER_HARD_MAX_BYTES = 1024 * 1024 * 1024;

export type SessionTranscriptFormat = "json" | "markdown";
export type PublicTranscriptCompleteness = "complete" | "legacy_partial";

export type PublicTranscriptMessageV1 = {
  sequence: number;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

export type PublicTranscriptAttachmentV1 = {
  kind: "file" | "folder" | "image";
  relativePath: string;
};

export type PublicTranscriptToolEventV1 = {
  kind: string;
  summary: string;
  createdAt: string;
};

export type PublicTranscriptTurnOptionsV1 = {
  provider: "codex" | "copilot";
  model: string;
  reasoningEffort: string;
  approvalMode: string;
  sandboxMode: string | null;
  customAgentName: string | null;
};

export type PublicTranscriptTurnV1 = {
  sequence: number;
  projectionCompleteness: PublicTranscriptCompleteness;
  executionId: string | null;
  state: "queued" | "running" | "completed" | "failed" | "canceled" | "interrupted";
  effectiveOptions: PublicTranscriptTurnOptionsV1 | null;
  attachments: PublicTranscriptAttachmentV1[];
  progress: { text: string; truncated: boolean } | null;
  toolEvents: PublicTranscriptToolEventV1[];
  startedAt: string;
  completedAt: string | null;
};

export type PublicTranscriptInteractionFieldV1 = {
  name: string;
  label: string;
  type: string;
  required: boolean;
};

export type PublicTranscriptInteractionV1 = {
  sequence: number;
  interactionId: string;
  executionId: string;
  kind: "approval" | "elicitation";
  state: "pending" | "answered" | "expired";
  prompt: string;
  fields: PublicTranscriptInteractionFieldV1[];
  response: { action: string; submittedFields: string[] } | null;
  expiryReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type PublicTranscriptV1 = {
  schemaVersion: typeof PUBLIC_TRANSCRIPT_SCHEMA_VERSION;
  completeness: PublicTranscriptCompleteness;
  session: {
    sessionId: string;
    title: string;
    createdAt: string;
    updatedAt: string;
  };
  messages: PublicTranscriptMessageV1[];
  turns: PublicTranscriptTurnV1[];
  interactions: PublicTranscriptInteractionV1[];
};

export type PublicTranscriptV1Input = Omit<PublicTranscriptV1, "schemaVersion">;

export type PublicTranscriptStreamV1 = {
  schemaVersion: typeof PUBLIC_TRANSCRIPT_SCHEMA_VERSION;
  completeness: PublicTranscriptCompleteness;
  session: PublicTranscriptV1["session"];
  messages: Iterable<PublicTranscriptMessageV1>;
  turns: Iterable<PublicTranscriptTurnV1>;
  interactions: Iterable<PublicTranscriptInteractionV1>;
};

export type SessionTranscriptInlineDestination = {
  kind: "inline";
};

export type SessionTranscriptFolderDestination = {
  kind: "session_folder";
  relativePath: string;
  replace: boolean;
  idempotencyKey: string;
};

export type SessionTranscriptExportInput = {
  sessionId: string;
  format: SessionTranscriptFormat;
  maxBytes: number;
  destination: SessionTranscriptInlineDestination | SessionTranscriptFolderDestination;
};

export type SessionTranscriptInlineResult = {
  destination: "inline";
  format: SessionTranscriptFormat;
  byteLength: number;
  content: string;
};

export type SessionTranscriptFolderResult = {
  destination: "session_folder";
  format: SessionTranscriptFormat;
  file: {
    sessionId: string;
    relativePath: string;
    byteLength: number;
    modifiedAt: string;
    sha256: string;
  };
};

export type SessionTranscriptExportResult =
  | SessionTranscriptInlineResult
  | SessionTranscriptFolderResult;

export function createPublicTranscriptV1(input: PublicTranscriptV1Input): PublicTranscriptV1 {
  return {
    schemaVersion: PUBLIC_TRANSCRIPT_SCHEMA_VERSION,
    completeness: input.completeness,
    session: {
      sessionId: input.session.sessionId,
      title: input.session.title,
      createdAt: input.session.createdAt,
      updatedAt: input.session.updatedAt,
    },
    messages: input.messages.map((message) => ({
      sequence: message.sequence,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
    })),
    turns: input.turns.map((turn) => ({
      sequence: turn.sequence,
      projectionCompleteness: turn.projectionCompleteness,
      executionId: turn.executionId,
      state: turn.state,
      effectiveOptions: turn.effectiveOptions === null ? null : {
        provider: turn.effectiveOptions.provider,
        model: turn.effectiveOptions.model,
        reasoningEffort: turn.effectiveOptions.reasoningEffort,
        approvalMode: turn.effectiveOptions.approvalMode,
        sandboxMode: turn.effectiveOptions.sandboxMode,
        customAgentName: turn.effectiveOptions.customAgentName,
      },
      attachments: turn.attachments.map((attachment) => ({
        kind: attachment.kind,
        relativePath: attachment.relativePath,
      })),
      progress: turn.progress === null ? null : {
        text: turn.progress.text,
        truncated: turn.progress.truncated,
      },
      toolEvents: turn.toolEvents.map((event) => ({
        kind: event.kind,
        summary: event.summary,
        createdAt: event.createdAt,
      })),
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
    })),
    interactions: input.interactions.map((interaction) => ({
      sequence: interaction.sequence,
      interactionId: interaction.interactionId,
      executionId: interaction.executionId,
      kind: interaction.kind,
      state: interaction.state,
      prompt: interaction.prompt,
      fields: interaction.fields.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required,
      })),
      response: interaction.response === null ? null : {
        action: interaction.response.action,
        submittedFields: [...interaction.response.submittedFields],
      },
      expiryReason: interaction.expiryReason,
      createdAt: interaction.createdAt,
      resolvedAt: interaction.resolvedAt,
    })),
  };
}

export function* serializePublicTranscriptChunks(
  transcript: PublicTranscriptV1 | PublicTranscriptStreamV1,
  format: SessionTranscriptFormat,
): Generator<string> {
  const jsonChunks = serializePublicTranscriptJsonChunks(transcript);
  if (format === "json") {
    yield* jsonChunks;
    return;
  }

  const title = transcript.session.title.replace(/[\r\n]+/g, " ").trim() || "Session transcript";
  yield `# ${title}\n\n`;
  yield `Schema: ${PUBLIC_TRANSCRIPT_SCHEMA_VERSION}  \n`;
  yield `Completeness: ${transcript.completeness}\n\n`;
  yield "<pre><code class=\"language-json\">";
  for (const chunk of jsonChunks) yield escapeHtml(chunk);
  yield "</code></pre>\n";
}

export function serializePublicTranscript(
  transcript: PublicTranscriptV1,
  format: SessionTranscriptFormat,
): string {
  return Array.from(serializePublicTranscriptChunks(transcript, format)).join("");
}

function* serializePublicTranscriptJsonChunks(
  transcript: PublicTranscriptV1 | PublicTranscriptStreamV1,
): Generator<string> {
  yield "{\n";
  yield `  \"schemaVersion\": ${JSON.stringify(transcript.schemaVersion)},\n`;
  yield `  \"completeness\": ${JSON.stringify(transcript.completeness)},\n`;
  yield `  \"session\": ${indentJson(transcript.session, 2)},\n`;
  yield* serializeArrayProperty("messages", transcript.messages, false);
  yield* serializeArrayProperty("turns", transcript.turns, false);
  yield* serializeArrayProperty("interactions", transcript.interactions, true);
  yield "}\n";
}

function* serializeArrayProperty<T>(name: string, items: Iterable<T>, last: boolean): Generator<string> {
  yield `  ${JSON.stringify(name)}: [`;
  let hasItems = false;
  for (const item of items) {
    yield hasItems ? ",\n" : "\n";
    yield indentJson(item, 4);
    hasItems = true;
  }
  if (hasItems) {
    yield "\n";
    yield "  ";
  }
  yield last ? "]\n" : "],\n";
}

function indentJson(value: unknown, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
