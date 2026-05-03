import path from "node:path";
import { mkdir } from "node:fs/promises";

import type { MateProfile } from "../src/mate-state.js";
import { upsertMateInstructionBlock } from "./mate-instruction-projection.js";

export type ProviderInstructionTarget = {
  providerId: string;
  filePath: string;
};

export type MateProviderInstructionSyncDeps = {
  readTextFile(filePath: string): Promise<string>;
  writeTextFile(filePath: string, content: string): Promise<void>;
};

export const PROVIDER_INSTRUCTION_FILE_BY_PROVIDER: Readonly<Record<string, string>> = {
  codex: "AGENTS.md",
  copilot: path.join(".github", "copilot-instructions.md"),
};

const PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,63})$/;

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
  const existingText = await readProviderInstructionText(target.filePath, deps.readTextFile);
  const nextText = upsertMateInstructionBlock(existingText, profile);

  const directoryPath = path.dirname(target.filePath);
  if (directoryPath && directoryPath !== "." && directoryPath !== path.sep) {
    await mkdir(directoryPath, { recursive: true });
  }

  await deps.writeTextFile(path.normalize(target.filePath), nextText);
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

function normalizeProviderInstructionProviderId(providerId: string): string {
  const normalizedProviderId = providerId.trim().toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(normalizedProviderId)) {
    throw new Error(`Invalid providerId: ${providerId}`);
  }

  return normalizedProviderId;
}
