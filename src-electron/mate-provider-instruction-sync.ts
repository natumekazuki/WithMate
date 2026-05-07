import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";

import type { MateProfile } from "../src/mate-state.js";
import type { ProviderInstructionTarget as ProviderInstructionTargetState } from "../src/provider-instruction-target-state.js";
import {
  MATE_PROFILE_BLOCK_ID,
  MATE_PROFILE_BLOCK_TITLE,
  buildMateInstructionContent,
} from "./mate-instruction-projection.js";
import { ProviderInstructionTargetStorage } from "./provider-instruction-target-storage.js";
import {
  buildManagedBlock,
  hasManagedBlockWithMarkerAttributes,
  removeManagedBlockWithMarkerAttributes,
  upsertManagedBlockWithMarkerAttributes,
} from "./managed-instruction-block.js";
import {
  assertProviderInstructionTargetRootNotProtected,
  buildProviderInstructionTargetProtectedRoots,
} from "./provider-instruction-target-root-guard.js";

export type ProviderInstructionTarget = {
  providerId: string;
  filePath: string;
  targetId?: string;
  writeMode?: ProviderInstructionTargetState["writeMode"];
};

export type MateProviderInstructionSyncDeps = {
  readTextFile(filePath: string): Promise<string>;
  writeTextFile(filePath: string, content: string): Promise<void>;
};

export type ProviderInstructionSyncOptions = {
  protectedRoots?: readonly string[];
};

export type SyncEnabledProviderInstructionTargetsResult = {
  targetCount: number;
  syncedCount: number;
  failedCount: number;
  skippedCount: number;
  runIds: number[];
};

export const PROVIDER_INSTRUCTION_FILE_BY_PROVIDER: Readonly<Record<string, string>> = {
  codex: "AGENTS.md",
  copilot: path.join(".github", "copilot-instructions.md"),
};

const PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,63})$/;

export class MateProviderInstructionSyncBlockedError extends Error {
  public readonly providerId: string;
  public readonly targetId: string;
  public readonly errorPreview: string;

  constructor(input: { providerId: string; targetId: string; errorPreview: string }) {
    super(`providerId=${input.providerId}, targetId=${input.targetId}, errorPreview=${input.errorPreview}`);
    this.name = "MateProviderInstructionSyncBlockedError";
    this.providerId = input.providerId;
    this.targetId = input.targetId;
    this.errorPreview = input.errorPreview;
  }
}

export function resolveProviderInstructionFilePath(providerId: string): string {
  const normalizedProviderId = normalizeProviderInstructionProviderId(providerId);
  return PROVIDER_INSTRUCTION_FILE_BY_PROVIDER[normalizedProviderId] ??
    path.join(".github", `${normalizedProviderId}-instructions.md`);
}

export function createDefaultProviderInstructionTargets(
  workspacePath: string,
  providerIds: readonly string[],
): ProviderInstructionTarget[] {
  return providerIds.map((providerId) => {
    const normalizedProviderId = normalizeProviderInstructionProviderId(providerId);
    return {
      providerId: normalizedProviderId,
      filePath: path.join(workspacePath, resolveProviderInstructionFilePath(normalizedProviderId)),
    };
  });
}

export async function syncMateInstructionFile(
  target: ProviderInstructionTarget,
  profile: MateProfile,
  deps: MateProviderInstructionSyncDeps,
): Promise<void> {
  const normalizedFilePath = path.normalize(target.filePath);
  const writeMode = target.writeMode ?? "managed_block";

  if (writeMode === "managed_file") {
    const markerAttributes = buildManagedBlockMarkerAttributes({
      providerId: target.providerId,
      targetId: target.targetId,
      writeMode: "managed_file",
    });
    const existingText = await readExistingProviderInstructionText(normalizedFilePath, deps.readTextFile);

    if (
      existingText !== null
      && !hasManagedBlockWithMarkerAttributes(existingText, {
        blockId: MATE_PROFILE_BLOCK_ID,
        markerAttributes,
      })
    ) {
      throw new Error(`marker mismatch: managed_file marker が一致しません: providerId=${target.providerId}, targetId=${target.targetId ?? "main"}`);
    }

    const nextText = buildManagedBlock({
      blockId: MATE_PROFILE_BLOCK_ID,
      title: MATE_PROFILE_BLOCK_TITLE,
      content: buildMateInstructionContent(profile),
      markerAttributes,
    });

    const directoryPath = path.dirname(normalizedFilePath);
    if (directoryPath && directoryPath !== "." && directoryPath !== path.sep) {
      await mkdir(directoryPath, { recursive: true });
    }

    await deps.writeTextFile(normalizedFilePath, nextText);
    return;
  }

  if (writeMode !== "managed_block") {
    throw new Error(`unsupported writeMode: ${writeMode}`);
  }

  const existingText = await readProviderInstructionText(normalizedFilePath, deps.readTextFile);
  const nextText = upsertManagedBlockWithMarkerAttributes(existingText, {
    blockId: MATE_PROFILE_BLOCK_ID,
    title: MATE_PROFILE_BLOCK_TITLE,
    content: buildMateInstructionContent(profile),
    markerAttributes: buildManagedBlockMarkerAttributes(target),
  });

  const directoryPath = path.dirname(normalizedFilePath);
  if (directoryPath && directoryPath !== "." && directoryPath !== path.sep) {
    await mkdir(directoryPath, { recursive: true });
  }

  await deps.writeTextFile(normalizedFilePath, nextText);
}

export async function syncMateInstructionFiles(
  targets: readonly ProviderInstructionTarget[],
  profile: MateProfile,
  deps: MateProviderInstructionSyncDeps,
): Promise<void> {
  for (const target of targets) {
    await syncMateInstructionFile(target, profile, deps);
  }
}

export async function syncEnabledProviderInstructionTargets(
  storage: ProviderInstructionTargetStorage,
  profile: MateProfile,
  deps: MateProviderInstructionSyncDeps,
  syncOptions: ProviderInstructionSyncOptions = {},
): Promise<SyncEnabledProviderInstructionTargetsResult> {
  const result: SyncEnabledProviderInstructionTargetsResult = {
    targetCount: 0,
    syncedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    runIds: [],
  };

  const targets = storage.listTargets({ enabledOnly: true });
  const mateRevisionId = profile.activeRevisionId ?? undefined;
  const protectedRoots = await resolveProviderInstructionTargetProtectedRoots(syncOptions);

  for (const target of targets) {
    result.targetCount += 1;

    if (target.lastSyncState === "redaction_required") {
      result.skippedCount += 1;
      continue;
    }

    try {
      const instructionFilePath = resolveTargetInstructionFilePath(target);
      assertProviderInstructionTargetRootNotProtected(target, protectedRoots, instructionFilePath);

      await syncMateInstructionFile(
        {
          providerId: target.providerId,
          targetId: target.targetId,
          writeMode: target.writeMode,
          filePath: instructionFilePath,
        },
        profile,
        deps,
      );

      const syncedText = await deps.readTextFile(instructionFilePath);
      const run = storage.recordSyncRun({
        providerId: target.providerId,
        targetId: target.targetId,
        mateRevisionId,
        writeMode: target.writeMode,
        projectionScope: target.projectionScope,
        projectionSha256: sha256Hex(syncedText),
        status: "synced",
        requiresRestart: target.requiresRestart,
      });
      result.syncedCount += 1;
      result.runIds.push(run.id);
      continue;
    } catch (error) {
      const errorPreview = errorToMessage(error);
      const run = storage.recordSyncRun({
        providerId: target.providerId,
        targetId: target.targetId,
        mateRevisionId,
        writeMode: target.writeMode,
        projectionScope: target.projectionScope,
        projectionSha256: "not-applicable",
        status: "failed",
        errorPreview,
        requiresRestart: target.requiresRestart,
      });
      result.failedCount += 1;
      result.runIds.push(run.id);

      if (target.failPolicy === "block_session") {
        throw new MateProviderInstructionSyncBlockedError({
          providerId: target.providerId,
          targetId: target.targetId,
          errorPreview,
        });
      }
    }
  }

  return result;
}

export async function syncDisabledProviderInstructionTargets(
  storage: ProviderInstructionTargetStorage,
  deps: MateProviderInstructionSyncDeps,
  syncOptions: ProviderInstructionSyncOptions = {},
  options: { targets?: readonly ProviderInstructionTargetState[] } = {},
): Promise<SyncEnabledProviderInstructionTargetsResult> {
  const result: SyncEnabledProviderInstructionTargetsResult = {
    targetCount: 0,
    syncedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    runIds: [],
  };

  const targets = options.targets ?? storage.listTargets({ enabledOnly: true });
  const protectedRoots = await resolveProviderInstructionTargetProtectedRoots(syncOptions);

  for (const target of targets) {
    result.targetCount += 1;

    if (target.lastSyncState === "redaction_required") {
      result.skippedCount += 1;
      continue;
    }

    try {
      const instructionFilePath = resolveTargetInstructionFilePath(target);
      assertProviderInstructionTargetRootNotProtected(target, protectedRoots, instructionFilePath);

      const syncResult = await syncDisabledProviderInstructionTargetProjection({
        ...target,
        filePath: instructionFilePath,
      }, deps);

      if (syncResult.status === "skipped") {
        const run = storage.recordSyncRun({
          providerId: target.providerId,
          targetId: target.targetId,
          mateRevisionId: undefined,
          writeMode: target.writeMode,
          projectionScope: target.projectionScope,
          projectionSha256: "not-applicable",
          status: "skipped",
          requiresRestart: target.requiresRestart,
        });

        result.skippedCount += 1;
        result.runIds.push(run.id);
        continue;
      }

      const run = storage.recordSyncRun({
        providerId: target.providerId,
        targetId: target.targetId,
        mateRevisionId: undefined,
        writeMode: target.writeMode,
        projectionScope: target.projectionScope,
        projectionSha256: sha256Hex(syncResult.text),
        status: "synced",
        requiresRestart: target.requiresRestart,
      });

      result.syncedCount += 1;
      result.runIds.push(run.id);
    } catch (error) {
      const errorPreview = errorToMessage(error);
      const run = storage.recordSyncRun({
        providerId: target.providerId,
        targetId: target.targetId,
        mateRevisionId: undefined,
        writeMode: target.writeMode,
        projectionScope: target.projectionScope,
        projectionSha256: "not-applicable",
        status: "failed",
        errorPreview,
        requiresRestart: target.requiresRestart,
      });
      result.failedCount += 1;
      result.runIds.push(run.id);

      if (target.failPolicy === "block_session") {
        throw new MateProviderInstructionSyncBlockedError({
          providerId: target.providerId,
          targetId: target.targetId,
          errorPreview,
        });
      }
    }
  }

  return result;
}

export async function syncDisabledProviderInstructionTarget(
  storage: ProviderInstructionTargetStorage,
  target: ProviderInstructionTargetState,
  deps: MateProviderInstructionSyncDeps,
  syncOptions: ProviderInstructionSyncOptions = {},
): Promise<SyncEnabledProviderInstructionTargetsResult> {
  return syncDisabledProviderInstructionTargets(storage, deps, syncOptions, {
    targets: [target],
  });
}

async function readProviderInstructionText(
  filePath: string,
  readTextFile: (filePath: string) => Promise<string>,
): Promise<string> {
  try {
    return await readTextFile(filePath);
  } catch (error) {
    const errnoError = error as NodeJS.ErrnoException | undefined;
    if (errnoError?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function readExistingProviderInstructionText(
  filePath: string,
  readTextFile: (filePath: string) => Promise<string>,
): Promise<string | null> {
  try {
    return await readTextFile(filePath);
  } catch (error) {
    const errnoError = error as NodeJS.ErrnoException | undefined;
    if (errnoError?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function syncDisabledProviderInstructionTargetProjection(
  target: {
    providerId: string;
    targetId?: string;
    writeMode: ProviderInstructionTargetState["writeMode"];
    filePath: string;
    requiresRestart: boolean;
  },
  deps: MateProviderInstructionSyncDeps,
): Promise<{ status: "synced"; text: string } | { status: "skipped" }> {
  const normalizedFilePath = path.normalize(target.filePath);
  const existingText = await readExistingProviderInstructionText(normalizedFilePath, deps.readTextFile);
  if (existingText === null) {
    return { status: "skipped" };
  }

  if (target.writeMode === "managed_block") {
    const nextText = removeManagedBlockWithMarkerAttributes(existingText, {
      blockId: MATE_PROFILE_BLOCK_ID,
      markerAttributes: buildManagedBlockMarkerAttributes(target),
    });
    if (nextText === existingText) {
      return { status: "skipped" };
    }
    await deps.writeTextFile(normalizedFilePath, nextText);
    return { status: "synced", text: nextText };
  }

  if (target.writeMode === "managed_file") {
    return { status: "skipped" };
  }

  throw new Error(`unsupported writeMode: ${target.writeMode}`);
}

function normalizeProviderInstructionProviderId(providerId: string): string {
  const normalizedProviderId = providerId.trim().toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(normalizedProviderId)) {
    throw new Error(`Invalid providerId: ${providerId}`);
  }

  return normalizedProviderId;
}

function buildManagedBlockMarkerAttributes(
  target: Pick<ProviderInstructionTarget, "providerId" | "targetId" | "writeMode">,
): { provider: string; target: string; mode: string } {
  return {
    provider: target.providerId,
    target: target.targetId ?? "main",
    mode: (target.writeMode ?? "managed_block") === "managed_block" ? "managed-block" : "managed-file",
  };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const SYNC_PROTECTED_ROOTS_CACHE: { value?: readonly string[] } = {};

async function resolveProviderInstructionTargetProtectedRoots(
  syncOptions: ProviderInstructionSyncOptions,
): Promise<readonly string[]> {
  if (syncOptions.protectedRoots !== undefined) {
    return syncOptions.protectedRoots;
  }

  if (SYNC_PROTECTED_ROOTS_CACHE.value !== undefined) {
    return SYNC_PROTECTED_ROOTS_CACHE.value;
  }

  if (!process.versions.electron) {
    SYNC_PROTECTED_ROOTS_CACHE.value = [];
    return [];
  }

  try {
    const { app } = await import("electron");
    SYNC_PROTECTED_ROOTS_CACHE.value = buildProviderInstructionTargetProtectedRoots(app.getPath("userData"));
    return SYNC_PROTECTED_ROOTS_CACHE.value;
  } catch {
    SYNC_PROTECTED_ROOTS_CACHE.value = [];
    return [];
  }
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function resolveTargetInstructionFilePath(target: ProviderInstructionTargetState): string {
  if (!target.rootDirectory) {
    throw new Error("rootDirectory が空です");
  }

  if (!path.isAbsolute(target.rootDirectory)) {
    throw new Error("rootDirectory は絶対パスを指定してください");
  }

  const normalizedRelativePath = path.normalize(target.instructionRelativePath);
  if (path.isAbsolute(normalizedRelativePath)) {
    throw new Error("instructionRelativePath は相対パスを指定してください");
  }

  const rootDirectory = path.resolve(target.rootDirectory);
  const instructionFilePath = path.resolve(rootDirectory, normalizedRelativePath);
  const relativePath = path.relative(rootDirectory, instructionFilePath);

  if (!relativePath || relativePath === "." || /^\.\.([/\\]|$)/.test(relativePath)) {
    throw new Error("instructionRelativePath が不正です");
  }

  return instructionFilePath;
}
