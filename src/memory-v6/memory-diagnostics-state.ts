export type MemoryV6RuntimeDiagnostics = {
  status: "running" | "stopped" | "failed";
  baseUrl: string | null;
  dbPath: string | null;
  discoveryFilePath: string | null;
  hasApiSecret: boolean;
};

export type MemoryV6BindingDiagnostics = {
  activeBindingCount: number;
};

export type MemoryV6ProviderBindingDiagnostics = {
  providerId: string;
  providerSupported: boolean;
  memoryBindingTransport: "env" | "context_file" | "unsupported";
};

export type MemoryV6SkillSyncDiagnostics = {
  providerId: string;
  skillRootConfigured: boolean;
  skillPath: string | null;
  status:
    | "installed"
    | "updated"
    | "unchanged"
    | "skipped-unconfigured"
    | "skipped-collision"
    | "failed"
    | "not-run";
  errorMessage?: string;
};

export type MemoryV6DiagnosticEvent = {
  kind: string;
  message: string;
  occurredAt: string;
};

export type MemoryV6Diagnostics = {
  generatedAt: string;
  runtime: MemoryV6RuntimeDiagnostics;
  binding: MemoryV6BindingDiagnostics;
  providers: MemoryV6ProviderBindingDiagnostics[];
  skillSync: MemoryV6SkillSyncDiagnostics[];
  lastErrors: MemoryV6DiagnosticEvent[];
};
