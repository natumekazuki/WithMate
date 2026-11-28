import {
  buildActionDockCollapseState,
  buildActionDockExpandState,
} from "./approval/action-dock-state.js";
import {
  buildExclusiveComposerPickerToggleState,
  buildSkillPromptInsertionState,
  type SkillPromptInsertionState,
} from "./composer/session-composer-selection.js";
import { createQuotedMessageInsertionFromComposer } from "./message-text-actions.js";
import {
  buildComposerReferenceInsertionState,
  buildSelectedPathReferenceInsertionState,
  resolvePickedPathBaseDirectory,
  toDirectoryPath,
  type ComposerPathPickerKind,
  type ComposerReferenceInput,
  type PathReferenceInsertionState,
} from "./composer/session-composer-paths.js";
import {
  cycleContextPaneTab,
  type ContextPaneTabKey,
} from "./runtime/session-ui-projection.js";

/** 指定した成果物の展開状態だけを反転し、未登録の成果物は展開する。 */
export function toggleExpandedArtifactState(
  current: Record<string, boolean>,
  artifactKey: string,
): Record<string, boolean> {
  return {
    ...current,
    [artifactKey]: !current[artifactKey],
  };
}

/** 最新の展開状態を受け取る updater で一件分の切り替えを反映する。 */
export function applyExpandedArtifactToggleCommand(input: {
  artifactKey: string;
  setExpandedArtifacts: (
    updater: (current: Record<string, boolean>) => Record<string, boolean>,
  ) => void;
}): void {
  input.setExpandedArtifacts((current) =>
    toggleExpandedArtifactState(current, input.artifactKey),
  );
}

/** 成果物キーを受け取って一覧の展開状態を更新する操作を作る。 */
export function createExpandedArtifactToggleHandler(input: {
  setExpandedArtifacts: (
    updater: (current: Record<string, boolean>) => Record<string, boolean>,
  ) => void;
}): (artifactKey: string) => void {
  return (artifactKey) =>
    applyExpandedArtifactToggleCommand({
      artifactKey,
      setExpandedArtifacts: input.setExpandedArtifacts,
    });
}

/** タイトルの編集を途中で隠さないよう、編集中は開閉状態を維持する。 */
export function resolveHeaderExpandedToggle(
  current: boolean,
  isEditingTitle: boolean,
): boolean {
  return isEditingTitle ? current : !current;
}

/** タイトル編集の状態を条件に、現在のヘッダー開閉状態を更新する。 */
export function applyHeaderExpandedToggleCommand(input: {
  isEditingTitle: boolean;
  setHeaderExpanded: (updater: (current: boolean) => boolean) => void;
}): void {
  input.setHeaderExpanded((current) =>
    resolveHeaderExpandedToggle(current, input.isEditingTitle),
  );
}

/** ヘッダーの区切り操作に、タイトル編集中の開閉制限を組み込む。 */
export function createHeaderExpandedToggleHandler(input: {
  isEditingTitle: boolean;
  setHeaderExpanded: (updater: (current: boolean) => boolean) => void;
}): () => void {
  return () => applyHeaderExpandedToggleCommand(input);
}

/** Enter で保存し、Escape で編集を中止する。他のキーの通常動作は妨げない。 */
export function applyTitleInputKeyCommand(input: {
  key: string;
  preventDefault: () => void;
  saveTitle: () => void;
  cancelTitleEdit: () => void;
}): void {
  if (input.key === "Enter") {
    input.preventDefault();
    input.saveTitle();
    return;
  }

  if (input.key === "Escape") {
    input.preventDefault();
    input.cancelTitleEdit();
  }
}

/** タイトル欄のキーイベントを、保存と編集中止のコマンドに接続する。 */
export function createTitleInputKeyHandler(input: {
  saveTitle: () => void;
  cancelTitleEdit: () => void;
}): (event: { key: string; preventDefault: () => void }) => void {
  return (event) =>
    applyTitleInputKeyCommand({
      key: event.key,
      /** コマンドが消費したキーの既定動作だけを抑止する。 */
      preventDefault: () => event.preventDefault(),
      saveTitle: input.saveTitle,
      cancelTitleEdit: input.cancelTitleEdit,
    });
}

/** 送信条件を、固定値または実行直前に調べる関数で指定する。 */
type MaybeLazyBoolean = boolean | (() => boolean);

/** 指定された判定関数を呼び、条件が省略されていれば偽として扱う。 */
function resolveMaybeLazyBoolean(value: MaybeLazyBoolean | undefined): boolean {
  return typeof value === "function" ? value() : value === true;
}

/** 無効なら未処理、ブロック中なら通知のみ、それ以外は送信して処理済みを返す。 */
export function applyComposerSubmitCommand(input: {
  isSubmitDisabled?: MaybeLazyBoolean;
  isSubmitBlocked?: MaybeLazyBoolean;
  notifySubmitBlocked?: () => void;
  submit: () => void;
}): boolean {
  if (resolveMaybeLazyBoolean(input.isSubmitDisabled)) {
    return false;
  }

  if (resolveMaybeLazyBoolean(input.isSubmitBlocked)) {
    input.notifySubmitBlocked?.();
    return true;
  }

  input.submit();
  return true;
}

/** 現在のタイトルを下書きに写してヘッダーを展開し、編集状態に入る。 */
export function applyStartTitleEditCommand(input: {
  title: string;
  setTitleDraft: (title: string) => void;
  setHeaderExpanded: (expanded: boolean) => void;
  setEditingTitle: (editing: boolean) => void;
}): void {
  input.setTitleDraft(input.title);
  input.setHeaderExpanded(true);
  input.setEditingTitle(true);
}

/** 操作時に編集可否とタイトルを調べ、対象が存在するときだけ編集を始める。 */
export function createStartTitleEditHandler(input: {
  getTitle: () => string | null | undefined;
  canStart?: () => boolean;
  setTitleDraft: (title: string) => void;
  setHeaderExpanded: (expanded: boolean) => void;
  setEditingTitle: (editing: boolean) => void;
}): () => boolean {
  return () => {
    if (input.canStart?.() === false) {
      return false;
    }

    const title = input.getTitle();
    if (title == null) {
      return false;
    }

    applyStartTitleEditCommand({
      title,
      setTitleDraft: input.setTitleDraft,
      setHeaderExpanded: input.setHeaderExpanded,
      setEditingTitle: input.setEditingTitle,
    });
    return true;
  };
}

/** 変更中の文面を元のタイトルに戻し、編集を終了する。 */
export function applyCancelTitleEditCommand(input: {
  title: string;
  setTitleDraft: (title: string) => void;
  setEditingTitle: (editing: boolean) => void;
}): void {
  input.setTitleDraft(input.title);
  input.setEditingTitle(false);
}

/** 中止時点のタイトルで下書きを戻し、取得できなければ空にする。 */
export function createCancelTitleEditHandler(input: {
  getTitle: () => string | null | undefined;
  setTitleDraft: (title: string) => void;
  setEditingTitle: (editing: boolean) => void;
}): () => void {
  return () =>
    applyCancelTitleEditCommand({
      title: input.getTitle() ?? "",
      setTitleDraft: input.setTitleDraft,
      setEditingTitle: input.setEditingTitle,
    });
}

/** 展開状態を固定し、展開オプションが求める場合は入力欄へフォーカスする。 */
export function applyActionDockExpandCommand(input: {
  options?: { focusComposer?: boolean };
  setPinnedExpanded: (expanded: boolean) => void;
  focusComposer: () => void;
}): void {
  const nextState = buildActionDockExpandState(input.options);
  input.setPinnedExpanded(nextState.isActionDockPinnedExpanded);

  if (nextState.shouldFocusComposer) {
    input.focusComposer();
  }
}

/** ドック展開時のフォーカス方針を呼び出しごとに指定できる操作を作る。 */
export function createActionDockExpandHandler(input: {
  defaultOptions?: { focusComposer?: boolean };
  setPinnedExpanded: (expanded: boolean) => void;
  focusComposer: () => void;
}): (options?: { focusComposer?: boolean }) => void {
  return (options) =>
    applyActionDockExpandCommand({
      options: options ?? input.defaultOptions,
      setPinnedExpanded: input.setPinnedExpanded,
      focusComposer: input.focusComposer,
    });
}

/** 強制展開などで閉じられない場合は固定状態を更新しない。 */
export function applyActionDockCollapseCommand(input: {
  canCollapse: boolean;
  setPinnedExpanded: (expanded: boolean) => void;
}): void {
  const nextState = buildActionDockCollapseState(input.canCollapse);
  if (!nextState) {
    return;
  }

  input.setPinnedExpanded(nextState.isActionDockPinnedExpanded);
}

/** ドックの開閉操作に、現在折りたためるかどうかの制約を付ける。 */
export function createActionDockCollapseHandler(input: {
  canCollapse: boolean;
  setPinnedExpanded: (expanded: boolean) => void;
}): () => void {
  return () => applyActionDockCollapseCommand(input);
}

/** テンプレート画面を閉じられないときは画面の切り替えを許可しない。 */
export function applyCentralSurfaceOpenCommand(input: {
  isPromptTemplateWorkspaceOpen: boolean;
  canClosePromptTemplate: () => boolean;
  closeCentralSurface: () => void;
}): boolean {
  if (input.isPromptTemplateWorkspaceOpen && !input.canClosePromptTemplate()) {
    return false;
  }

  input.closeCentralSurface();
  return true;
}

/** Agent と Skill のうち、片方を閉じてから選ばれた方の開閉を反転する。 */
export function applyExclusiveComposerPickerToggle(input: {
  target: "agent" | "skill";
  setAgentPickerOpen: (updater: (current: boolean) => boolean) => void;
  setSkillPickerOpen: (updater: (current: boolean) => boolean) => void;
}): void {
  if (input.target === "agent") {
    input.setSkillPickerOpen(
      () =>
        buildExclusiveComposerPickerToggleState("agent", false)
          .isSkillPickerOpen,
    );
    input.setAgentPickerOpen(
      (current) =>
        buildExclusiveComposerPickerToggleState("agent", current)
          .isAgentPickerOpen,
    );
    return;
  }

  input.setAgentPickerOpen(
    () =>
      buildExclusiveComposerPickerToggleState("skill", false).isAgentPickerOpen,
  );
  input.setSkillPickerOpen(
    (current) =>
      buildExclusiveComposerPickerToggleState("skill", current)
        .isSkillPickerOpen,
  );
}

/** Skill 一覧を閉じて Agent 一覧の開閉を反転する。 */
export function applyAgentPickerToggleCommand(input: {
  setAgentPickerOpen: (updater: (current: boolean) => boolean) => void;
  setSkillPickerOpen: (updater: (current: boolean) => boolean) => void;
}): void {
  applyExclusiveComposerPickerToggle({
    target: "agent",
    setAgentPickerOpen: input.setAgentPickerOpen,
    setSkillPickerOpen: input.setSkillPickerOpen,
  });
}

/** 入力欄の Agent ボタンから、排他的な一覧開閉を呼び出せるようにする。 */
export function createAgentPickerToggleHandler(input: {
  setAgentPickerOpen: (updater: (current: boolean) => boolean) => void;
  setSkillPickerOpen: (updater: (current: boolean) => boolean) => void;
}): () => void {
  return () => applyAgentPickerToggleCommand(input);
}

/** 既存状態にかかわらず Agent 一覧を閉じる。 */
export function applyAgentPickerCloseCommand(input: {
  setAgentPickerOpen: (open: boolean) => void;
}): void {
  input.setAgentPickerOpen(false);
}

/** 一覧の外側などから Agent 一覧を閉じる操作を作る。 */
export function createAgentPickerCloseHandler(input: {
  setAgentPickerOpen: (open: boolean) => void;
}): () => void {
  return () => applyAgentPickerCloseCommand(input);
}

/** Agent 一覧を閉じて Skill 一覧の開閉を反転する。 */
export function applySkillPickerToggleCommand(input: {
  setAgentPickerOpen: (updater: (current: boolean) => boolean) => void;
  setSkillPickerOpen: (updater: (current: boolean) => boolean) => void;
}): void {
  applyExclusiveComposerPickerToggle({
    target: "skill",
    setAgentPickerOpen: input.setAgentPickerOpen,
    setSkillPickerOpen: input.setSkillPickerOpen,
  });
}

/** 入力欄の Skill ボタンから、排他的な一覧開閉を呼び出せるようにする。 */
export function createSkillPickerToggleHandler(input: {
  setAgentPickerOpen: (updater: (current: boolean) => boolean) => void;
  setSkillPickerOpen: (updater: (current: boolean) => boolean) => void;
}): () => void {
  return () => applySkillPickerToggleCommand(input);
}

/** Skill 挿入結果のうち、ドック・キャレット・一覧の表示状態を反映する。 */
export function applySkillPromptInsertionUiState(input: {
  state: Pick<
    SkillPromptInsertionState,
    "caret" | "isActionDockPinnedExpanded" | "isSkillPickerOpen"
  >;
  setActionDockPinnedExpanded: (expanded: boolean) => void;
  setCaret: (caret: number) => void;
  setSkillPickerOpen: (open: boolean) => void;
}): void {
  input.setActionDockPinnedExpanded(input.state.isActionDockPinnedExpanded);
  input.setCaret(input.state.caret);
  input.setSkillPickerOpen(input.state.isSkillPickerOpen);
}

/** Skill 挿入の表示状態と下書きを反映してから、入力欄のフォーカスとキャレットを戻す。 */
export function applySkillPromptInsertionCommand(input: {
  state: SkillPromptInsertionState;
  textarea: HTMLTextAreaElement | null;
  setActionDockPinnedExpanded: (expanded: boolean) => void;
  setCaret: (caret: number) => void;
  setSkillPickerOpen: (open: boolean) => void;
  applyDraft: (draft: string, caret: number) => void;
  restoreComposerTextareaFocusAndCaret: (
    textarea: HTMLTextAreaElement | null,
    caret: number,
  ) => void;
}): void {
  applySkillPromptInsertionUiState({
    state: input.state,
    setActionDockPinnedExpanded: input.setActionDockPinnedExpanded,
    setCaret: input.setCaret,
    setSkillPickerOpen: input.setSkillPickerOpen,
  });
  input.applyDraft(input.state.draft, input.state.caret);
  input.restoreComposerTextareaFocusAndCaret(input.textarea, input.state.caret);
}

/** 選択時点の provider と下書きで Skill を挿入し、provider がなければ何もしない。 */
export function createSkillPromptInsertionHandler<
  TSkill extends { name: string; sourcePath?: string },
>(input: {
  getProvider: () => string | null | undefined;
  getDraft: () => string;
  getTextarea: () => HTMLTextAreaElement | null;
  setActionDockPinnedExpanded: (expanded: boolean) => void;
  setCaret: (caret: number) => void;
  setSkillPickerOpen: (open: boolean) => void;
  applyDraft: (draft: string, caret: number) => void;
  restoreComposerTextareaFocusAndCaret: (
    textarea: HTMLTextAreaElement | null,
    caret: number,
  ) => void;
}): (skill: TSkill) => void {
  return (skill) => {
    const provider = input.getProvider();
    if (provider == null) {
      return;
    }

    const nextState = buildSkillPromptInsertionState(
      provider,
      skill.name,
      input.getDraft(),
      skill.sourcePath,
    );
    applySkillPromptInsertionCommand({
      state: nextState,
      textarea: input.getTextarea(),
      setActionDockPinnedExpanded: input.setActionDockPinnedExpanded,
      setCaret: input.setCaret,
      setSkillPickerOpen: input.setSkillPickerOpen,
      applyDraft: input.applyDraft,
      restoreComposerTextareaFocusAndCaret:
        input.restoreComposerTextareaFocusAndCaret,
    });
  };
}

/** 追加ディレクトリ一覧の現在の開閉状態を反転する。 */
export function applyAdditionalDirectoryListToggle(input: {
  setAdditionalDirectoryListOpen: (
    updater: (current: boolean) => boolean,
  ) => void;
}): void {
  input.setAdditionalDirectoryListOpen((current) => !current);
}

/** 追加ディレクトリ一覧の表示切り替えに使うコールバックを作る。 */
export function createAdditionalDirectoryListToggleHandler(input: {
  setAdditionalDirectoryListOpen: (
    updater: (current: boolean) => boolean,
  ) => void;
}): () => void {
  return () => applyAdditionalDirectoryListToggle(input);
}

/** 選択があれば次回の開始ディレクトリを更新し、登録や一覧表示も対応する場合は行う。 */
export function applyPickedAdditionalDirectoryUiStateCommand(input: {
  selectedPath: string | null | undefined;
  setPickerBaseDirectory: (baseDirectory: string) => void;
  applyPickedDirectory?: (selectedPath: string) => void;
  setAdditionalDirectoryListOpen?: (open: boolean) => void;
}): boolean {
  if (!input.selectedPath) {
    return false;
  }

  input.setPickerBaseDirectory(input.selectedPath);
  input.applyPickedDirectory?.(input.selectedPath);
  input.setAdditionalDirectoryListOpen?.(true);
  return true;
}

/** 現在使用できる右ペインのタブだけを前後に循環する。 */
export function applyContextPaneTabCycleCommand(input: {
  direction: -1 | 1;
  availableTabs: ContextPaneTabKey[];
  setActiveTab: (
    value:
      ContextPaneTabKey | ((current: ContextPaneTabKey) => ContextPaneTabKey),
  ) => void;
}): void {
  input.setActiveTab((current) =>
    cycleContextPaneTab(current, input.direction, input.availableTabs),
  );
}

/** 右ペインの前後ボタンに、利用可能なタブ間の移動を結び付ける。 */
export function createContextPaneTabCycleHandler(input: {
  availableTabs: ContextPaneTabKey[];
  setActiveTab: (
    value:
      ContextPaneTabKey | ((current: ContextPaneTabKey) => ContextPaneTabKey),
  ) => void;
}): (direction: -1 | 1) => void {
  return (direction) =>
    applyContextPaneTabCycleCommand({
      direction,
      availableTabs: input.availableTabs,
      setActiveTab: input.setActiveTab,
    });
}

/** 現在のタブが使えなくなった場合だけ、先頭の候補か最新コマンドに戻す。 */
export function applyUnavailableContextPaneTabFallbackCommand(input: {
  activeTab: ContextPaneTabKey;
  availableTabs: ContextPaneTabKey[];
  setActiveTab: (value: ContextPaneTabKey) => void;
}): void {
  if (input.availableTabs.includes(input.activeTab)) {
    return;
  }

  input.setActiveTab(input.availableTabs[0] ?? "latest-command");
}

/** パスを確定したときは、選択種別に応じた開始ディレクトリを保存して参照を挿入する。 */
export function applyPickedComposerReferencePathCommand(input: {
  kind: ComposerPathPickerKind;
  selectedPath: string | null | undefined;
  setPickerBaseDirectory: (baseDirectory: string) => void;
  insertReferencePath: (
    selectedPath: string,
    kind: ComposerPathPickerKind,
  ) => void;
}): boolean {
  if (!input.selectedPath) {
    return false;
  }

  input.setPickerBaseDirectory(
    resolvePickedPathBaseDirectory(input.kind, input.selectedPath),
  );
  input.insertReferencePath(input.selectedPath, input.kind);
  return true;
}

/** 引用を挿入できる場合は下書きに反映し、入力欄のフォーカスとキャレットを戻す。 */
export function applyQuoteMessageTextCommand(input: {
  messageText: string;
  draft: string;
  fallbackCaret: number;
  textarea: HTMLTextAreaElement | null;
  applyInsertion: (insertion: { draft: string; caret: number }) => void;
  restoreComposerTextareaFocusAndCaret: (
    textarea: HTMLTextAreaElement | null,
    caret: number,
  ) => void;
}): boolean {
  const insertion = createQuotedMessageInsertionFromComposer({
    messageText: input.messageText,
    draft: input.draft,
    fallbackCaret: input.fallbackCaret,
    textarea: input.textarea,
  });
  if (!insertion) {
    return false;
  }

  input.applyInsertion(insertion);
  input.restoreComposerTextareaFocusAndCaret(input.textarea, insertion.caret);
  return true;
}

/** 入力がブロックされていれば通知し、可能な場合は操作時点の下書きに引用する。 */
export function createQuoteMessageTextHandler(input: {
  isBlocked: () => boolean;
  notifyBlocked: () => void;
  getComposerState: () => {
    draft: string;
    fallbackCaret: number;
    textarea: HTMLTextAreaElement | null;
  };
  applyInsertion: (insertion: { draft: string; caret: number }) => void;
  restoreComposerTextareaFocusAndCaret: (
    textarea: HTMLTextAreaElement | null,
    caret: number,
  ) => void;
}): (messageText: string) => boolean {
  return (messageText) => {
    if (input.isBlocked()) {
      input.notifyBlocked();
      return false;
    }

    const composerState = input.getComposerState();
    return applyQuoteMessageTextCommand({
      messageText,
      ...composerState,
      applyInsertion: input.applyInsertion,
      restoreComposerTextareaFocusAndCaret:
        input.restoreComposerTextareaFocusAndCaret,
    });
  };
}

/** 選択したパスから参照を作り、入力欄の選択開始位置へ挿入する。 */
export function applySelectedPathReferenceInsertionCommand(input: {
  draft: string;
  fallbackCaret: number;
  selectedPaths: string[];
  textarea: HTMLTextAreaElement | null;
  workspacePath: string | null;
  applyInsertion: (state: PathReferenceInsertionState) => void;
  restoreComposerTextareaFocusAndCaret: (
    textarea: HTMLTextAreaElement | null,
    caret: number,
  ) => void;
}): boolean {
  const insertionState = buildSelectedPathReferenceInsertionState({
    draft: input.draft,
    caret: input.textarea?.selectionStart ?? input.fallbackCaret,
    selectedPaths: input.selectedPaths,
    workspacePath: input.workspacePath,
  });
  if (!insertionState) {
    return false;
  }

  input.applyInsertion(insertionState);
  input.restoreComposerTextareaFocusAndCaret(
    input.textarea,
    insertionState.caret,
  );
  return true;
}

/** 構築済みの参照を下書きに追加し、成功時は挿入後の位置にフォーカスを戻す。 */
export function applyComposerReferenceInsertionCommand(input: {
  draft: string;
  fallbackCaret: number;
  references: ComposerReferenceInput[];
  textarea: HTMLTextAreaElement | null;
  applyInsertion: (state: PathReferenceInsertionState) => void;
  restoreComposerTextareaFocusAndCaret: (
    textarea: HTMLTextAreaElement | null,
    caret: number,
  ) => void;
}): boolean {
  const insertionState = buildComposerReferenceInsertionState(
    input.draft,
    input.textarea?.selectionStart ?? input.fallbackCaret,
    input.references,
  );
  if (!insertionState) {
    return false;
  }

  input.applyInsertion(insertionState);
  input.restoreComposerTextareaFocusAndCaret(
    input.textarea,
    insertionState.caret,
  );
  return true;
}

/** 参照が得られたときだけ、最初に選んだファイルのディレクトリを次回の初期位置にする。 */
export function applySessionFilesReferencePathsCommand(input: {
  selectedPaths: string[];
  referencePaths: string[];
  setPickerBaseDirectory: (baseDirectory: string) => void;
  insertReferencePaths: (referencePaths: string[]) => void;
}): boolean {
  const firstSelectedPath = input.selectedPaths[0];
  if (!firstSelectedPath || input.referencePaths.length === 0) {
    return false;
  }

  input.setPickerBaseDirectory(toDirectoryPath(firstSelectedPath));
  input.insertReferencePaths(input.referencePaths);
  return true;
}

/** 貼り付けで保存できた添付ファイルがあるときだけ、その参照を挿入する。 */
export function applyPastedSessionAttachmentPathsCommand(input: {
  savedPaths: string[];
  insertReferencePaths: (referencePaths: string[]) => void;
}): boolean {
  if (input.savedPaths.length === 0) {
    return false;
  }

  input.insertReferencePaths(input.savedPaths);
  return true;
}

/** 対象セッションのフォルダーを開き、失敗時は具体的なエラーまたは既定の説明を示す。 */
export async function runSessionFilesOpenCommand(input: {
  sessionId: string | null | undefined;
  openSessionFiles: (sessionId: string) => Promise<void>;
  alertError: (message: string) => void;
  fallbackErrorMessage: string;
}): Promise<boolean> {
  if (input.sessionId == null) {
    return false;
  }

  try {
    await input.openSessionFiles(input.sessionId);
    return true;
  } catch (error) {
    input.alertError(
      error instanceof Error ? error.message : input.fallbackErrorMessage,
    );
    return false;
  }
}

/** クリック時点の起動機能とセッションを取得し、利用できる場合だけフォルダーを開く。 */
export function createSessionFilesOpenHandler(input: {
  getSessionId: () => string | null | undefined;
  getOpenSessionFiles: () =>
    ((sessionId: string) => Promise<void>) | null | undefined;
  alertError: (message: string) => void;
  fallbackErrorMessage: string;
}): () => Promise<boolean> {
  return async () => {
    const openSessionFiles = input.getOpenSessionFiles();
    if (!openSessionFiles) {
      return false;
    }

    return runSessionFilesOpenCommand({
      sessionId: input.getSessionId(),
      openSessionFiles,
      alertError: input.alertError,
      fallbackErrorMessage: input.fallbackErrorMessage,
    });
  };
}
