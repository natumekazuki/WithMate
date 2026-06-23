export type AppDatabaseCompatibilityMode =
  | "v6-foundation"
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

export type AppDatabaseFileDiagnostics = {
  fileName: string;
  path: string;
  exists: boolean;
  expectedSchemaVersion: number | null;
  userVersion: number | null;
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
  exists: boolean;
  valid: boolean;
  files: AppDatabaseFileDiagnostics[];
  warnings: string[];
};
