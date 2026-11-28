import type {
  WorkspaceDirectoryValidationFailureReason,
  WorkspaceDirectoryValidationResult,
} from "../../../src-shared/window/workspace-directory-validation.js";

/** 対象セッション・パスと照合できるワークスペースの確認状態。 */
export type SessionWorkspaceAvailabilityState =
  | { status: "idle" }
  | {
      status: "checking";
      sessionId: string;
      workspacePath: string;
      requestId: number;
    }
  | {
      status: "available";
      sessionId: string;
      workspacePath: string;
    }
  | {
      status: "unavailable";
      sessionId: string;
      workspacePath: string;
      reason: WorkspaceDirectoryValidationFailureReason;
    };

/** まだ対象のワークスペースを確認していない初期状態。 */
export const INITIAL_SESSION_WORKSPACE_AVAILABILITY: SessionWorkspaceAvailabilityState =
  {
    status: "idle",
  };

/** 後から応答を照合できるよう、確認するセッション・パスと要求IDを記録する。 */
export function beginSessionWorkspaceAvailabilityCheck(
  sessionId: string,
  workspacePath: string,
  requestId: number,
): SessionWorkspaceAvailabilityState {
  return { status: "checking", sessionId, workspacePath, requestId };
}

/** 現在確認中のセッション・パス・要求IDが一致する場合だけ検証結果を反映する。 */
export function applySessionWorkspaceAvailabilityResult(
  current: SessionWorkspaceAvailabilityState,
  sessionId: string,
  workspacePath: string,
  requestId: number,
  result: WorkspaceDirectoryValidationResult,
): SessionWorkspaceAvailabilityState {
  if (
    current.status !== "checking" ||
    current.sessionId !== sessionId ||
    current.workspacePath !== workspacePath ||
    current.requestId !== requestId
  ) {
    return current;
  }

  return result.valid
    ? { status: "available", sessionId, workspacePath }
    : {
        status: "unavailable",
        sessionId,
        workspacePath,
        reason: result.reason,
      };
}

/** 同じセッションとパスの組み合わせに利用可能と確認した結果があるかを返す。 */
export function isSessionWorkspaceAvailable(
  state: SessionWorkspaceAvailabilityState,
  sessionId: string,
  workspacePath: string,
): boolean {
  return (
    state.status === "available" &&
    state.sessionId === sessionId &&
    state.workspacePath === workspacePath
  );
}

/** 指定のセッションとパスで利用不可が確定した場合だけ、実行を阻む理由を返す。 */
export function resolveSessionWorkspaceBlockedReason(
  state: SessionWorkspaceAvailabilityState,
  sessionId: string,
  workspacePath: string,
): string {
  if (isSessionWorkspaceAvailable(state, sessionId, workspacePath)) {
    return "";
  }
  if (
    state.status === "unavailable" &&
    state.sessionId === sessionId &&
    state.workspacePath === workspacePath
  ) {
    return resolveSessionWorkspaceUnavailableMessage(
      state,
      sessionId,
      workspacePath,
    );
  }
  return "";
}

/** 未確認・確認中と、利用不可が確定した場合の理由を分けた実行可否の情報。 */
export type SessionWorkspaceExecutionGate = {
  isPending: boolean;
  blockedReason: string;
};

/** 対象の確認待ちと利用不可を区別し、待機中には確定した失敗理由を出さない。 */
export function resolveSessionWorkspaceExecutionGate(
  state: SessionWorkspaceAvailabilityState,
  sessionId: string,
  workspacePath: string,
): SessionWorkspaceExecutionGate {
  const isUnavailable =
    state.status === "unavailable" &&
    state.sessionId === sessionId &&
    state.workspacePath === workspacePath;
  const isPending =
    !isSessionWorkspaceAvailable(state, sessionId, workspacePath) &&
    !isUnavailable;

  return {
    isPending,
    blockedReason: isPending
      ? ""
      : resolveSessionWorkspaceBlockedReason(state, sessionId, workspacePath),
  };
}

/** 指定対象に対応する確認失敗を、パスと再確認の案内を含む文に変換する。 */
export function resolveSessionWorkspaceUnavailableMessage(
  state: SessionWorkspaceAvailabilityState,
  sessionId: string,
  workspacePath: string,
): string {
  if (
    state.status !== "unavailable" ||
    state.sessionId !== sessionId ||
    state.workspacePath !== workspacePath
  ) {
    return "";
  }

  switch (state.reason) {
    case "missing":
      return `Workspace not found: ${workspacePath}. Restore it, then recheck.`;
    case "not-directory":
      return `Workspace is not a directory: ${workspacePath}. Restore it, then recheck.`;
    case "empty":
    case "not-absolute":
    case "unavailable":
      return `Workspace unavailable: ${workspacePath}. Restore access, then recheck.`;
  }
}
