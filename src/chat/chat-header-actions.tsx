export type WorkspaceExplorerActionOptions = {
  disabled?: boolean;
  onOpenExplorer: () => void;
};

export function createWorkspaceExplorerAction({
  disabled = false,
  onOpenExplorer,
}: WorkspaceExplorerActionOptions) {
  return (
    <button
      className="drawer-toggle compact secondary"
      type="button"
      disabled={disabled}
      onClick={onOpenExplorer}
    >
      Explorer
    </button>
  );
}
