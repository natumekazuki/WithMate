import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEventHandler,
  type ReactNode,
} from "react";

import type { Session } from "../../../src-shared/session/session-state.js";
import { getSessionIncarnationId } from "../../../src-shared/session/session-state.js";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import {
  createCancelTitleEditHandler,
  createStartTitleEditHandler,
} from "../session-shell-handlers.js";
import type { SessionHeaderProps } from "./session-header.js";
import { buildLiveSessionHeaderProps } from "../chat-header-actions.js";
import { CrewDeletionDialog } from "../../coordination/CrewDeletionDialog.js";
import { SessionRoleChangeDialog } from "./session-role-change-dialog.js";

/** タイトル編集と削除の操作、および選択セッションに対応するヘッダーの組み立て口。 */
export type SessionHeaderOperations = {
  titleDraft: string;
  /** 保存前の入力値だけを差し替える。 */
  setTitleDraft(title: string): void;
  isEditingTitle: boolean;
  /** 編集可能なら現在のタイトルを読み込み、編集開始の成否を返す。 */
  startTitleEdit(): boolean;
  /** 下書きを保存済みのタイトルに戻して編集を終了する。 */
  cancelTitleEdit(): void;
  /** 下書きを検査して必要なときだけ選択セッションに保存する。 */
  saveTitle(): Promise<void>;
  /** 対象の種別に合わせて Crew またはセッションの削除確認へ進む。 */
  deleteSession(): Promise<void>;
  /** 選択セッションとウィンドウの表示状態を基に、ヘッダーの操作を組み立てる。 */
  buildChatHeader(input: {
    actions?: ReactNode;
    isRunning: boolean;
    isReadOnly: boolean;
    isPinned: boolean;
    isPinPending: boolean;
    isAuxiliaryMode?: boolean;
    isWorkspaceAvailable: boolean;
    onOpenSessionTerminal: () => void;
    onOpenExternalTerminal?: () => void;
    onOpenSessionFilesExplorer: () => void;
    onOpenSessionFilesTerminal: () => void;
    onTitleInputKeyDown: KeyboardEventHandler<HTMLInputElement>;
    onDeleteSession: () => void;
    onToggleSessionPin: () => void;
    onOpenSessionExplorer: () => void;
  }): SessionHeaderProps;
};

/** タイトル・削除・役割変更の操作を管理し、対象が切り替わったときに確認状態を破棄する。 */
export function useSessionHeaderOperations(input: {
  api: WithMateWindowApi | null;
  selectedSession: Session | null;
  isReadOnly: boolean;
  runState: Session["runState"] | null;
  /** 対象がまだ有効かを確認できる関数と共にタイトル更新を受け取り、警告があれば返す。 */
  updateTitle(
    session: Session,
    title: string,
    isCurrent: () => boolean,
  ): Promise<string | void>;
  /** 削除が完了したウィンドウを閉じる。 */
  closeWindow(): void;
}): SessionHeaderOperations {
  const [titleDraft, setTitleDraft] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isRoleChangePending, setIsRoleChangePending] = useState(false);
  const [roleChangeSession, setRoleChangeSession] = useState<Session | null>(
    null,
  );
  const [roleChangeError, setRoleChangeError] = useState("");
  const [crewDeletionOpen, setCrewDeletionOpen] = useState(false);
  const roleChangePendingRef = useRef(false);
  const latestSessionRef = useRef(input.selectedSession);
  latestSessionRef.current = input.selectedSession;
  const titleRequestRevisionRef = useRef(0);
  const latestDraftRef = useRef(titleDraft);
  latestDraftRef.current = titleDraft;
  const ownerId = input.selectedSession?.id;
  const incarnationId = input.selectedSession
    ? getSessionIncarnationId(input.selectedSession)
    : null;
  useEffect(() => {
    setIsEditingTitle(false);
    setCrewDeletionOpen(false);
    setRoleChangeSession(null);
    setRoleChangeError("");
    return () => {
      titleRequestRevisionRef.current += 1;
    };
  }, [ownerId, incarnationId]);
  const canEdit =
    !!input.selectedSession &&
    !input.isReadOnly &&
    input.runState !== "running";

  const startTitleEdit = useCallback(
    () =>
      createStartTitleEditHandler({
        /** 編集開始時の下書きに選択セッションのタイトルを使う。 */
        getTitle: () => input.selectedSession?.taskTitle,
        /** セッション未選択・読み取り専用・実行中のいずれも編集しない。 */
        canStart: () => canEdit,
        setTitleDraft,
        /** ヘッダーは編集中に別途展開されるため、固定の開閉状態は変更しない。 */
        setHeaderExpanded: () => {},
        setEditingTitle: setIsEditingTitle,
      })(),
    [canEdit, input.selectedSession],
  );

  const cancelTitleEdit = useCallback(
    () =>
      createCancelTitleEditHandler({
        /** 編集を中止した場合の復元元を、選択セッションの保存済みタイトルにする。 */
        getTitle: () => input.selectedSession?.taskTitle,
        setTitleDraft,
        setEditingTitle: setIsEditingTitle,
      })(),
    [input.selectedSession],
  );

  /** 空白や同じタイトルは保存せず、保存中に下書きが変わったら編集状態を維持する。 */
  const saveTitle = useCallback(async () => {
    const session = input.selectedSession;
    if (!session || input.isReadOnly) return;
    const nextTitle = titleDraft.trim();
    if (!nextTitle) {
      setTitleDraft(session.taskTitle);
      setIsEditingTitle(false);
      return;
    }
    if (nextTitle === session.taskTitle) {
      setIsEditingTitle(false);
      return;
    }
    const revision = ++titleRequestRevisionRef.current;
    /** 新たな保存や選択先の変更で、完了時の通知と状態変更を無効にする。 */
    const isCurrent = () =>
      titleRequestRevisionRef.current === revision &&
      latestSessionRef.current?.id === session.id &&
      getSessionIncarnationId(latestSessionRef.current) ===
        getSessionIncarnationId(session);
    try {
      const warning = await input.updateTitle(session, nextTitle, isCurrent);
      if (!isCurrent()) return;
      if (latestDraftRef.current.trim() === nextTitle) setIsEditingTitle(false);
      if (warning) window.alert(warning);
    } catch (error) {
      if (isCurrent()) {
        window.alert(
          `Title was not saved: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }, [input, titleDraft]);

  const deleteSession = useCallback(async () => {
    const session = input.selectedSession;
    if (!input.api || !session || input.runState === "running") return;
    if (session.sessionKind === "default") {
      setCrewDeletionOpen(true);
      return;
    }
    if (
      !window.confirm(
        `Delete session "${session.taskTitle}"?\n\nIts Aux conversations will also be deleted.`,
      )
    )
      return;
    await input.api.deleteSession(session.id);
    input.closeWindow();
  }, [input]);

  const canChangeRole =
    !!input.api &&
    canEdit &&
    input.selectedSession?.sessionKind === "default" &&
    (input.selectedSession.sessionRole ?? "standalone") === "standalone";
  useEffect(() => {
    if (!canChangeRole) setRoleChangeSession(null);
  }, [canChangeRole]);

  const promoteToOverallCoordinator = useCallback(() => {
    if (!canChangeRole || roleChangePendingRef.current) return;
    setRoleChangeError("");
    setRoleChangeSession(input.selectedSession);
  }, [canChangeRole, input.selectedSession]);

  const confirmRoleChange = useCallback(async () => {
    const session = roleChangeSession;
    if (
      !input.api ||
      !session ||
      input.isReadOnly ||
      input.runState === "running" ||
      session.sessionKind !== "default" ||
      (session.sessionRole ?? "standalone") !== "standalone" ||
      latestSessionRef.current?.id !== session.id ||
      getSessionIncarnationId(latestSessionRef.current) !==
        getSessionIncarnationId(session) ||
      roleChangePendingRef.current
    )
      return;
    roleChangePendingRef.current = true;
    setIsRoleChangePending(true);
    try {
      await input.api.promoteSessionToOverallCoordinator(
        session.id,
        getSessionIncarnationId(session),
      );
      setRoleChangeSession((current) => (current === session ? null : current));
    } catch (error) {
      if (
        latestSessionRef.current?.id === session.id &&
        getSessionIncarnationId(latestSessionRef.current) ===
          getSessionIncarnationId(session)
      ) {
        setRoleChangeError(
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      roleChangePendingRef.current = false;
      setIsRoleChangePending(false);
    }
  }, [input, roleChangeSession]);

  const buildChatHeader = useCallback(
    (view: Parameters<SessionHeaderOperations["buildChatHeader"]>[0]) => {
      const session = input.selectedSession;
      if (!session) {
        throw new Error(
          "Cannot build a session header without a selected session.",
        );
      }

      const header = buildLiveSessionHeaderProps({
        sessionRole:
          !view.isAuxiliaryMode && session.sessionKind === "default"
            ? (session.sessionRole ?? "standalone")
            : undefined,
        isRoleChangePending,
        onPromoteToOverallCoordinator:
          !view.isAuxiliaryMode &&
          session.sessionKind === "default" &&
          (session.sessionRole ?? "standalone") === "standalone" &&
          !view.isReadOnly
            ? () => void promoteToOverallCoordinator()
            : undefined,
        actions: view.actions,
        taskTitle: session.taskTitle,
        isEditingTitle,
        titleDraft,
        isRunning: view.isRunning,
        isReadOnly: view.isReadOnly,
        isPinned: view.isPinned,
        isPinPending: view.isPinPending,
        isAuxiliaryMode: view.isAuxiliaryMode,
        canDeleteSession:
          session.sessionKind !== "default" ||
          (session.rootSessionId ?? session.id) === session.id,
        onOpenTerminal: view.onOpenSessionTerminal,
        onOpenExternalTerminal: view.onOpenExternalTerminal,
        isTerminalDisabled: !view.isWorkspaceAvailable,
        onOpenSessionFilesExplorer: view.onOpenSessionFilesExplorer,
        onOpenSessionFilesTerminal: view.onOpenSessionFilesTerminal,
        onTitleDraftChange: setTitleDraft,
        onTitleInputKeyDown: view.onTitleInputKeyDown,
        /** ボタン操作では保存処理を開始し、警告やエラーの表示はその処理に委ねる。 */
        onSaveTitle: () => void saveTitle(),
        onCancelTitleEdit: cancelTitleEdit,
        onStartTitleEdit: startTitleEdit,
        onDeleteSession: view.onDeleteSession,
        onTogglePin: view.onToggleSessionPin,
        onOpenWorkspaceExplorer: view.onOpenSessionExplorer,
        isWorkspaceExplorerDisabled: !view.isWorkspaceAvailable,
      });
      if (session.sessionKind === "default")
        header.deleteActionLabel = "Delete Crew";
      if (crewDeletionOpen && input.api)
        header.actions = createElement(
          "div",
          null,
          header.actions,
          createElement(CrewDeletionDialog, {
            api: input.api,
            sessionId: session.id,
            incarnationId: getSessionIncarnationId(session),
            title: session.taskTitle,
            /** 削除せずに Crew の確認ダイアログを閉じる。 */
            onClose: () => setCrewDeletionOpen(false),
            onDeleted: input.closeWindow,
          }),
        );
      if (
        roleChangeSession &&
        canChangeRole &&
        roleChangeSession.id === session.id &&
        getSessionIncarnationId(roleChangeSession) ===
          getSessionIncarnationId(session)
      ) {
        header.actions = createElement(
          "div",
          null,
          header.actions,
          createElement(SessionRoleChangeDialog, {
            title: roleChangeSession.taskTitle,
            pending: isRoleChangePending,
            error: roleChangeError,
            /** 表示していた役割変更の確認対象を破棄する。 */
            onClose: () => setRoleChangeSession(null),
            /** 確認したセッションが現在も変更可能な場合だけ昇格を申し込む。 */
            onConfirm: () => void confirmRoleChange(),
          }),
        );
      }
      return header;
    },
    [
      cancelTitleEdit,
      input,
      crewDeletionOpen,
      isEditingTitle,
      isRoleChangePending,
      promoteToOverallCoordinator,
      saveTitle,
      startTitleEdit,
      titleDraft,
      roleChangeSession,
      roleChangeError,
      canChangeRole,
      confirmRoleChange,
    ],
  );

  return {
    titleDraft,
    setTitleDraft,
    isEditingTitle,
    startTitleEdit,
    cancelTitleEdit,
    saveTitle,
    deleteSession,
    buildChatHeader,
  };
}
