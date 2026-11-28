/** 診断ログの詳しさと重大度を表す、保存形式共通の値。 */
export type AppLogLevel =
  "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** 同じログ形式に出力するMain、Renderer、Preload、Workerの識別値。 */
export type AppLogProcess = "main" | "renderer" | "preload" | "worker";

/** ログに転送・保存できる、例外の名前・メッセージ・スタック。 */
export type AppLogError = {
  name?: string;
  message: string;
  stack?: string;
};

/** 発生日時、記録元と診断内容を持ち、環境や関連要求も添えられる保存行。 */
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

/** ログ記録の入力。発生時刻を渡さなかった場合は記録側で補える。 */
export type AppLogInput = Omit<AppLogEntry, "timestamp"> & {
  timestamp?: string;
};

/** Rendererから渡す診断ログ。時刻やプロセス種別は受け付けず、traceも対象外。 */
export type RendererLogInput = {
  level: Extract<AppLogLevel, "debug" | "info" | "warn" | "error" | "fatal">;
  kind: string;
  message: string;
  correlationId?: string;
  url?: string;
  data?: unknown;
  error?: AppLogError;
};
