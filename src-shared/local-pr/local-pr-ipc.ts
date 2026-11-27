import { mainSessionTargetSchema } from "../session/session-target.js";

/** Only the owning Session main frame can open its repository's Pull Requests window. */
export const openLocalPrWindowInput = mainSessionTargetSchema;

export const LOCAL_PR_OPEN_WINDOW = "withmate:local-pr:open-window";
export const LOCAL_PR_EXECUTE = "withmate:local-pr:execute";
export const LOCAL_PR_CHANGED = "withmate:local-pr:changed";
