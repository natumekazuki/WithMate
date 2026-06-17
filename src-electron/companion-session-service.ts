import path from "node:path";
import { randomUUID } from "node:crypto";

import { currentTimestampLabel } from "../src/time-state.js";
import {
  type CompanionGroup,
  type CompanionSession,
  type CompanionSessionSummary,
  type CreateCompanionSessionInput,
} from "../src/companion-state.js";
import {
  DEFAULT_PROVIDER_ID,
  getProviderCatalog,
  resolveModelSelection,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../src/model-catalog.js";
import { getProviderAppSettings, type AppSettings } from "../src/provider-settings-state.js";
import type { CompanionStorage } from "./companion-storage.js";
import {
  buildCompanionGroupDisplayName,
  cleanupCompanionWorkspaceArtifacts,
  createCompanionWorkspace,
  type CompanionWorkspaceArtifacts,
  resolveCompanionGitEligibility,
} from "./companion-git.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";

export type CompanionSessionServiceDeps = {
  appDataPath: string;
  getAppSettings: () => AppSettings;
  getModelCatalogSnapshot: () => ModelCatalogSnapshot;
  storage: {
    listSessionSummaries(): Awaitable<CompanionSessionSummary[]>;
    listActiveSessionSummaries(): Awaitable<CompanionSessionSummary[]>;
    ensureGroup(group: CompanionGroup): Awaitable<CompanionGroup>;
    createSession(session: CompanionSession): Awaitable<CompanionSession>;
  };
};

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "-");
}

function resolveEnabledProviderCatalog(
  snapshot: ModelCatalogSnapshot,
  appSettings: AppSettings,
  requestedProviderId?: string | null,
): ModelCatalogProvider {
  const requestedProvider = requestedProviderId ? getProviderCatalog(snapshot.providers, requestedProviderId) : null;
  if (requestedProvider && getProviderAppSettings(appSettings, requestedProvider.id).enabled) {
    return requestedProvider;
  }

  const defaultProvider = snapshot.providers.find((provider) => provider.id === DEFAULT_PROVIDER_ID) ?? null;
  if (defaultProvider && getProviderAppSettings(appSettings, defaultProvider.id).enabled) {
    return defaultProvider;
  }

  const firstEnabledProvider = snapshot.providers.find((provider) =>
    getProviderAppSettings(appSettings, provider.id).enabled
  );
  if (firstEnabledProvider) {
    return firstEnabledProvider;
  }

  throw new Error("有効な provider が Settings に見つからないよ。");
}

export class CompanionSessionService {
  constructor(private readonly deps: CompanionSessionServiceDeps) {}

  async listSessionSummaries(): Promise<CompanionSessionSummary[]> {
    return await this.deps.storage.listSessionSummaries();
  }

  async listActiveSessionSummaries(): Promise<CompanionSessionSummary[]> {
    return await this.deps.storage.listActiveSessionSummaries();
  }

  async createSession(input: CreateCompanionSessionInput): Promise<CompanionSession> {
    const taskTitle = input.taskTitle.trim();
    if (!taskTitle) {
      throw new Error("Companion のタイトルを入力してね。");
    }

    const appSettings = this.deps.getAppSettings();
    const snapshot = this.deps.getModelCatalogSnapshot();
    const provider = resolveEnabledProviderCatalog(snapshot, appSettings, input.provider);
    const requestedModel = input.provider && input.provider !== provider.id
      ? provider.defaultModelId
      : input.model ?? provider.defaultModelId;
    const requestedReasoningEffort = input.provider && input.provider !== provider.id
      ? provider.defaultReasoningEffort
      : input.reasoningEffort ?? provider.defaultReasoningEffort;
    const selection = resolveModelSelection(
      provider,
      requestedModel,
      requestedReasoningEffort,
    );

    const eligibility = await resolveCompanionGitEligibility(input.workspacePath);
    if (!eligibility.ok) {
      throw new Error(eligibility.reason);
    }

    const now = currentTimestampLabel();
    const groupId = `companion-group-${randomUUID()}`;
    const sessionId = `companion-session-${randomUUID()}`;
    const safeSessionId = safeId(sessionId);
    const group: CompanionGroup = {
      id: groupId,
      repoRoot: eligibility.repoRoot,
      displayName: buildCompanionGroupDisplayName(eligibility.repoRoot),
      createdAt: now,
      updatedAt: now,
    };
    const storedGroup = await this.deps.storage.ensureGroup(group);
    const worktreePath = path.join(
      this.deps.appDataPath,
      "cw",
      safeSessionId.replace(/^companion-session-/, "cs-"),
    );
    let artifacts: CompanionWorkspaceArtifacts | null = null;
    try {
      artifacts = await createCompanionWorkspace({
        repoRoot: eligibility.repoRoot,
        sessionId,
        safeSessionId,
        companionBranch: `withmate/companion/${safeSessionId}`,
        worktreePath,
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error("Companion worktree の作成に失敗したよ。");
    }

    const session: CompanionSession = {
      id: sessionId,
      groupId: storedGroup.id,
      taskTitle,
      status: "active",
      repoRoot: eligibility.repoRoot,
      focusPath: eligibility.focusPath,
      targetBranch: eligibility.targetBranch,
      baseSnapshotRef: artifacts.baseSnapshotRef,
      baseSnapshotCommit: artifacts.baseSnapshotCommit,
      companionBranch: artifacts.companionBranch,
      worktreePath: artifacts.worktreePath,
      selectedPaths: [],
      changedFiles: [],
      siblingWarnings: [],
      allowedAdditionalDirectories: [],
      runState: "idle",
      threadId: "",
      provider: provider.id,
      catalogRevision: snapshot.revision,
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
      customAgentName: input.customAgentName ?? "",
      approvalMode: input.approvalMode,
      codexSandboxMode: input.codexSandboxMode,
      characterId: input.characterId,
      character: input.character,
      characterRoleMarkdown: input.characterRoleMarkdown,
      characterIconPath: input.characterIconPath,
      characterThemeColors: input.characterThemeColors,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };

    try {
      return await this.deps.storage.createSession(session);
    } catch (error) {
      await cleanupCompanionWorkspaceArtifacts(artifacts);
      throw error;
    }
  }
}
