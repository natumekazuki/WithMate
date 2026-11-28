/** Crewの削除を止めている実行・待ち行列・作成・相談と、その説明。 */
export type CrewDeletionBlocker = {
  kind: "running" | "queue" | "creation" | "coordination";
  id: string;
  sessionId?: string;
  message: string;
};
/** 現時点の削除可否と、不可の場合に解消が必要な阻害要因。 */
export type CrewDeletionStatus = {
  allowed: boolean;
  blockers: CrewDeletionBlocker[];
};
