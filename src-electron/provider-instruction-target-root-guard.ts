import path from "node:path";

import type { ProviderInstructionTargetInput } from "../src/provider-instruction-target-state.js";
import { normalizeDirectoryPath } from "./additional-directories.js";

const PROTECTED_SUB_DIRECTORIES = ["memory-runtime", "mate-talk-runtime", "mate"];

type ProviderInstructionTargetProtectedRootGuardOptions = {
  additionalProtectedRoots?: readonly string[];
};

function isWindowsLongPathDrivePrefix(value: string): boolean {
  return value.startsWith("\\\\?\\") && /^[A-Za-z]:[\\/]/.test(value.slice(4))
    || value.startsWith("//?/") && /^[A-Za-z]:[\\/]/.test(value.slice(4));
}

function stripWindowsLongPathDrivePrefix(value: string): string {
  if (isWindowsLongPathDrivePrefix(value)) {
    return value.slice(4);
  }
  return value;
}

function isWindowsStylePath(value: string): boolean {
  if (value.startsWith("\\\\") || value.startsWith("//?")) {
    return true;
  }
  return /^[A-Za-z]:[\\/]/.test(value);
}

function normalizeForComparison(value: string): string {
  const pathModule = isWindowsStylePath(value) ? path.win32 : path;
  const normalized = pathModule.resolve(stripWindowsLongPathDrivePrefix(value)).replace(/[\\/]+$/, "");
  return pathModule === path.win32 ? normalized.toLowerCase() : normalized;
}

function isPathWithinDirectoryPortable(targetPath: string, directoryPath: string): boolean {
  const comparablePath = normalizeForComparison(targetPath);
  const comparableDirectoryPath = normalizeForComparison(directoryPath);
  const pathModule = isWindowsStylePath(targetPath) || isWindowsStylePath(directoryPath) ? path.win32 : path;
  const relativePath = pathModule.relative(comparableDirectoryPath, comparablePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !pathModule.isAbsolute(relativePath));
}

function isAbsolutePath(value: string): boolean {
  const normalized = stripWindowsLongPathDrivePrefix(value);
  if (isWindowsStylePath(normalized)) {
    return path.win32.isAbsolute(normalized);
  }
  return path.isAbsolute(normalized);
}

export function buildProviderInstructionTargetProtectedRoots(
  userDataPath: string,
  options: ProviderInstructionTargetProtectedRootGuardOptions = {},
): string[] {
  const normalizedUserDataPath = normalizeDirectoryPath(stripWindowsLongPathDrivePrefix(userDataPath));
  const protectedRoots = [
    normalizedUserDataPath,
    ...PROTECTED_SUB_DIRECTORIES.map((directory) => normalizeDirectoryPath(path.join(normalizedUserDataPath, directory))),
    ...(options.additionalProtectedRoots ?? []).map((root) => normalizeDirectoryPath(stripWindowsLongPathDrivePrefix(root))),
  ];

  const normalizedToRepresentative = new Map<string, string>();
  for (const protectedRoot of protectedRoots) {
    const candidate = normalizeDirectoryPath(stripWindowsLongPathDrivePrefix(protectedRoot));
    const comparablePath = normalizeForComparison(candidate);
    if (!normalizedToRepresentative.has(comparablePath)) {
      normalizedToRepresentative.set(comparablePath, candidate);
    }
  }

  return [...normalizedToRepresentative.values()];
}

export function assertProviderInstructionTargetRootNotProtected(
  input: ProviderInstructionTargetInput,
  protectedRoots: readonly string[],
  resolvedInstructionFilePath?: string,
): void {
  const normalizedRootDirectory = typeof input.rootDirectory === "string" ? input.rootDirectory.trim() : "";
  if (!normalizedRootDirectory || !isAbsolutePath(normalizedRootDirectory)) {
    return;
  }

  const normalizedInstructionFilePath = resolvedInstructionFilePath?.trim() ??
    (input.instructionRelativePath
      ? path.resolve(normalizedRootDirectory, path.normalize(input.instructionRelativePath))
      : "");

  for (const protectedRoot of protectedRoots) {
    if (isPathWithinDirectoryPortable(normalizedRootDirectory, protectedRoot)) {
      throw new Error(`rootDirectory が保護ディレクトリ配下（${protectedRoot}）に設定されているため登録できません。`);
    }

    if (normalizedInstructionFilePath && isPathWithinDirectoryPortable(normalizedInstructionFilePath, protectedRoot)) {
      throw new Error(`instruction file path が保護ディレクトリ配下（${protectedRoot}）に設定されているため登録できません。`);
    }
  }
}
