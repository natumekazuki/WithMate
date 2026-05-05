import { buildProviderInstructionTargetProtectedRoots } from "./provider-instruction-target-root-guard.js";

type ProviderInstructionTargetProtectedRootsWithWorkspaceOptions = {
  workspacePath?: string | null;
  workspacePaths?: readonly (string | null | undefined)[];
  additionalProtectedRoots?: readonly string[];
};

export function buildProviderInstructionTargetProtectedRootsWithWorkspace(
  userDataPath: string,
  options: ProviderInstructionTargetProtectedRootsWithWorkspaceOptions = {},
): string[] {
  const normalizedWorkspacePath = options.workspacePath?.trim();
  const normalizedWorkspacePaths = (options.workspacePaths ?? [])
    .map((workspacePath) => workspacePath?.trim())
    .filter((workspacePath): workspacePath is string => Boolean(workspacePath));
  const additionalProtectedRoots = [
    ...(options.additionalProtectedRoots ?? []),
    ...(normalizedWorkspacePath ? [normalizedWorkspacePath] : []),
    ...normalizedWorkspacePaths,
  ];
  return buildProviderInstructionTargetProtectedRoots(userDataPath, { additionalProtectedRoots });
}
