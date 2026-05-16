export type AppBootStatusKind = "running" | "completed" | "failed";

export type AppBootStage =
  | "starting"
  | "database"
  | "diagnostics"
  | "workspace-cleanup"
  | "stores"
  | "home"
  | "failed";

export type AppBootStatus = {
  kind: AppBootStatusKind;
  stage: AppBootStage;
  title: string;
  detail?: string;
  error?: {
    name?: string;
    message: string;
    stack?: string;
  };
};
