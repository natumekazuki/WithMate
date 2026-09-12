import type { DatabaseSync } from "node:sqlite";

/** The immutable runtime tuple used by a Session turn. */
export type SessionBindingRevision = Readonly<{
  sessionId: string;
  revision: number;
  providerId: string;
  modelId: string;
  reasoningEffort: string;
  customAgentName: string;
  catalogRevision: number;
  threadId: string;
  workspaceLabel: string;
  workspacePath: string;
  branch: string;
  accessMode: string;
  approvalMode: string;
  codexSandboxMode: string;
  codexSpeed: string;
  codexReviewer: string;
  allowedAdditionalDirectories: readonly string[];
  characterId: string;
  characterName: string;
  characterIconPath: string;
  characterThemeColors: Readonly<Record<string, string>>;
  characterRuntimeSnapshot: unknown | null;
  characterRuntimeIdentity: string | null;
  workspaceGrant: Readonly<Record<string, unknown>> | null;
  providerGeneration: string | null;
  executionGeneration: string | null;
  roleBinding: Readonly<{
    sessionRole: string;
    roleContractRevision: number;
    rootSessionId: string;
    parentSessionId: string | null;
    delegationDepth: number;
  }> | null;
}>;

export type SessionBindingEventPayload = Readonly<{
  binding: SessionBindingRevision;
}>;

/**
 * Reads binding revisions from the existing Session resource history.
 * Session lifecycle writers append the `binding` member to the same
 * migration_baseline/configure/move event payload; this reader deliberately
 * owns no additional table or integrity ledger.
 */
export class SessionBindingStorage {
  constructor(private readonly db: DatabaseSync) {}

  getActive(sessionId: string): SessionBindingRevision | null {
    const row = this.db.prepare(`
      SELECT event.payload_json
      FROM session_resource_events_v6 AS event
      WHERE event.session_id = ?
      ORDER BY event.revision DESC
    `).all(sessionId.trim()) as Array<{ payload_json: string }>;
    for (const event of row) {
      const binding = decodeBindingPayload(event.payload_json);
      if (binding) return binding;
    }
    return null;
  }

  getAtRevision(sessionId: string, revision: number): SessionBindingRevision | null {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new RangeError("Session binding revision must be a positive integer.");
    }
    const row = this.db.prepare(`
      SELECT payload_json
      FROM session_resource_events_v6
      WHERE session_id = ? AND revision <= ?
      ORDER BY revision DESC
    `).all(sessionId.trim(), revision) as Array<{ payload_json: string }>;
    for (const event of row) {
      const binding = decodeBindingPayload(event.payload_json);
      if (binding) return binding;
    }
    return null;
  }
}

export class SessionBindingRevisionConflictError extends Error {
  readonly code = "SESSION_BINDING_REVISION_CONFLICT";

  constructor(
    readonly sessionId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Session binding revision is stale: ${sessionId}`);
    this.name = "SessionBindingRevisionConflictError";
  }
}

export function assertSessionBindingCurrent(
  db: DatabaseSync,
  sessionId: string,
  binding: SessionBindingRevision,
): SessionBindingRevision {
  const current = new SessionBindingStorage(db).getActive(sessionId);
  if (!current) {
    throw new Error(`Session binding is not initialized: ${sessionId}`);
  }
  if (current.revision !== binding.revision || !sameBindingTuple(current, binding)) {
    throw new SessionBindingRevisionConflictError(sessionId, binding.revision, current.revision);
  }
  return current;
}

export function buildSessionBindingEventPayload(
  binding: SessionBindingRevision,
): SessionBindingEventPayload {
  return { binding: structuredClone(binding) };
}

export function decodeBindingPayload(serialized: string): SessionBindingRevision | null {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const hasBinding = Object.prototype.hasOwnProperty.call(value, "binding");
  const candidate = (value as { binding?: unknown }).binding;
  if (!hasBinding) return null;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Session binding event has an invalid binding payload.");
  }
  const binding = candidate as Partial<SessionBindingRevision>;
  const revision = binding.revision;
  const catalogRevision = binding.catalogRevision;
  if (
    typeof binding.sessionId !== "string" ||
    typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 ||
    typeof binding.providerId !== "string" ||
    typeof binding.modelId !== "string" ||
    typeof binding.reasoningEffort !== "string" ||
    typeof binding.customAgentName !== "string" ||
    typeof catalogRevision !== "number" || !Number.isSafeInteger(catalogRevision) || catalogRevision < 1 ||
    typeof binding.threadId !== "string" ||
    !(binding.characterRuntimeIdentity === null || typeof binding.characterRuntimeIdentity === "string") ||
    !(binding.workspaceGrant === null || (typeof binding.workspaceGrant === "object" && !Array.isArray(binding.workspaceGrant))) ||
    !(binding.providerGeneration === null || typeof binding.providerGeneration === "string") ||
    !(binding.executionGeneration === null || typeof binding.executionGeneration === "string")
    || typeof binding.workspaceLabel !== "string"
    || typeof binding.workspacePath !== "string"
    || typeof binding.branch !== "string"
    || typeof binding.accessMode !== "string"
    || typeof binding.approvalMode !== "string"
    || typeof binding.codexSandboxMode !== "string"
    || typeof binding.codexSpeed !== "string"
    || typeof binding.codexReviewer !== "string"
    || !Array.isArray(binding.allowedAdditionalDirectories)
    || !binding.allowedAdditionalDirectories.every((value): value is string => typeof value === "string")
    || typeof binding.characterId !== "string"
    || typeof binding.characterName !== "string"
    || typeof binding.characterIconPath !== "string"
    || !binding.characterThemeColors || typeof binding.characterThemeColors !== "object"
    || Array.isArray(binding.characterThemeColors)
    || !(binding.roleBinding === null || (
      typeof binding.roleBinding === "object" && !Array.isArray(binding.roleBinding)
      && typeof binding.roleBinding.sessionRole === "string"
      && typeof binding.roleBinding.roleContractRevision === "number"
      && typeof binding.roleBinding.rootSessionId === "string"
      && (binding.roleBinding.parentSessionId === null || typeof binding.roleBinding.parentSessionId === "string")
      && typeof binding.roleBinding.delegationDepth === "number"
    ))
  ) throw new Error("Session binding event has an invalid binding tuple.");
  return structuredClone(binding as SessionBindingRevision);
}

function sameBindingTuple(left: SessionBindingRevision, right: SessionBindingRevision): boolean {
  return left.sessionId === right.sessionId
    && left.revision === right.revision
    && left.providerId === right.providerId
    && left.modelId === right.modelId
    && left.reasoningEffort === right.reasoningEffort
    && left.customAgentName === right.customAgentName
    && left.customAgentName === right.customAgentName
    && left.catalogRevision === right.catalogRevision
    && left.threadId === right.threadId
    && left.workspaceLabel === right.workspaceLabel
    && left.workspacePath === right.workspacePath
    && left.branch === right.branch
    && left.accessMode === right.accessMode
    && left.approvalMode === right.approvalMode
    && left.codexSandboxMode === right.codexSandboxMode
    && left.codexSpeed === right.codexSpeed
    && left.codexReviewer === right.codexReviewer
    && JSON.stringify(left.allowedAdditionalDirectories) === JSON.stringify(right.allowedAdditionalDirectories)
    && left.characterId === right.characterId
    && left.characterName === right.characterName
    && left.characterIconPath === right.characterIconPath
    && JSON.stringify(left.characterThemeColors) === JSON.stringify(right.characterThemeColors)
    && JSON.stringify(left.characterRuntimeSnapshot) === JSON.stringify(right.characterRuntimeSnapshot)
    && left.characterRuntimeIdentity === right.characterRuntimeIdentity
    && JSON.stringify(left.workspaceGrant) === JSON.stringify(right.workspaceGrant)
    && left.providerGeneration === right.providerGeneration
    && left.executionGeneration === right.executionGeneration
    && JSON.stringify(left.roleBinding) === JSON.stringify(right.roleBinding);
}
