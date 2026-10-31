export type AppDatabaseCompatibilityMode =
  | "v6"
  | "v4"
  | "legacy-v3"
  | "legacy-v2"
  | "legacy-v1"
  | "unsupported";

export type AppDatabaseFileStatus =
  | "missing"
  | "pending-create"
  | "ready"
  | "invalid"
  | "unsupported";

export type AppDatabaseFileRole = "runtime" | "foundation";

export type AppDatabaseFileDiagnostics = {
  fileName: string;
  path: string;
  exists: boolean;
  role: AppDatabaseFileRole;
  expectedSchemaVersion: number | null;
  userVersion: number | null;
  schemaValid: boolean;
  runtimeEligible: boolean;
  valid: boolean;
  status: AppDatabaseFileStatus;
};

export type AppDatabaseDiagnostics = {
  userDataPath: string;
  userDataPathOverrideApplied: boolean;
  activeDatabasePath: string;
  activeFileName: string;
  compatibilityMode: AppDatabaseCompatibilityMode;
  schemaVersion: number | null;
  userVersion: number | null;
  schemaValid: boolean;
  runtimeCompatible: boolean;
  exists: boolean;
  valid: boolean;
  files: AppDatabaseFileDiagnostics[];
  warnings: string[];
};
