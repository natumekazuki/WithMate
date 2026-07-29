import path from "node:path";
import { randomUUID } from "node:crypto";

import { currentTimestampLabel } from "../src/time-state.js";
import {
  type CompanionGroup,
  type CompanionSession,
  type CompanionSessionSummary,
  type CreateCompanionSessionInput,
} from "../src/companion-state.js";
import type { CharacterRuntimeSnapshot } from "../src/character/character-catalog.js";
import {
  buildCompanionGroupDisplayName,
  cleanupCompanionWorkspaceArtifacts,
  createCompanionWorkspace,
  type CompanionWorkspaceArtifacts,
  resolveCompanionGitEligibility,
} from "./companion-git.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";
import type { SessionLaunchSelection } from "./session-launch-selection-service.js";
import type { RunProviderRuntimeOperationExclusive } from "./provider-runtime-operation-coordinator.js";

export type CompanionSessionServiceDeps = {
  appDataPath: string;
  runProviderRuntimeOperationExclusive: RunProviderRuntimeOperationExclusive;
  resolveSessionLaunchSelection(providerId?: string | null): Promise<SessionLaunchSelection>;
  getStorage(): {
    listSessionSummaries(): Awaitable<CompanionSessionSummary[]>;
    listActiveSessionSummaries(): Awaitable<CompanionSessionSummary[]>;
    ensureGroup(group: CompanionGroup): Awaitable<CompanionGroup>;
    createSession(session: CompanionSession): Awaitable<CompanionSession>;
  };
  createCharacterRuntimeSnapshot?(characterId: string): CharacterRuntimeSnapshot | null;
};

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "-");
}

export class CompanionSessionService {
  constructor(private readonly deps: CompanionSessionServiceDeps) {}

  async listSessionSummaries(): Promise<CompanionSessionSummary[]> {
    return await this.deps.getStorage().listSessionSummaries();
  }

  async listActiveSessionSummaries(): Promise<CompanionSessionSummary[]> {
    return await this.deps.getStorage().listActiveSessionSummaries();
  }

  async createSession(input: CreateCompanionSessionInput): Promise<CompanionSession> {
    return this.deps.runProviderRuntimeOperationExclusive(
      () => this.createSessionExclusive(input),
    );
  }

  private async createSessionExclusive(input: CreateCompanionSessionInput): Promise<CompanionSession> {
    const taskTitle = input.taskTitle.trim();
    if (!taskTitle) {
      throw new Error("Companion のタイトルを入力してね。");
    }

    const storage = this.deps.getStorage();
    const launchSelection = await this.deps.resolveSessionLaunchSelection(input.provider);

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
    const storedGroup = await storage.ensureGroup(group);
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
      provider: launchSelection.provider,
      catalogRevision: launchSelection.catalogRevision,
      model: launchSelection.model,
      reasoningEffort: launchSelection.reasoningEffort,
      customAgentName: launchSelection.customAgentName,
      approvalMode: launchSelection.approvalMode,
      codexSandboxMode: launchSelection.codexSandboxMode,
      characterId: input.characterId,
      character: input.character,
      characterRoleMarkdown: input.characterRoleMarkdown,
      characterIconPath: input.characterIconPath,
      characterThemeColors: input.characterThemeColors,
      characterRuntimeSnapshot:
        input.characterRuntimeSnapshot ?? this.deps.createCharacterRuntimeSnapshot?.(input.characterId) ?? null,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };

    try {
      return await storage.createSession(session);
    } catch (error) {
      await cleanupCompanionWorkspaceArtifacts(artifacts);
      throw error;
    }
  }
}
