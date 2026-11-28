export const WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV =
  "WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE";
export const WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV =
  "WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED";
export const WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV =
  "WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY";
/** Agent runtime の所有者をクライアント単位で特定する正規のセレクター。 */
export const WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV =
  "WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID";
export const WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV =
  "WITHMATE_AGENT_RUNTIME_GENERATION_ID";
export const WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_HEADER =
  "x-withmate-agent-runtime-binding-reference";

export type AgentRuntimeBindingPolicy = "required" | "optional" | "none";

export type RuntimeOwnerSelector = {
  applicationInstanceId: string;
  runtimeGenerationId: string;
};
