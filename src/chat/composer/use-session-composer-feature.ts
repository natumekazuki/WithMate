import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEventHandler,
  type KeyboardEventHandler,
  type SetStateAction,
} from "react";

import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type {
  DiscoveredCustomAgent,
  DiscoveredSkill,
  ComposerPreview,
} from "../../../src-shared/session/runtime-state.js";
import type {
  ModelCatalogItem,
  ModelCatalogProvider,
  ModelReasoningEffort,
} from "../../../src-shared/settings/model-catalog.js";
import {
  getSessionIncarnationId,
  type Session,
} from "../../../src-shared/session/session-state.js";
import {
  applyAuxiliarySessionRuntimeOptionsPatch,
  type AuxiliarySession,
} from "../../../src-shared/auxiliary/auxiliary-session-state.js";
import {
  getSessionApprovalChoices,
  getSessionApprovalDisplay,
  resolveSessionApprovalChoice,
  type SessionApprovalChoice,
} from "../../../src-shared/settings/session-approval-choice.js";
import type { AuxiliaryDraftPersistence } from "../auxiliary/use-auxiliary-draft-persistence.js";
import type {
  ComposerControllerRegistry,
  ComposerOwner,
  ComposerSelection,
  ComposerSaveState,
} from "../composer-controller.js";
import { useSessionDraftFlushLifecycle } from "../runtime/use-session-draft-flush-lifecycle.js";
import { resolveSessionRunErrorMessage } from "../runtime/session-live-run-state.js";
import { buildAuxiliaryAwareRuntimeOptionChangeHandler } from "../auxiliary-runtime-option-routing.js";
import { buildAuxiliaryAwareSendOrCancelHandler } from "../send-or-cancel.js";
import {
  runAuxiliaryCodexSpeedChangeOperation,
  runAuxiliaryModelChangeOperation,
  runAuxiliaryReasoningEffortChangeOperation,
  runAuxiliarySandboxModeChangeOperation,
} from "../auxiliary/auxiliary-runtime-option-operation.js";
import {
  buildLiveSessionComposerDockProps,
  buildLiveSessionComposerProps,
  buildLiveSessionCompactActionDockProps,
  type LiveSessionComposerDockPropsInput,
} from "../chat-window-adapter.js";
import {
  buildAdditionalDirectoryItems,
  type ComposerPathPickerKind,
  type ComposerReferenceInput,
} from "./session-composer-paths.js";
import {
  buildCustomAgentMatchDisplay,
  buildSelectedCustomAgentDisplay,
  buildSkillMatchDisplay,
} from "./session-composer-selection.js";
import {
  buildComposerSendabilityState,
  getComposerSendButtonTitle,
  resolveComposerSendabilityState,
} from "./session-composer-feedback.js";
import { buildRuntimeSelectionOptions } from "../../settings/runtime-selection-options.js";
import type { ModelAvailabilitySettings } from "../../../src-shared/settings/model-availability.js";
import {
  applyComposerDraftClearCommand,
  buildOnDraftCompositionHandlers,
} from "../composer-draft-handlers.js";
import type { SessionComposerExpandedProps } from "./session-composer.js";
import type { ConfirmedReviewerChange } from "../../../src-shared/session/session-mutation-contract.js";
import type { ChatWindowProps } from "../chat-window.js";
import type { MainRuntimeOption } from "../runtime/main-session-mutation-operations.js";
import { createEmptyComposerPreview } from "./composer-preview-config.js";
import {
  createAgentPickerToggleHandler as createAgentPickerStateToggleHandler,
  createSkillPickerToggleHandler as createSkillPickerStateToggleHandler,
} from "../session-shell-handlers.js";

/** コンポーザーから追加の値なしで起動できる同期または非同期の操作。 */
type SessionComposerOperation = () => void | Promise<void>;
/** コンポーザーが選択した値を受け取る同期または非同期の操作。 */
type SessionComposerValueOperation<T> = (value: T) => void | Promise<void>;

/** 対象セッションの表示状態・利用可能な候補・操作をコンポーザーへ渡す接続契約。 */
export type SessionComposerFeatureBridge = {
  session: Session;
  canRemoveAdditionalDirectories: boolean;
  isCharacterAuthoringSession: boolean;
  target: "main" | "auxiliary";
  runtime: {
    isRunning: boolean;
    isCanceling?: boolean;
    isAwaitingRunStop?: boolean;
    canSendInput?: boolean;
    queueTurnBusy?: boolean;
    hasUncertainTurn?: boolean;
    inputError?: string;
    inputAcceptanceError?: string;
    selectedRunState: Session["runState"] | null;
    auxiliaryRunState: Session["runState"] | null;
    busyReason: string;
    blockedReason: string;
    isReadOnly: boolean;
    forceBlockedFeedback: boolean;
    isMessageListFollowing: boolean;
    isPromptTemplateWorkspaceOpen: boolean;
    providerCatalog: ModelCatalogProvider | null | undefined;
    models: readonly ModelCatalogItem[];
    modelAvailability?: ModelAvailabilitySettings;
    modelDiscoveryStatus?: "idle" | "loading" | "ready" | "error";
    modelDiscoveryError?: string;
    modelDiscoveryHasCache?: boolean;
    reasoningEfforts: readonly ModelReasoningEffort[];
  };
  resources: {
    availableCustomAgents: readonly DiscoveredCustomAgent[];
    availableSkills: readonly DiscoveredSkill[];
    isCustomAgentListLoading: boolean;
    isSkillListLoading: boolean;
    skillListError: string | null;
  };
  operations: {
    onModelPickerOpen?: () => void;
    send: {
      main: SessionComposerOperation;
      auxiliary: SessionComposerOperation;
      cancelMain: SessionComposerOperation;
      cancelAuxiliary: SessionComposerOperation;
      input?: SessionComposerOperation;
      queue?: SessionComposerOperation;
      checkReceipt?: SessionComposerOperation;
      retryOriginal?: SessionComposerOperation;
    };
    runtimeOptions: {
      runMain: (option: MainRuntimeOption) => void | Promise<void>;
      auxiliary: {
        session: AuxiliarySession | null;
        update: (
          recipe: (current: AuxiliarySession) => AuxiliarySession,
          confirmedReviewerChange?: ConfirmedReviewerChange,
          approvalChoice?: SessionApprovalChoice,
        ) => Promise<void>;
        timestamp: () => string;
      };
    };
    customAgent: {
      main: SessionComposerValueOperation<DiscoveredCustomAgent | null>;
      auxiliary: SessionComposerValueOperation<DiscoveredCustomAgent | null>;
    };
    skill: {
      main: SessionComposerValueOperation<DiscoveredSkill>;
      auxiliary: SessionComposerValueOperation<DiscoveredSkill>;
    };
    draft: {
      main: (value: string, selectionStart: number) => void | Promise<void>;
      auxiliary: (
        value: string,
        selectionStart: number,
      ) => void | Promise<void>;
      paste?: ClipboardEventHandler<HTMLTextAreaElement>;
      focus: () => void;
    };
    files: {
      pick: (kind: ComposerPathPickerKind) => void | Promise<void>;
      addToSessionFiles?: SessionComposerOperation;
      pickSessionFiles?: SessionComposerOperation;
      pickSessionFolder?: SessionComposerOperation;
      pickSessionImage?: SessionComposerOperation;
    };
    layout: {
      beforeOpenSkillPicker?: () => boolean;
      openPromptTemplates?: SessionComposerOperation;
      addAdditionalDirectory: (directoryPath?: string) => void | Promise<void>;
      removeAdditionalDirectory: (path: string) => void | Promise<void>;
      expandActionDock: () => void;
      jumpToBottom: () => void;
    };
    retryComposerSave?: SessionComposerOperation;
  };
};

/** 展開・コンパクト表示と補助ピッカーへ渡す描画用の状態と操作。 */
export type SessionComposerFeatureSurface = {
  composer: ReturnType<typeof buildLiveSessionComposerDockProps>["composer"];
  compactActionDock: ReturnType<
    typeof buildLiveSessionComposerDockProps
  >["compactActionDock"];
  additionalDirectoryListProps: NonNullable<
    ChatWindowProps["additionalDirectoryListProps"]
  >;
  skillPickerProps: NonNullable<ChatWindowProps["skillPickerProps"]>;
  skillItems: NonNullable<ChatWindowProps["skillPickerProps"]>["items"];
  onSelectSkill: NonNullable<
    ChatWindowProps["skillPickerProps"]
  >["onSelectSkill"];
  onToggleSkillPicker: () => void;
  isSkillPickerOpen: boolean;
  isSkillListLoading: boolean;
  skillListError: string | null;
  additionalDirectoryItems: NonNullable<
    ChatWindowProps["additionalDirectoryListProps"]
  >["items"];
  isAdditionalDirectoryListOpen: boolean;
  onRemoveAdditionalDirectory: (path: string) => void;
  isComposerFrozen: boolean;
};

/** セッションの入力欄を組み立てるためにフックが提供する状態と操作。 */
export type SessionComposerFeature = ReturnType<
  typeof useSessionComposerFeature
>;

/**
 * 対象ごとのコンポーザー状態を管理する。ルートが渡すのは選択中の所有者と
 * 既存の永続化サービスだけ。ピッカーの状態、選択範囲の ref、プレビュー状態、
 * 閉じるときに保存を完了させる処理はコンポーザーが担う。
 */
export function useSessionComposerFeature(input: {
  api: WithMateWindowApi | null;
  composerRegistry: ComposerControllerRegistry;
  composerOwner: ComposerOwner;
  composerDraft: string;
  canChangeDraft?: () => boolean;
  activeRunSessionId: string | null;
  selectedSessionId?: string | null;
  sessionProvider?: string | null;
  sessionWorkspacePath?: string;
  visibleRunState?: Session["runState"] | null;
  auxiliaryDraftPersistence: AuxiliaryDraftPersistence;
  setForceComposerBlockedFeedback: (value: boolean) => void;
}) {
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerOwnerRef = useRef<string | null>(null);
  const mainComposerCaretRef = useRef(0);
  const promptTemplateSelectionRef = useRef({ start: 0, end: 0 });
  const [pickerBaseDirectory, setPickerBaseDirectory] = useState("");
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);
  const [isSkillPickerOpen, setIsSkillPickerOpen] = useState(false);
  const [isAdditionalDirectoryListOpen, setIsAdditionalDirectoryListOpen] =
    useState(false);
  const [turnRecoveryActions, setTurnRecoveryActions] = useState<
    Record<string, "check" | "retry">
  >({});
  const [turnRecoveryErrors, setTurnRecoveryErrors] = useState<
    Record<string, string>
  >({});

  composerOwnerRef.current = input.activeRunSessionId;
  const composerSnapshot = input.composerRegistry.get(
    input.composerOwner,
    input.composerDraft,
  );
  useLayoutEffect(() => {
    input.composerRegistry.hydrateIfUnedited(
      input.composerOwner,
      input.composerDraft,
    );
  }, [input.composerDraft, input.composerOwner, input.composerRegistry]);

  const composerState = {
    ...composerSnapshot,
    /** 編集を許可されていれば現在の対象の下書きを更新し、許可されなければ現在版だけを返す。 */
    setDraft: (value: string, selection?: ComposerSelection) =>
      input.canChangeDraft?.() === false
        ? input.composerRegistry.get(input.composerOwner).revision
        : input.composerRegistry.setDraft(
            input.composerOwner,
            value,
            selection,
          ),
    /** 選択範囲またはその更新式を現在の編集対象へ渡す。 */
    setSelection: (value: SetStateAction<ComposerSelection>) =>
      input.composerRegistry.setSelection(input.composerOwner, value),
    /** 現在の編集対象に下書きのプレビュー結果を反映する。 */
    setPreview: (value: ComposerPreview) =>
      input.composerRegistry.setPreview(input.composerOwner, value),
    /** 現在の編集対象のIME変換中フラグを更新する。 */
    setImeComposing: (value: boolean) =>
      input.composerRegistry.setImeComposing(input.composerOwner, value),
    /** 現在の編集対象の保存状態と任意のエラーを更新する。 */
    setSaveState: (value: ComposerSaveState, error?: string | null) =>
      input.composerRegistry.setSaveState(input.composerOwner, value, error),
    /** 現在の編集対象の本文と版を送信後の照合用に取得する。 */
    capture: () => input.composerRegistry.capture(input.composerOwner),
  };

  const isComposerFrozen = useSessionDraftFlushLifecycle({
    api: input.api,
    composerRegistry: input.composerRegistry,
    persistence: input.auxiliaryDraftPersistence,
  });
  const draft = composerState.draft;
  const setDraft = useCallback(
    (update: SetStateAction<string>) => {
      const current = input.composerRegistry.get(input.composerOwner).draft;
      const next = typeof update === "function" ? update(current) : update;
      composerState.setDraft(next);
    },
    [composerState.setDraft, input.composerOwner, input.composerRegistry],
  );
  const { preview: composerPreview, setPreview: setComposerPreview } =
    composerState;
  const composerCaret = composerState.selection.start;
  const setComposerCaret = useCallback(
    (caret: number) => {
      composerState.setSelection({ start: caret, end: caret });
    },
    [composerState.setSelection],
  );
  const getComposerDraft = useCallback(
    () => input.composerRegistry.get(input.composerOwner).draft,
    [input.composerOwner, input.composerRegistry],
  );
  const closeAgentPicker = useCallback(() => setIsAgentPickerOpen(false), []);
  const closeSkillPicker = useCallback(() => setIsSkillPickerOpen(false), []);

  /** 対象セッションの状態と操作から、入力欄・ドック・補助ピッカーの描画用プロパティを作る。 */
  const buildSurface = (
    bridge: SessionComposerFeatureBridge,
  ): SessionComposerFeatureSurface => {
    const isAuxiliaryTarget = bridge.target === "auxiliary";
    /** 受付結果が不明な送信を照会または再試行し、処理中と失敗の表示を対象セッション別に管理する。 */
    const recoverTurn = async (action: "check" | "retry") => {
      const ownerId = bridge.session.id;
      if (turnRecoveryActions[ownerId]) return;
      setTurnRecoveryActions((current) => ({ ...current, [ownerId]: action }));
      setTurnRecoveryErrors((current) => ({ ...current, [ownerId]: "" }));
      try {
        await (action === "check"
          ? bridge.operations.send.checkReceipt?.()
          : bridge.operations.send.retryOriginal?.());
      } catch (error) {
        const message = resolveSessionRunErrorMessage(
          error,
          action === "check"
            ? "Could not check the receipt."
            : "Could not retry the original turn.",
        );
        setTurnRecoveryErrors((current) => ({
          ...current,
          [ownerId]: message,
        }));
      } finally {
        setTurnRecoveryActions((current) => {
          const next = { ...current };
          delete next[ownerId];
          return next;
        });
      }
    };
    const selectedAgentName = bridge.session.customAgentName
      .trim()
      .toLowerCase();
    const selectedCustomAgent =
      bridge.resources.availableCustomAgents.find(
        (agent) => agent.name.trim().toLowerCase() === selectedAgentName,
      ) ?? null;
    const selectedCustomAgentDisplay = buildSelectedCustomAgentDisplay(
      bridge.session,
      selectedCustomAgent,
    );
    const canSelectCustomAgent =
      !bridge.isCharacterAuthoringSession &&
      bridge.session.provider === "copilot";
    const customAgentItems: SessionComposerExpandedProps["customAgentItems"] = [
      {
        key: "default",
        value: null,
        primaryLabel: "Default Agent",
        secondaryLabel: "Use the default Copilot agent",
        title: "Do not use a custom agent",
        isSelected: !bridge.session.customAgentName,
      },
      ...bridge.resources.availableCustomAgents.map((agent) => {
        const display = buildCustomAgentMatchDisplay(agent);
        return {
          key: agent.id,
          value: agent.name,
          primaryLabel: display.primaryLabel,
          secondaryLabel: display.secondaryLabel,
          title: display.title,
          isSelected:
            bridge.session.customAgentName.trim().toLowerCase() ===
            agent.name.trim().toLowerCase(),
        };
      }),
    ];
    const skillItems: NonNullable<
      ChatWindowProps["skillPickerProps"]
    >["items"] = bridge.resources.availableSkills.map((skill) => {
      const display = buildSkillMatchDisplay(skill);
      return {
        key: skill.id,
        skillId: skill.id,
        primaryLabel: display.primaryLabel,
        secondaryLabel: display.secondaryLabel,
        title: display.title,
        searchText: `${skill.name}\n${skill.description}`,
      };
    });
    const runtimeOptions = buildRuntimeSelectionOptions({
      providerId: bridge.session.provider,
      providerCatalog: bridge.runtime.providerCatalog,
      models: bridge.runtime.models,
      selectedModel: bridge.session.model,
      selectedReasoningEffort: bridge.session.reasoningEffort,
      reasoningEfforts: bridge.runtime.reasoningEfforts,
      selectedCodexSandboxMode: bridge.session.codexSandboxMode,
      selectedCodexSpeed: bridge.session.codexSpeed,
    });
    const approval = getSessionApprovalDisplay(bridge.session);
    const approvalOptions = getSessionApprovalChoices();
    const composerSendability =
      bridge.target === "auxiliary"
        ? buildComposerSendabilityState({
            runState: bridge.runtime.auxiliaryRunState,
            canSendInput: bridge.runtime.canSendInput,
            canQueueTurn: !!bridge.operations.send.queue,
            busyReason: bridge.runtime.busyReason,
            blockedReason: bridge.runtime.blockedReason,
            inputErrors: composerPreview.errors,
            draftText: getComposerDraft(),
          })
        : resolveComposerSendabilityState({
            runState: bridge.runtime.selectedRunState,
            canSendInput: bridge.runtime.canSendInput,
            canQueueTurn: !!bridge.operations.send.queue,
            busyReason: bridge.runtime.busyReason,
            blockedReason: bridge.runtime.blockedReason,
            inputErrors: composerPreview.errors,
            draftText: getComposerDraft(),
            forceBlockedFeedback: bridge.runtime.forceBlockedFeedback,
          });
    const isComposerDisabled =
      bridge.runtime.isReadOnly || !!bridge.runtime.blockedReason;
    const onSendOrCancel = buildAuxiliaryAwareSendOrCancelHandler({
      shouldSendAuxiliary: isAuxiliaryTarget,
      isAuxiliarySessionRunning: bridge.runtime.auxiliaryRunState === "running",
      isSelectedSessionRunning: bridge.runtime.selectedRunState === "running",
      preferAuxiliarySendOverSelectedCancel: true,
      onCancelAuxiliaryRun: bridge.operations.send.cancelAuxiliary,
      onSendAuxiliary: bridge.operations.send.auxiliary,
      onCancelSelectedSessionRun: bridge.operations.send.cancelMain,
      onSendSelectedSession: bridge.operations.send.main,
    });
    const auxiliaryRuntime = bridge.operations.runtimeOptions.auxiliary;
    /** 補助セッションのSandbox設定を、対象の更新操作へ渡す。 */
    const onAuxiliarySandbox = (
      codexSandboxMode: Session["codexSandboxMode"],
    ) =>
      runAuxiliarySandboxModeChangeOperation({
        codexSandboxMode,
        updateActiveAuxiliarySession: auxiliaryRuntime.update,
        createTimestampLabel: auxiliaryRuntime.timestamp,
      });
    /** 補助セッションのCodex実行速度を、対象の更新操作へ渡す。 */
    const onAuxiliarySpeed = (codexSpeed: Session["codexSpeed"]) =>
      runAuxiliaryCodexSpeedChangeOperation({
        codexSpeed,
        updateActiveAuxiliarySession: auxiliaryRuntime.update,
        createTimestampLabel: auxiliaryRuntime.timestamp,
      });
    /** 選択したモデルの定義を使って、補助セッションの実行設定を変更する。 */
    const onAuxiliaryModel = (model: ModelCatalogItem) => {
      return runAuxiliaryModelChangeOperation({
        model,
        updateActiveAuxiliarySession: auxiliaryRuntime.update,
        createTimestampLabel: auxiliaryRuntime.timestamp,
      });
    };
    /** 候補のカタログと補助セッションがそろう場合にだけ推論深度の変更を実行する。 */
    const onAuxiliaryReasoning = (reasoningEffort: string) => {
      if (!bridge.runtime.providerCatalog || !auxiliaryRuntime.session) {
        return;
      }
      return runAuxiliaryReasoningEffortChangeOperation({
        reasoningEffort: reasoningEffort as Session["reasoningEffort"],
        providerCatalog: bridge.runtime.providerCatalog,
        updateActiveAuxiliarySession: auxiliaryRuntime.update,
        createTimestampLabel: auxiliaryRuntime.timestamp,
      });
    };
    /** 承認モードを現在の対象へ反映し、補助側ではプロバイダーに適用できる場合だけ設定を更新する。 */
    const onChangeApprovalMode = (value: SessionApprovalChoice) => {
      if (isAuxiliaryTarget) {
        void auxiliaryRuntime.update(
          (current) => {
            const patch = resolveSessionApprovalChoice(current.provider, value);
            return patch
              ? applyAuxiliarySessionRuntimeOptionsPatch(
                  current,
                  patch,
                  auxiliaryRuntime.timestamp(),
                )
              : current;
          },
          undefined,
          value,
        );
      } else {
        void bridge.operations.runtimeOptions.runMain({
          kind: "approval-choice",
          value,
        });
      }
    };
    const onChangeCodexSandboxMode =
      buildAuxiliaryAwareRuntimeOptionChangeHandler({
        shouldUseAuxiliary: isAuxiliaryTarget,
        onAuxiliaryChange: onAuxiliarySandbox,
        /** メインセッションのSandbox選択を実行設定の更新要求にする。 */
        onSelectedSessionChange: (value) =>
          bridge.operations.runtimeOptions.runMain({
            kind: "codex-sandbox-mode",
            value,
          }),
      });
    const onChangeCodexSpeed = buildAuxiliaryAwareRuntimeOptionChangeHandler({
      shouldUseAuxiliary: isAuxiliaryTarget,
      onAuxiliaryChange: onAuxiliarySpeed,
      /** メインセッションのCodex実行速度を切り替える。 */
      onSelectedSessionChange: (value) =>
        bridge.operations.runtimeOptions.runMain({
          kind: "codex-speed",
          value,
        }),
    });
    const onChangeModel = buildAuxiliaryAwareRuntimeOptionChangeHandler({
      shouldUseAuxiliary: isAuxiliaryTarget,
      onAuxiliaryChange: onAuxiliaryModel,
      /** 選択したモデルの定義をメインセッションの更新処理へ渡す。 */
      onSelectedSessionChange: (value) =>
        bridge.operations.runtimeOptions.runMain({ kind: "model", value }),
    });
    const onChangeReasoningEffort =
      buildAuxiliaryAwareRuntimeOptionChangeHandler({
        shouldUseAuxiliary: isAuxiliaryTarget,
        onAuxiliaryChange: onAuxiliaryReasoning,
        /** 選択欄の推論深度をメインセッションの更新処理へ渡す。 */
        onSelectedSessionChange: (value) =>
          bridge.operations.runtimeOptions.runMain({
            kind: "reasoning-effort",
            value: value as ModelReasoningEffort,
          }),
      });
    /** 下書きと選択開始位置を、対象に応じてメインまたは補助の更新処理へ渡す。 */
    const onDraftChange = (value: string, selectionStart: number) => {
      if (isAuxiliaryTarget) {
        void bridge.operations.draft.auxiliary(value, selectionStart);
        return;
      }
      bridge.operations.draft.main(value, selectionStart);
    };
    /** 登録名からエージェント候補を特定して対象へ適用し、見つからない場合は既定値として扱う。 */
    const onSelectCustomAgent = (value: string | null) => {
      const agent = value
        ? (bridge.resources.availableCustomAgents.find(
            (entry) => entry.name === value,
          ) ?? null)
        : null;
      void (isAuxiliaryTarget
        ? bridge.operations.customAgent.auxiliary(agent)
        : bridge.operations.customAgent.main(agent));
    };
    /** 凍結中でなく、選択IDが現在の候補にあるときだけ対象セッションへスキルを適用する。 */
    const onSelectSkill = (skillId: string) => {
      if (input.composerRegistry.isFrozen) {
        return;
      }
      const skill = bridge.resources.availableSkills.find(
        (entry) => entry.id === skillId,
      );
      if (!skill) {
        return;
      }
      void (isAuxiliaryTarget
        ? bridge.operations.skill.auxiliary(skill)
        : bridge.operations.skill.main(skill));
    };
    const toggleAgentPickerState = createAgentPickerStateToggleHandler({
      setAgentPickerOpen: setIsAgentPickerOpen,
      setSkillPickerOpen: setIsSkillPickerOpen,
    });
    /** 凍結中でなければ、スキルピッカーと排他的にエージェントピッカーを切り替える。 */
    const toggleAgentPicker = () => {
      if (input.composerRegistry.isFrozen) {
        return;
      }
      toggleAgentPickerState();
    };
    const toggleSkillPickerState = createSkillPickerStateToggleHandler({
      setAgentPickerOpen: setIsAgentPickerOpen,
      setSkillPickerOpen: setIsSkillPickerOpen,
    });
    /** 凍結中は操作せず、開くときだけ事前処理の結果を確認してスキルピッカーを切り替える。 */
    const toggleSkillPicker = () => {
      if (input.composerRegistry.isFrozen) {
        return;
      }
      if (
        !isSkillPickerOpen &&
        bridge.operations.layout.beforeOpenSkillPicker &&
        !bridge.operations.layout.beforeOpenSkillPicker()
      ) {
        return;
      }
      toggleSkillPickerState();
    };
    /** 凍結中でなければ追加ディレクトリ一覧の開閉を反転する。 */
    const toggleAdditionalDirectoryList = () => {
      if (input.composerRegistry.isFrozen) {
        return;
      }
      setIsAdditionalDirectoryListOpen((current) => !current);
    };
    /** 手入力されたパス、またはピッカーを開くための未指定値を追加操作へ渡す。 */
    const onAddAdditionalDirectory = (directoryPath?: string) => {
      return bridge.operations.layout.addAdditionalDirectory(directoryPath);
    };
    /** 選択した追加ディレクトリの元のパスを削除操作へ渡す。 */
    const onRemoveAdditionalDirectory = (path: string) => {
      void bridge.operations.layout.removeAdditionalDirectory(path);
    };
    /** 対象セッションの選択範囲を記録し、メイン入力欄では選択開始位置の控えも更新する。 */
    const onDraftSelect = (selectionStart: number) => {
      if (!input.activeRunSessionId) {
        return;
      }
      const selectionEnd =
        composerTextareaRef.current?.selectionEnd ?? selectionStart;
      composerState.setSelection({ start: selectionStart, end: selectionEnd });
      if (!isAuxiliaryTarget) {
        mainComposerCaretRef.current = selectionStart;
      }
    };
    const onDraftComposition = buildOnDraftCompositionHandlers({
      setComposerCaret,
      /** IME変換の開始・終了を現在の編集対象に反映する。 */
      setIsComposerImeComposing: (value) =>
        composerState.setImeComposing(value),
      /** 入力欄の対象が一致する間は実際の選択開始位置を読み、それ以外は控えの位置を使う。 */
      getSelectionStart: () =>
        composerOwnerRef.current === input.activeRunSessionId
          ? composerTextareaRef.current?.selectionStart
          : composerCaret,
      /** DOMから選択位置が取得できないときは、下書きの末尾を使う。 */
      getFallbackSelectionStart: () => draft.length,
      syncMainComposerCaret: !isAuxiliaryTarget
        ? (selectionStart) => {
            mainComposerCaretRef.current = selectionStart;
          }
        : undefined,
    });
    const isComposerBlockedFeedbackActive =
      bridge.runtime.forceBlockedFeedback &&
      composerSendability.feedbackTone === "blocked";
    const sendButtonTitle = bridge.runtime.isCanceling
      ? "Waiting for the run to stop"
      : getComposerSendButtonTitle(composerSendability);
    const dock: LiveSessionComposerDockPropsInput = {
      canSelectCustomAgent,
      additionalDirectoryCount:
        bridge.session.allowedAdditionalDirectories.length,
      isRunning: bridge.runtime.isRunning,
      canSendInput: bridge.runtime.canSendInput,
      submissionError:
        bridge.runtime.inputAcceptanceError || bridge.runtime.inputError,
      inputAcceptanceUnconfirmed: !!bridge.runtime.inputAcceptanceError,
      /** 実行中ターンへの追加入力を送る操作を呼ぶ。 */
      onSendInput: () => void bridge.operations.send.input?.(),
      onQueueTurn: bridge.operations.send.queue
        ? () => void bridge.operations.send.queue?.()
        : undefined,
      queueTurnBusy: bridge.runtime.queueTurnBusy,
      turnRecoveryAction: turnRecoveryActions[bridge.session.id],
      turnRecoveryError: turnRecoveryErrors[bridge.session.id],
      onCheckTurnReceipt: bridge.runtime.hasUncertainTurn
        ? () => void recoverTurn("check")
        : undefined,
      onRetryOriginalTurn: bridge.runtime.hasUncertainTurn
        ? () => void recoverTurn("retry")
        : undefined,
      composerBlocked:
        bridge.runtime.isReadOnly || !!bridge.runtime.blockedReason,
      isAgentPickerOpen,
      isSkillPickerOpen,
      isPromptTemplateWorkspaceOpen:
        bridge.runtime.isPromptTemplateWorkspaceOpen,
      isAdditionalDirectoryListOpen,
      selectedCustomAgentLabel: canSelectCustomAgent
        ? selectedCustomAgentDisplay.label
        : "Agent",
      selectedCustomAgentTitle:
        selectedCustomAgentDisplay.title ?? "Select a Copilot custom agent",
      isMessageListFollowing: bridge.runtime.isMessageListFollowing,
      isCustomAgentListLoading: bridge.resources.isCustomAgentListLoading,
      customAgentItems,
      draft,
      composerController: {
        owner: input.composerOwner,
        registry: input.composerRegistry,
        initialDraft: input.composerDraft,
      },
      onRetryComposerSave:
        isAuxiliaryTarget && bridge.operations.retryComposerSave
          ? () => void bridge.operations.retryComposerSave?.()
          : undefined,
      composerTextareaRef,
      isComposerDisabled,
      isSendDisabled: composerSendability.isSendDisabled,
      composerSendability,
      forceComposerBlockedFeedback: bridge.runtime.forceBlockedFeedback,
      sendButtonTitle,
      isComposerBlockedFeedbackActive,
      approvalOptions: approval.value
        ? approvalOptions
        : [
            { value: "", label: approval.label, disabled: true },
            ...approvalOptions,
          ],
      providerId: bridge.session.provider,
      selectedApprovalMode: approval.value,
      sandboxOptions: runtimeOptions.sandboxChoiceOptions,
      selectedCodexSandboxMode: bridge.session.codexSandboxMode,
      speedOptions: runtimeOptions.speedSelectOptions,
      selectedCodexSpeed: bridge.session.codexSpeed,
      modelOptions: runtimeOptions.modelSelectOptions,
      modelAvailability: bridge.runtime.modelAvailability,
      modelDiscoveryStatus: bridge.runtime.modelDiscoveryStatus,
      modelDiscoveryError: bridge.runtime.modelDiscoveryError,
      modelDiscoveryHasCache: bridge.runtime.modelDiscoveryHasCache,
      onModelPickerOpen: bridge.operations.onModelPickerOpen,
      selectedModel: bridge.session.model,
      selectedModelFallbackLabel: runtimeOptions.selectedModelFallbackLabel,
      reasoningOptions: runtimeOptions.reasoningSelectOptions,
      selectedReasoningEffort: bridge.session.reasoningEffort,
      /** 元のパスを参照として挿入するため、通常ファイルの選択を開く。 */
      onPickFile: () => void bridge.operations.files.pick("file"),
      /** 元のパスを参照として挿入するため、フォルダーの選択を開く。 */
      onPickFolder: () => void bridge.operations.files.pick("folder"),
      /** 画像参照として挿入するファイルの選択を開く。 */
      onPickImage: () => void bridge.operations.files.pick("image"),
      onAddToSessionFiles: bridge.operations.files.addToSessionFiles
        ? () => void bridge.operations.files.addToSessionFiles?.()
        : undefined,
      onPickSessionFiles: bridge.operations.files.pickSessionFiles
        ? () => void bridge.operations.files.pickSessionFiles?.()
        : undefined,
      onPickSessionFolder: bridge.operations.files.pickSessionFolder
        ? () => void bridge.operations.files.pickSessionFolder?.()
        : undefined,
      onPickSessionImage: bridge.operations.files.pickSessionImage
        ? () => void bridge.operations.files.pickSessionImage?.()
        : undefined,
      onToggleAgentPicker: toggleAgentPicker,
      onCloseAgentPicker: closeAgentPicker,
      onToggleSkillPicker: toggleSkillPicker,
      onOpenPromptTemplates: bridge.operations.layout.openPromptTemplates
        ? () => void bridge.operations.layout.openPromptTemplates?.()
        : undefined,
      onAddAdditionalDirectory,
      /** ウィンドウのセッションを基準に入力パスを検証し、接続情報がなければエラーを返す。 */
      onValidateAdditionalDirectory: async (directoryPath) => {
        const windowSessionId = input.selectedSessionId;
        if (!input.api || !windowSessionId)
          throw new Error("Directory validation is unavailable.");
        return input.api.validateSessionAdditionalDirectory(
          windowSessionId,
          directoryPath,
        );
      },
      onToggleAdditionalDirectoryList: toggleAdditionalDirectoryList,
      onExpandActionDock: bridge.operations.layout.expandActionDock,
      onJumpToBottom: bridge.operations.layout.jumpToBottom,
      onSelectCustomAgent,
      onDraftChange,
      onDraftFocus: bridge.operations.draft.focus,
      onDraftKeyDown: undefined as
        KeyboardEventHandler<HTMLTextAreaElement> | undefined,
      onDraftPaste: bridge.operations.draft.paste,
      onDraftSelect,
      ...onDraftComposition,
      onSendOrCancel,
      onChangeApprovalMode,
      onChangeCodexSandboxMode,
      onChangeCodexSpeed,
      onChangeModel,
      onChangeReasoningEffort,
    };

    const dockSurface = buildLiveSessionComposerDockProps({
      ...dock,
      isCanceling: bridge.runtime.isCanceling,
      isAwaitingRunStop: bridge.runtime.isAwaitingRunStop,
      showCustomAgentPicker: canSelectCustomAgent,
      showSkillPicker: !bridge.isCharacterAuthoringSession,
      showPromptTemplateButton: true,
    });

    return {
      composer: buildLiveSessionComposerProps(dockSurface.composer),
      compactActionDock: buildLiveSessionCompactActionDockProps(
        dockSurface.compactActionDock,
      ),
      additionalDirectoryListProps: {
        isOpen: isAdditionalDirectoryListOpen,
        items: buildAdditionalDirectoryItems(
          bridge.session.allowedAdditionalDirectories,
          bridge.canRemoveAdditionalDirectories,
        ),
        isInteractionDisabled:
          bridge.runtime.isReadOnly ||
          !!bridge.runtime.blockedReason ||
          isComposerFrozen,
        onRemove: onRemoveAdditionalDirectory,
      },
      skillPickerProps: {
        isOpen: !bridge.isCharacterAuthoringSession && isSkillPickerOpen,
        isInteractionDisabled: isComposerFrozen,
        isLoading: bridge.resources.isSkillListLoading,
        errorMessage: bridge.resources.skillListError,
        items: skillItems,
        onSelectSkill,
        onDismiss: toggleSkillPicker,
      },
      skillItems,
      onSelectSkill,
      onToggleSkillPicker: toggleSkillPicker,
      isSkillPickerOpen,
      isSkillListLoading: bridge.resources.isSkillListLoading,
      skillListError: bridge.resources.skillListError,
      additionalDirectoryItems: buildAdditionalDirectoryItems(
        bridge.session.allowedAdditionalDirectories,
        bridge.canRemoveAdditionalDirectories,
      ),
      isAdditionalDirectoryListOpen,
      onRemoveAdditionalDirectory,
      isComposerFrozen,
    };
  };

  useLayoutEffect(() => {
    const selection = composerState.selection;
    composerTextareaRef.current?.setSelectionRange(
      selection.start,
      selection.end,
    );
    if (input.composerOwner.kind === "main")
      mainComposerCaretRef.current = selection.start;
    setIsAgentPickerOpen(false);
    setIsSkillPickerOpen(false);
    setIsAdditionalDirectoryListOpen(false);
    input.setForceComposerBlockedFeedback(false);
    composerState.setImeComposing(false);
  }, [
    input.activeRunSessionId,
    input.composerOwner.kind,
    input.composerOwner.frameKey,
  ]);

  useLayoutEffect(() => {
    applyComposerDraftClearCommand({
      setDraft,
      setComposerCaret,
      /** セッション切替で下書きを初期化するとき、メイン側のキャレットの控えも戻す。 */
      syncMainComposerCaret: (selectionStart) => {
        mainComposerCaretRef.current = selectionStart;
      },
      nextCaret: 0,
    });
    setComposerPreview(createEmptyComposerPreview());
    setPickerBaseDirectory(input.sessionWorkspacePath ?? "");
    composerState.setImeComposing(false);
    input.setForceComposerBlockedFeedback(false);
  }, [input.selectedSessionId, input.sessionProvider]);

  useLayoutEffect(() => {
    if (input.visibleRunState !== "running") {
      return;
    }
    setIsAgentPickerOpen(false);
    setIsSkillPickerOpen(false);
  }, [input.visibleRunState]);

  return {
    composerState,
    composerSnapshot,
    composerTextareaRef,
    composerOwnerRef,
    mainComposerCaretRef,
    promptTemplateSelectionRef,
    composerDraft: input.composerDraft,
    draft,
    setDraft,
    composerPreview,
    setComposerPreview,
    composerCaret,
    setComposerCaret,
    getComposerDraft,
    isComposerFrozen,
    pickerBaseDirectory,
    setPickerBaseDirectory,
    isAgentPickerOpen,
    setIsAgentPickerOpen,
    closeAgentPicker,
    isSkillPickerOpen,
    setIsSkillPickerOpen,
    closeSkillPicker,
    isAdditionalDirectoryListOpen,
    setIsAdditionalDirectoryListOpen,
    buildSurface,
  };
}
