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

export type ManagedMcpLauncherDiagnostics = {
  status:
    | "installed"
    | "not-installed"
    | "collision"
    | "skipped-unpackaged"
    | "skipped-unsupported-platform"
    | "failed";
  command: "withmate-session" | "withmate-glossary";
  resolvedPath: string | null;
  expectedPath: string | null;
  errorMessage?: string;
};

export type SessionCliLauncherDiagnostics = ManagedMcpLauncherDiagnostics & {
  command: "withmate-session";
};

export type CodexSessionMcpRegistrationStatus =
  | "installed"
  | "unchanged"
  | "not-installed"
  | "collision"
  | "skipped-unpackaged"
  | "skipped-unsupported-platform"
  | "failed";

export type CodexManagedMcpRegistrationDiagnostics = {
  status: CodexSessionMcpRegistrationStatus;
  name: "withmate-session" | "withmate-glossary";
  command: string;
  args: ["mcp-server"];
  errorMessage?: string;
};

export type CodexSessionMcpRegistrationDiagnostics = CodexManagedMcpRegistrationDiagnostics & {
  name: "withmate-session";
};

export type SessionIntegrationDiagnostics = {
  generatedAt: string;
  skillSync: SessionSkillSyncDiagnostics;
  launcher: SessionCliLauncherDiagnostics;
  codexMcp: CodexSessionMcpRegistrationDiagnostics;
  glossarySkillSync: SessionSkillSyncDiagnostics;
  glossaryLauncher: ManagedMcpLauncherDiagnostics & { command: "withmate-glossary" };
  codexGlossaryMcp: CodexManagedMcpRegistrationDiagnostics & { name: "withmate-glossary" };
};
