import { z } from "zod";
import type { SessionTurnQueueCapturedInput, SessionTurnQueueReceipt } from "../session/session-turn-queue.js";
import type { SessionTarget } from "../session/session-target.js";

export const coordinationIdentitySchema = z.object({ kind: z.enum(["main", "auxiliary"]), sessionId: z.string().min(1), incarnationId: z.string().min(1) }).strict();
export type CoordinationIdentity = z.infer<typeof coordinationIdentitySchema>;
export type CoordinationActor = { kind: "user" } | (CoordinationIdentity & { turnId: string });
export const coordinationRespondentSchema = z.union([z.object({ kind: z.literal("user") }).strict(), coordinationIdentitySchema]);
export type CoordinationRespondent = z.infer<typeof coordinationRespondentSchema>;
export const coordinationKindSchema = z.enum(["progress", "decision", "escalation", "user_decision_required", "blocker", "result", "correction"]);
const text = z.string().min(1).max(32000);
const operationId = z.string().uuid();
export const coordinationRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list"), crewRootSessionId: z.string().optional(), allCrews: z.boolean().optional(), sessionId: z.string().optional(), mainSessionId: z.string().optional(), userPending: z.boolean().optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  z.object({ operation: z.literal("get"), id: z.string() }).strict(),
  z.object({ operation: z.literal("deliver"), operationId, id: z.string() }).strict(),
  z.object({ operation: z.literal("create"), operationId, kind: coordinationKindSchema, body: text, choices: z.array(text).max(30).default([]), respondent: coordinationRespondentSchema.optional(), deliver: z.boolean().default(false) }).strict(),
  z.object({ operation: z.literal("escalate"), operationId, id: z.string(), body: text }).strict(),
  z.object({ operation: z.literal("answer"), operationId, id: z.string(), body: text, selectedChoices: z.array(z.string()).max(30).default([]), expectedAnswerRevision: z.number().int().nonnegative(), send: z.boolean().default(true) }).strict(),
  z.object({ operation: z.literal("withdraw"), operationId, id: z.string(), reason: z.string().max(32000).default("") }).strict(),
  z.object({ operation: z.literal("resolve"), operationId, id: z.string() }).strict(),
  z.object({ operation: z.literal("consume"), operationId, id: z.string(), answerId: z.string(), answerRevision: z.number().int().positive() }).strict(),
  z.object({ operation: z.literal("correct"), operationId, id: z.string(), body: text }).strict(),
]);
export type CoordinationRequest = z.infer<typeof coordinationRequestSchema>;
export type CoordinationAnswer = { id: string; revision: number; actor: CoordinationActor; body: string; selectedChoices: string[]; createdAt: string; receiptId?: string; acquiredAt?: string; consumedByOperationId?: string };
export type CoordinationRecord = {
  id: string; crewRootSessionId: string; kind: z.infer<typeof coordinationKindSchema>; initiator: CoordinationIdentity; initiatorTurnId: string;
  originReceiptId: string | null; caller: CoordinationIdentity | null; body: string; choices: string[]; respondent: CoordinationRespondent;
  state: "open" | "resolved" | "withdrawn" | "corrected"; withdrawalReason?: string; escalationBody?: string; correctionId?: string; answerRevision: number; answers: CoordinationAnswer[];
  createdAt: string; updatedAt: string;
};
export type CoordinationSummary = Omit<CoordinationRecord, "body" | "choices" | "answers"> & { initiatorMainSessionId: string; bodyPreview: string };
export type CoordinationResult = { record: CoordinationRecord; receipt?: SessionTurnQueueReceipt; initiatorTarget?: SessionTarget } | { items: CoordinationSummary[]; total: number; nextOffset: number | null };
export type CoordinationStorageResult = CoordinationResult & { queueUpdates?: SessionTurnQueueReceipt[] };
/** Trusted application input; never accept this wrapper from MCP/CLI/renderer. */
export type CoordinationStorageInput = { actor: CoordinationActor; request: CoordinationRequest; defaultCrewRootSessionId?: string; delivery?: { target: CoordinationIdentity; captured: SessionTurnQueueCapturedInput } };
export type CoordinationStore = { execute(input: CoordinationStorageInput): Promise<CoordinationStorageResult>; deliveryTarget(input: Omit<CoordinationStorageInput, "delivery">): Promise<CoordinationIdentity | null> };
