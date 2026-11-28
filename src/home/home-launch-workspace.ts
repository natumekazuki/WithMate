/** 新規 Session のワークスペースに採用する既存ディレクトリと、画面用の名前・ブランチ。 */
export type LaunchWorkspace = {
  label: string;
  path: string;
  branch: string;
};

/** 既存ディレクトリの指定と、専用 Session Folder を使う指定を区別する。 */
export type LaunchWorkspaceSelection =
  | LaunchWorkspace
  | {
      kind: "session-folder";
    };

/** パスの最後の区間を表示名とし、入力パスを保持する。ブランチはこの段階では確定しない。 */
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

/** 専用 Session Folder を使う明示的な選択だけを識別する。 */
export function isSessionFolderLaunchWorkspace(
  workspace: LaunchWorkspaceSelection | null,
): workspace is { kind: "session-folder" } {
  return (
    !!workspace && "kind" in workspace && workspace.kind === "session-folder"
  );
}

/** 入力の検証に使う既存ディレクトリだけを返し、専用フォルダーや未選択は除く。 */
export function resolveLaunchDirectoryWorkspace(
  workspace: LaunchWorkspaceSelection | null,
): LaunchWorkspace | null {
  return workspace && !isSessionFolderLaunchWorkspace(workspace)
    ? workspace
    : null;
}
