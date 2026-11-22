import { z } from "zod";
import type { ManagedReviewHistory } from "../platform/agent-runtime/managed-http-mcp-host.js";
import type { WithMateAutoReviewSettings } from "../../src-shared/settings/withmate-auto-review.js";

export const approvalReviewDecisionSchema = z.strictObject({
  decision: z.enum(["allow_once", "deny", "ask_user"]),
  reason: z.string().min(1).max(500).refine((value) => value.trim().length > 0),
});

export type ApprovalReviewDecision = z.infer<typeof approvalReviewDecisionSchema>;

export type ApprovalReviewerConversation = {
  /** Only the adapter's structured result channel may satisfy this contract. */
  review(prompt: string): Promise<unknown>;
  close(): void;
};

export type OpenApprovalReviewer = (input: {
  selection: WithMateAutoReviewSettings;
  history: ManagedReviewHistory;
  signal: AbortSignal;
}) => Promise<ApprovalReviewerConversation>;
