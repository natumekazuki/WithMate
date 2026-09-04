export const WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV =
  "WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE";
export const WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV =
  "WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED";
export const WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV =
  "WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY";
/** Canonical, client-scoped selector for the Memory runtime owner. */
export const WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV =
  "WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID";
export const WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV =
  "WITHMATE_MEMORY_RUNTIME_GENERATION_ID";
/** Canonical, client-scoped selector for the Session runtime owner. */
export const WITHMATE_SESSION_RUNTIME_APPLICATION_INSTANCE_ID_ENV =
  "WITHMATE_SESSION_RUNTIME_APPLICATION_INSTANCE_ID";
export const WITHMATE_SESSION_RUNTIME_GENERATION_ID_ENV =
  "WITHMATE_SESSION_RUNTIME_GENERATION_ID";
export const WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_HEADER =
  "x-withmate-agent-runtime-binding-reference";

export type AgentRuntimeBindingPolicy = "required" | "optional" | "none";

export type MemoryRuntimeOwnerSelector = {
  applicationInstanceId: string;
  runtimeGenerationId: string;
};

export type SessionRuntimeOwnerSelector = {
  applicationInstanceId: string;
  runtimeGenerationId: string;
};

/** Canonical actor authority projected into provider-bound runtime services. */
export type ProviderAgentRuntimeAuthoritySnapshot = {
  userId: "local-user";
  characterId: string;
  allowedProjectIds: string[];
};
