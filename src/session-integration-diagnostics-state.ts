export type SessionSkillSyncDiagnostics = {
  status:
    | "installed"
    | "updated"
    | "unchanged"
    | "skipped-unpackaged"
    | "skipped-unsupported-platform"
    | "skipped-unconfigured"
    | "skipped-collision"
    | "failed"
    | "not-run";
  skillPath: string | null;
  errorMessage?: string;
};

export type SessionCliLauncherDiagnostics = {
  status:
    | "installed"
    | "not-installed"
    | "collision"
    | "skipped-unpackaged"
    | "skipped-unsupported-platform"
    | "failed";
  command: "withmate-session";
  resolvedPath: string | null;
  expectedPath: string | null;
  errorMessage?: string;
};

export type CodexSessionMcpRegistrationStatus =
  | "installed"
  | "unchanged"
  | "not-installed"
  | "collision"
  | "skipped-unpackaged"
  | "skipped-unsupported-platform"
  | "failed";

export type CodexSessionMcpRegistrationDiagnostics = {
  status: CodexSessionMcpRegistrationStatus;
  name: "withmate-session";
  command: string;
  args: ["mcp-server"];
  errorMessage?: string;
};

export type SessionIntegrationDiagnostics = {
  generatedAt: string;
  skillSync: SessionSkillSyncDiagnostics;
  launcher: SessionCliLauncherDiagnostics;
  codexMcp: CodexSessionMcpRegistrationDiagnostics;
};
