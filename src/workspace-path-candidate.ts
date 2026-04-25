export type WorkspacePathCandidateKind = "file" | "folder";

export type WorkspacePathCandidate = {
  path: string;
  kind: WorkspacePathCandidateKind;
};

