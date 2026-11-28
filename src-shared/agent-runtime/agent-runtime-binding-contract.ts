/** 環境変数で渡す、Agent runtimeのバインディング参照のキー。 */
export const WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV =
  "WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE";
/** 値が1なら参照を持たない呼び出しを受け付けないことを通知するキー。 */
export const WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV =
  "WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED";
/** バインディングを使用する呼び出しへTurn単位のcapabilityを渡すキー。 */
export const WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV =
  "WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY";
/** Agent runtime の所有者をクライアント単位で特定する正規のセレクター。 */
export const WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV =
  "WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID";
/** クライアントが接続先runtimeの世代を識別するための環境変数キー。 */
export const WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV =
  "WITHMATE_AGENT_RUNTIME_GENERATION_ID";
/** HTTPでAgent runtimeのバインディング参照を送るときのヘッダー名。 */
export const WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_HEADER =
  "x-withmate-agent-runtime-binding-reference";

/** 呼び出し経路でバインディングを必須、任意、または利用なしとする区分。 */
export type AgentRuntimeBindingPolicy = "required" | "optional" | "none";

/** アプリの起動単位とruntimeの世代を組み合わせて接続先を識別する。 */
export type RuntimeOwnerSelector = {
  applicationInstanceId: string;
  runtimeGenerationId: string;
};
