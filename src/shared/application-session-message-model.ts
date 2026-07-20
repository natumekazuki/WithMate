import type {
  ApplicationAccessDecision,
  ApplicationOperationOptions,
  ApplicationOperationResponse,
  ApplicationSessionOperationContext,
} from "./application-service-model.js";
import { MESSAGE_CONTENT_LIMITS, type TextContentBlock } from "./message-content.js";
import { REPOSITORY_READ_LIMITS } from "./repository-read-model.js";

export const APPLICATION_SESSION_MESSAGE_LIMITS = {
  maxIdentifierLength: 1_024,
  maxCursorLength: 2_048,
  messagesDefaultItems: REPOSITORY_READ_LIMITS.messages.default,
  messagesMaxItems: REPOSITORY_READ_LIMITS.messages.max,
  inlineMaxBytes: MESSAGE_CONTENT_LIMITS.inlineMaxBytes,
  maxContentBytes: MESSAGE_CONTENT_LIMITS.maxJsonBytes,
  chunkMaxBytes: 256 * 1_024,
} as const;

export type ApplicationSessionMessageOperation = "messages" | "message_content_chunk";

type ApplicationSessionMessageItemBase = Readonly<{
  id: string;
  ordinal: number;
  role: "user" | "assistant";
  contentByteLength: number;
  createdAt: number;
}>;

export type ApplicationSessionMessageItem = ApplicationSessionMessageItemBase &
  (
    | Readonly<{ content: Readonly<{ state: "inline"; blocks: readonly TextContentBlock[] }> }>
    | Readonly<{ content: Readonly<{ state: "chunked"; blocks?: never }> }>
  );

export type ApplicationSessionMessagePage = Readonly<{
  sessionId: string;
  items: readonly ApplicationSessionMessageItem[];
  nextCursor?: string;
}>;

type ApplicationSessionMessageContentChunkBase = Readonly<{
  sessionId: string;
  messageId: string;
  offset: number;
  totalBytes: number;
  byteLength: number;
  bytes: ArrayBuffer;
}>;

export type ApplicationSessionMessageContentChunk = ApplicationSessionMessageContentChunkBase &
  (Readonly<{ eof: true; nextOffset?: never }> | Readonly<{ eof: false; nextOffset: number }>);

export type ApplicationSessionMessagesRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  sessionId: string;
  cursor?: string;
  limit?: number;
}>;

export type ApplicationSessionMessageContentChunkRequest<TAuthorizationContext> = Readonly<{
  context: ApplicationSessionOperationContext<TAuthorizationContext>;
  sessionId: string;
  messageId: string;
  offset: number;
  maxBytes: number;
}>;

export type ApplicationSessionMessageAccessValidationInput<TAuthorizationContext> =
  | Readonly<{
      operation: "messages";
      access: "read";
      context: ApplicationSessionOperationContext<TAuthorizationContext>;
      target: Readonly<{ kind: "session_messages"; sessionId: string }>;
    }>
  | Readonly<{
      operation: "message_content_chunk";
      access: "read";
      context: ApplicationSessionOperationContext<TAuthorizationContext>;
      target: Readonly<{
        kind: "session_message_content";
        sessionId: string;
        messageId: string;
        offset: number;
        maxBytes: number;
      }>;
    }>;

export interface ApplicationSessionMessageAccessValidator<TAuthorizationContext> {
  authorize(
    input: ApplicationSessionMessageAccessValidationInput<TAuthorizationContext>,
  ): Promise<ApplicationAccessDecision>;
}

export interface ApplicationSessionMessageOperations<TAuthorizationContext> {
  messages(
    request: ApplicationSessionMessagesRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionMessagePage, "read">>;
  messageContentChunk(
    request: ApplicationSessionMessageContentChunkRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionMessageContentChunk, "read">>;
}
