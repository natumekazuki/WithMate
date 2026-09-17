import { z } from "zod";

import type {
  SessionAuthorityEffectClass,
  SessionAuthorityGrant,
  SessionAuthorityPermission,
  SessionAuthorityRelationSelector,
  SessionAuthorityResourceKind,
} from "./session-authority.js";
import type { SessionRuntimeOperation } from "./session-external-runtime-contract.js";
import type { SessionRole } from "./session-role-binding.js";

export const SESSION_GRANT_CONTRACT_REVISION = 1 as const;
export const sessionGrantExpirySchema = z.iso.datetime({ offset: true }).nullable();

export type SessionGrantCreateInput = Readonly<{
  parentGrantId: string;
  parentGrantRevision: number;
  idempotencyKey: string;
  granteeSessionId: string;
  actions: readonly SessionRuntimeOperation[];
  resourceKind: SessionAuthorityResourceKind;
  relationSelector: SessionAuthorityRelationSelector;
  targetSessionRoles: readonly SessionRole[];
  effectClass: SessionAuthorityEffectClass;
  delegable: boolean;
  childCeiling?: readonly SessionAuthorityPermission[];
  expiresAt: string | null;
  budget?: Readonly<Record<string, number>>;
  resourceIds?: readonly string[];
  purpose?: string;
  completionCriteria?: string;
  returnSessionId?: string;
  budgetAccountId?: string;
}>;

export type SessionGrantGetInput = Readonly<{ grantId: string }>;
export type SessionGrantListInput = Readonly<{ granteeSessionId?: string; includeRevoked?: boolean; limit?: number; cursor?: string }>;
export type SessionGrantRevokeInput = Readonly<{ grantId: string; expectedRevision: number; idempotencyKey: string }>;
export type SessionGrantListResult = Readonly<{
  items: SessionGrantResult[];
  nextCursor?: string;
}>;

export type SessionGrantResult = Readonly<{
  contractRevision: typeof SESSION_GRANT_CONTRACT_REVISION;
  grant: SessionAuthorityGrant;
}>;
