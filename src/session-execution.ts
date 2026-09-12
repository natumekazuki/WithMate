export const SESSION_EXECUTION_QUEUE_LIMIT = 10;

export type SessionExecutionOperation = "turn.run" | "turn.enqueue";
export type SessionExecutionMutationOperation = SessionExecutionOperation | "turn.cancel";

export type TurnInitiator =
  | { kind: "user" }
  | {
      kind: "session";
      sessionId: string;
      character: {
        characterId: string;
        name: string;
        iconFilePath: string;
      };
    };

export type SessionExecutionState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";

export type SessionExecution = {
  id: string;
  revision: number;
  sessionId: string;
  operation: SessionExecutionOperation;
  state: SessionExecutionState;
  result: unknown | null;
  errorCode: string;
  reason: string;
  createdAt: string;
  admittedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  workItemRevision?: number;
  plannedSourceIdentity?: import("./work-item.js").WorkItemSourceIdentity;
  actualStartSourceIdentity?: ActualStartSourceIdentity;
};

export type SessionExecutionStorageRecord = SessionExecution & {
  sequence: number;
  request: unknown;
  /** Binding captured when the execution was admitted. */
  binding?: SessionExecutionBindingSnapshot;
};

export type ActualStartSourceIdentity =
  | Readonly<{ kind: "git_unavailable"; workspace: string; repository: null; branch: null; base: null; head: null }>
  | Readonly<{ kind: "detached_head"; workspace: string; repository: string; branch: null; base: string | null; head: string }>
  | Readonly<{ kind: "unborn_branch"; workspace: string; repository: string; branch: string; base: null; head: null }>
  | Readonly<{ kind: "resolved"; workspace: string; repository: string; branch: string; base: string | null; head: string }>;

export type SessionExecutionBindingSnapshot = Readonly<{
  bindingRevision: number;
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

export type SessionExecutionOriginSnapshot = {
  sourceSessionId: string;
  targetSessionTitle: string;
  targetSessionRole: import("./session-role-binding.js").SessionRole;
  userMessage: string;
};

export type SessionOutboundExecutionRecord = {
  sequence: number;
  executionId: string;
  targetSessionId: string;
  sourceMessageSequence: number;
  operation: SessionExecutionOperation;
  targetSessionTitle: string;
  targetSessionRole: import("./session-role-binding.js").SessionRole;
  userMessage: string;
  createdAt: string;
};

export type SessionInboundExecutionRecord = {
  execution: SessionExecutionStorageRecord;
  targetMessageSequence: number;
};

export type SessionExecutionTurnResult = {
  assistantText: string;
};
