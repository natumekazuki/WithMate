/** 起動処理が進行中か、完了または失敗で終わったかを区別する。 */
export type AppBootStatusKind = "running" | "completed" | "failed";

/** 起動画面に伝える現在の処理段階。DBと診断、作業ツリーの整理、画面準備を区別する。 */
export type AppBootStage =
  | "starting"
  | "database"
  | "diagnostics"
  | "workspace-cleanup"
  | "stores"
  | "home"
  | "failed";

/** 起動の状態と段階、表示文言、記録できる場合の失敗情報。 */
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
