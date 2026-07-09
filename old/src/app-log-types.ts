export type AppLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type AppLogProcess = "main" | "renderer" | "preload" | "worker";

export type AppLogError = {
  name?: string;
  message: string;
  stack?: string;
};

export type AppLogEntry = {
  timestamp: string;
  level: AppLogLevel;
  kind: string;
  process: AppLogProcess;
  message: string;
  appVersion?: string;
  electronVersion?: string;
  chromeVersion?: string;
  nodeVersion?: string;
  platform?: string;
  arch?: string;
  isPackaged?: boolean;
  windowId?: number;
  requestId?: string;
  correlationId?: string;
  data?: unknown;
  error?: AppLogError;
};

export type AppLogInput = Omit<AppLogEntry, "timestamp"> & {
  timestamp?: string;
};

export type RendererLogInput = {
  level: Extract<AppLogLevel, "debug" | "info" | "warn" | "error" | "fatal">;
  kind: string;
  message: string;
  url?: string;
  data?: unknown;
  error?: AppLogError;
};

