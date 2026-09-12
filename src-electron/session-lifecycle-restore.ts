import type { DatabaseSync } from "node:sqlite";

import {
  RESOURCE_BUDGET_DIMENSIONS,
  type ResourceBudget,
  type ResourceBudgetPartialAmounts,
} from "../src/resource-budget.js";
import type { MutationAuthorityProof } from "../src/session-authority.js";
import type { SessionRuntimeInitialBudget } from "../src/session-external-runtime-contract.js";
import {
  ResourceBudgetError,
  ResourceBudgetStorage,
} from "./resource-budget-storage.js";

/**
 * Applies the budget portion of an in-transaction root restore.
 *
 * Root restore reuses the existing root account. Inherit is deliberately a
 * no-op; an explicit request is a normal budget configuration so that the
 * existing revision, authority, capacity, event, and idempotency rules remain
 * the source of truth. No reservation or cumulative usage is changed here.
 */
export function restoreRootBudgetWithinTransaction(
  db: DatabaseSync,
  rootSessionId: string,
  requested: SessionRuntimeInitialBudget,
  proof: MutationAuthorityProof,
  operationId: string,
  now: string,
): ResourceBudget {
  const budget = new ResourceBudgetStorage(db);
  const current = budget.getByAccountId(rootSessionId);
  if (current.accountKind !== "root" || current.rootSessionId !== rootSessionId
    || current.ownerSessionId !== rootSessionId) {
    throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "Root restore requires the existing root budget account.", {
      accountId: rootSessionId,
    });
  }
  if (requested.kind === "inherit") return current;

  const hardLimits = restoreHardLimits(requested.hardLimits);
  return budget.configure({
    sessionId: rootSessionId,
    accountId: current.accountId,
    expectedRevision: current.revision,
    hardLimits,
    deadlineAt: requested.deadlineAt,
    idempotencyKey: `session-restore-budget:${operationId}`,
  }, proof, now);
}

function restoreHardLimits(
  requested: Readonly<Record<string, number>>,
): ResourceBudgetPartialAmounts {
  for (const [dimension, value] of Object.entries(requested)) {
    if (!RESOURCE_BUDGET_DIMENSIONS.includes(dimension as typeof RESOURCE_BUDGET_DIMENSIONS[number])) {
      throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "The restored root budget contains an unknown dimension.", {
        dimension,
      });
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "The restored root budget contains an invalid hard limit.", {
        dimension,
      });
    }
  }
  return requested as ResourceBudgetPartialAmounts;
}
