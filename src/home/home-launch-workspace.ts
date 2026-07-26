export type LaunchWorkspace = {
  label: string;
  path: string;
  branch: string;
};

export type LaunchWorkspaceSelection =
  | LaunchWorkspace
  | {
      kind: "session-folder";
    };

export function inferWorkspaceFromPath(selectedPath: string): LaunchWorkspace {
  const normalized = selectedPath.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  const label = segments.at(-1) ?? normalized;

  return {
    label,
    path: selectedPath,
    branch: "",
  };
}

export function isSessionFolderLaunchWorkspace(
  workspace: LaunchWorkspaceSelection | null,
): workspace is { kind: "session-folder" } {
  return !!workspace && "kind" in workspace && workspace.kind === "session-folder";
}

export function resolveLaunchDirectoryWorkspace(
  workspace: LaunchWorkspaceSelection | null,
): LaunchWorkspace | null {
  return workspace && !isSessionFolderLaunchWorkspace(workspace) ? workspace : null;
}
