import { z } from "zod";
import type { SessionGraphOperation, SessionGraphOperationResult, SessionGraphRequest } from "./session-graph-contract.js";

export const sessionGraphViewStateSchema = z.object({
  topicId: z.string().nullable(), selectedId: z.string().nullable(),
  zoom: z.number().finite().positive(), scrollLeft: z.number().finite().nonnegative(), scrollTop: z.number().finite().nonnegative(),
}).strict();
export type SessionGraphViewState = z.infer<typeof sessionGraphViewStateSchema>;
export const sessionGraphWindowOpenSchema = z.object({
  sessionId: z.string().min(1).optional(), fromToken: z.string().min(1).optional(), state: sessionGraphViewStateSchema,
}).strict().refine((value) => Boolean(value.sessionId) !== Boolean(value.fromToken));
export type SessionGraphWindowOpenRequest = z.infer<typeof sessionGraphWindowOpenSchema>;
export type SessionGraphWindowPayload = { token: string; ownerSessionId: string; windowTitle: string; state: SessionGraphViewState };
export type SessionGraphWindowApi = {
  openSessionGraphWindow(request: SessionGraphWindowOpenRequest): Promise<{ token: string }>;
  getSessionGraphWindowPayload(token: string): Promise<SessionGraphWindowPayload | null>;
  readSessionGraphWindow<K extends Exclude<SessionGraphOperation, "apply">>(token: string, operation: K, request: SessionGraphRequest<K>): Promise<SessionGraphOperationResult<K>>;
  updateSessionGraphWindowState(token: string, state: SessionGraphViewState): Promise<void>;
  openSessionGraphWindowReference(token: string, target: string): Promise<import("../file-explorer/file-explorer-contract.js").SessionFilePreviewWindowOpenResult>;
};
