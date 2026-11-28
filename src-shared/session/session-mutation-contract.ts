import type { SessionExecutionOptions } from "./session-execution-options.js";
import type { ApprovalMode } from "../settings/approval-mode.js";
import type { SessionApprovalChoice } from "../settings/session-approval-choice.js";

/** Claude の承認モード変更に伴い Reviewer を利用者へ戻す確認。確認時の旧モードを再照合に使う。 */
export type ConfirmedReviewerChange = { previousApprovalMode: ApprovalMode };

/** Main の実行設定を変更する要求。Session ID と incarnation ID を指定し、承認設定を変える場合は選択または確認を添える。 */
export type SetSessionExecutionOptionsRequest = {
  sessionId: string;
  incarnationId: string;
  executionOptions: SessionExecutionOptions;
  confirmedReviewerChange?: ConfirmedReviewerChange;
  approvalChoice?: SessionApprovalChoice;
};

/** 実行設定の選択が受理されたか、より新しい選択に置き換えられたかを示す。受理とチェックポイントへの保存は区別する。 */
export type SetExecutionOptionsResult =
  { status: "accepted"; checkpointSaved: boolean } | { status: "superseded" };

/** ID と incarnation ID で特定した Main のタイトルを差し替える要求。 */
export type SetSessionTitleRequest = {
  sessionId: string;
  incarnationId: string;
  title: string;
};

/** Main の追加ディレクトリ登録の変更。remove は登録解除であり、ファイルの削除を指示しない。 */
export type ChangeSessionAdditionalDirectoryRequest = {
  sessionId: string;
  incarnationId: string;
  operation: "add" | "remove";
  directoryPath: string;
};

/** タイトルの保存確定を返す。キャッシュ更新または通知に失敗した場合は projectionUpdated が false となる。 */
export type SetSessionTitleResult = {
  status: "committed";
  projectionUpdated: boolean;
};

/** Main の保存済みメッセージをインデックスで指定し、ブックマークの有無を設定する要求。 */
export type SetSessionMessageBookmarkRequest = {
  sessionId: string;
  incarnationId: string;
  messageIndex: number;
  isBookmarked: boolean;
};

/** Auxiliary の変更対象を照合するキー。自身の ID に加え、所属する Main の ID と作成日時を使う。 */
export type AuxiliarySessionMutationIdentity = {
  auxiliarySessionId: string;
  parentSessionId: string;
  createdAt: string;
};

/** Auxiliary 自身の実行設定を変更する要求。承認設定を変える場合は選択または確認を添える。 */
export type SetAuxiliaryExecutionOptionsRequest =
  AuxiliarySessionMutationIdentity & {
    executionOptions: SessionExecutionOptions;
    confirmedReviewerChange?: ConfirmedReviewerChange;
    approvalChoice?: SessionApprovalChoice;
  };

/** 所属 Main と作成日時まで一致する Auxiliary のタイトルを差し替える要求。 */
export type SetAuxiliaryTitleRequest = AuxiliarySessionMutationIdentity & {
  title: string;
};

/** 指定した Auxiliary の保存済みメッセージをインデックスで特定し、ブックマークの有無を設定する要求。 */
export type SetAuxiliaryMessageBookmarkRequest =
  AuxiliarySessionMutationIdentity & {
    messageIndex: number;
    isBookmarked: boolean;
  };
