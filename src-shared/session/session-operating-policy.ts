import { z } from "zod";

export const OPERATING_POLICY_PROVIDERS = ["codex", "copilot", "claude", "opencode"] as const;
const provider = z.enum(OPERATING_POLICY_PROVIDERS);
const text = z.string().trim().min(1).max(20000);
const path = z.string().min(1).max(32768);
const workspace = { workspacePath: path.optional() };

/** Human-authored guidance, not execution defaults or provider credentials. Array order is priority. */
export const selectionPolicySchema = z.object({
  selectionCriteria: text.describe("Task/output/judgment criteria for choosing Provider and Model; not a fixed Role mapping."),
  executionGuidelines: text.describe("Depth, Approval and Sandbox guidelines; these never grant permissions."),
  contractRoutes: z.array(z.object({
    name: z.string().trim().min(1).max(300),
    provider,
    nativeProviderId: z.string().trim().min(1).max(300).optional(),
    modelId: z.string().trim().min(1).max(500).optional().describe("Native model ID; for OpenCode compare nativeProviderId/modelId against get_catalog."),
    conditions: text.describe("Usage conditions, plan/billing evidence and limitations. No API keys or authentication data."),
  }).strict()).max(100).describe("Contract routes in preferred order. OpenCode nativeProviderId/modelId identify the actual route when specified."),
}).strict();
export type SelectionPolicy = z.infer<typeof selectionPolicySchema>;

export const worktreeRepositoryRuleSchema = z.object({
  categoryPath: z.string().max(2000).describe("Relative classification path, e.g. Electron or .net/MAUI. Empty string explicitly means no classification directory."),
  repositoryName: z.string().min(1).max(255).describe("One directory name for this repository."),
  layout: z.string().min(1).max(2000).describe("Relative layout below root/categoryPath, containing {repository} and {branch}, e.g. {repository}/{branch}. Branch slashes form nested directories."),
}).strict();
export type WorktreeRepositoryRule = z.infer<typeof worktreeRepositoryRuleSchema>;
export const worktreePolicySchema = z.object({
  rootPath: path.nullable(),
  repositories: z.record(z.string(), worktreeRepositoryRuleSchema),
}).strict();
export type WorktreePolicy = z.infer<typeof worktreePolicySchema>;

export const sessionOperatingPolicyRequestSchemas = {
  get_selection_policy: z.object({}).strict(),
  set_selection_policy: z.object({ policy: selectionPolicySchema.nullable() }).strict(),
  get_provider_quota: z.object({ provider: provider.optional() }).strict(),
  get_worktree_policy: z.object(workspace).strict(),
  set_worktree_root: z.object({ rootPath: path.nullable() }).strict(),
  set_worktree_repository: z.object({ ...workspace, rule: worktreeRepositoryRuleSchema.nullable() }).strict(),
  resolve_worktree: z.object({ ...workspace, branch: z.string().min(1).max(1000), destinationPath: path.optional() }).strict(),
} as const;
export type SessionOperatingPolicyOperation = keyof typeof sessionOperatingPolicyRequestSchemas;
export type SessionOperatingPolicyRequest<K extends SessionOperatingPolicyOperation> = z.infer<(typeof sessionOperatingPolicyRequestSchemas)[K]>;
export function isSessionOperatingPolicyOperation(operation: string): operation is SessionOperatingPolicyOperation {
  return Object.hasOwn(sessionOperatingPolicyRequestSchemas, operation);
}
export const SESSION_OPERATING_POLICY_READS = ["get_selection_policy", "get_provider_quota", "get_worktree_policy", "resolve_worktree"] as const;

const selectionResult = z.object({ ok: z.literal(true), policy: selectionPolicySchema.nullable() }).strict();
const repositoryResult = z.object({ ok: z.literal(true), repositoryId: path, rootPath: path.nullable(), rule: worktreeRepositoryRuleSchema.nullable() }).strict();
const quotaTelemetry = z.object({
  provider: z.string(),
  updatedAt: z.string().nullable(),
  snapshots: z.array(z.object({
    quotaKey: z.string(), entitlementRequests: z.number(), usedRequests: z.number(), remainingPercentage: z.number(),
    overage: z.number(), overageAllowedWithExhaustedQuota: z.boolean(), resetDate: z.string().optional(),
  }).strict()),
  rateLimits: z.array(z.object({
    quotaKey: z.string(), label: z.string().optional(), usedPercentage: z.number(), windowDurationMinutes: z.number().optional(), resetDate: z.string().optional(),
  }).strict()).optional(),
  status: z.enum(["loading", "ready", "error", "unsupported"]).optional(),
}).strict();
export const sessionOperatingPolicySuccessSchemas = {
  get_selection_policy: selectionResult,
  set_selection_policy: selectionResult,
  get_provider_quota: z.object({ ok: z.literal(true), providers: z.array(z.object({ provider, telemetry: quotaTelemetry.nullable() }).strict()) }).strict(),
  get_worktree_policy: repositoryResult,
  set_worktree_root: z.object({ ok: z.literal(true), rootPath: path.nullable() }).strict(),
  set_worktree_repository: repositoryResult,
  resolve_worktree: z.object({
    ok: z.literal(true), repositoryId: path, branch: z.string(),
    status: z.enum(["existing", "planned", "unconfigured"]),
    source: z.enum(["git", "policy", "override"]).nullable(),
    destinationPath: path.nullable(),
    missing: z.array(z.enum(["rootPath", "repositoryRule"])),
  }).strict(),
} as const;

export const SESSION_OPERATING_POLICY_READ_NOTICE = "Before creating a child or reselecting execution settings for an existing Session, read get_selection_policy and get_catalog for the intended Provider/Workspace; use get_provider_quota when relevant. Policy is guidance, not availability, free access, permission or authority. An existing Session's Provider is fixed; enqueue selects only its next Turn's options and Steer retains running settings. Before creating a Git Worktree, read resolve_worktree for the repository and branch; distinguish an existing Worktree from a planned destination. Unconfigured policy is explicit; never substitute Session/Crew Folders. One-off instructions do not change saved policies. Git operations and external Provider rule files remain the caller's responsibility under existing user authority.";

export const SESSION_OPERATING_POLICY_DESCRIPTIONS: Record<SessionOperatingPolicyOperation, string> = {
  get_selection_policy: "Read this device's saved selection criteria, execution guidelines and ordered contract routes; policy:null means unset. Read before child creation or execution-option reselection, then validate against the actual catalog. Reading never changes settings or external rules.",
  set_selection_policy: "Register/replace the complete device selection policy, or clear it with policy:null. Only use on the user's explicit request to change persistent configuration; never from a one-off instruction, evaluation or agent suggestion. Do not store API keys or authentication data. Does not change Session defaults, running Turns, catalog availability, permissions or external Provider rule files.",
  get_provider_quota: "Read cached existing Provider quota telemetry without polling or saving policy. Omit provider for all four Providers. telemetry:null means not observed; preserve status, updatedAt, snapshots and rateLimits. An old success with error/loading is not fresh; unsupported/null/empty/unknown must not be interpreted as zero usage, unlimited quota or authorization to spend.",
  get_worktree_policy: "Read the device root and repository-specific category/name/layout; null means unset. Omitted workspacePath uses the bound actor's Workspace. repositoryId is the canonical Git common directory, shared by that repository's Worktrees. Read-only; no Git or configuration changes.",
  set_worktree_root: "Register/replace this device's absolute Worktree root, or clear with rootPath:null. Only on an explicit user request for persistent configuration. Does not create/move/delete directories or Worktrees, and preserves all repository rules.",
  set_worktree_repository: "Register/replace this repository's complete categoryPath/repositoryName/layout rule, or remove it with rule:null. Only on explicit user request for persistent configuration. Omitted workspacePath uses the bound actor's Workspace. Applies across its linked Worktrees, not unrelated clones. Does not change the root or perform Git/filesystem mutations.",
  resolve_worktree: "Read the applicable Worktree destination for a literal branch name. Existing registered Worktrees take precedence and return status:existing/source:git. Otherwise return status:planned from saved policy or an explicit one-off absolute destinationPath, never saving the override. Missing settings return status:unconfigured/missing with no Folder fallback. Planned is not created or guaranteed unoccupied; the caller checks Git/base/Workspace and obtains any required authority before creation. No configuration or Git mutations.",
};
