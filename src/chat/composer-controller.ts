import {
  useCallback,
  useMemo,
  useSyncExternalStore,
  type SetStateAction,
} from "react";

import type { ComposerPreview } from "../../src-shared/session/runtime-state.js";
import type { SessionReply } from "../../src-shared/session/session-reply.js";
import { createEmptyComposerPreview } from "./composer/composer-preview-config.js";

/** 下書きを分離する単位。メイン・補助セッションと待機中メッセージの編集を区別する。 */
export type ComposerOwnerKind = "main" | "auxiliary" | "queue-edit";
/** レジストリー内で編集対象を特定する種別、ID、および任意のフレーム識別子。 */
export type ComposerOwner = Readonly<{
  kind: ComposerOwnerKind;
  id: string;
  frameKey?: string;
}>;
/** 下書き内の選択範囲。開始と終了が同じならキャレット位置を表す。 */
export type ComposerSelection = Readonly<{ start: number; end: number }>;
/** 下書きの保存表示を切り替える進行・成功・失敗状態。 */
export type ComposerSaveState = "idle" | "saving" | "saved" | "error";
/** 下書きに付く返信先の識別子と、解決できた参照または失敗理由。 */
export type ComposerDraftReply = Readonly<{
  key: string;
  reference?: SessionReply;
  error?: string;
}>;

/** 編集対象ごとに購読できる下書きの状態。本文に加え、送信版の照合と入力表示に必要な値を持つ。 */
export type ComposerControllerState = {
  owner: ComposerOwner;
  draft: string;
  reply?: ComposerDraftReply;
  revision: number;
  selection: ComposerSelection;
  isImeComposing: boolean;
  preview: ComposerPreview;
  saveState: ComposerSaveState;
  saveError: string | null;
};

/** 送信受付や失敗復元で、取得後に下書きが編集されたか照合するための控え。 */
export type ComposerDraftCapture = Pick<
  ComposerControllerState,
  "owner" | "draft" | "revision"
>;

/** 対象のスナップショットが更新されたことを購読側へ知らせる。 */
type Listener = () => void;
/** 編集状態と、その編集対象を監視する購読者の集合。 */
type Entry = ComposerControllerState & {
  listeners: Set<Listener>;
};

/** 種別、ID、フレームをひと組のキーにして、別の編集対象と混同しないようにする。 */
function ownerKey(owner: ComposerOwner): string {
  return JSON.stringify([owner.kind, owner.id, owner.frameKey]);
}

/** 選択範囲を新しい本文内に収め、終了位置が開始位置を下回らないようにする。 */
function clampSelection(
  selection: ComposerSelection,
  draft: string,
): ComposerSelection {
  const max = draft.length;
  const start = Math.max(0, Math.min(max, selection.start));
  const end = Math.max(start, Math.min(max, selection.end));
  return { start, end };
}

/** 編集対象別の状態と購読を管理し、終了時の編集凍結と送信版の照合を担う。 */
export class ComposerControllerRegistry {
  private readonly entries = new Map<string, Entry>();
  private frozen = false;

  /** 終了処理などで通常の入力更新を凍結しているかを返す。 */
  get isFrozen(): boolean {
    return this.frozen;
  }
  /** 通常の入力更新を凍結し、未凍結から切り替わった場合に全購読先へ知らせる。 */
  freeze(): void {
    if (this.frozen) return;
    this.frozen = true;
    this.notifyEntries();
  }
  /** 通常の入力更新を再開し、凍結から切り替わった場合に全購読先へ知らせる。 */
  unfreeze(): void {
    if (!this.frozen) return;
    this.frozen = false;
    this.notifyEntries();
  }

  /** 全対象のスナップショットを作り直し、凍結状態の変化を購読側で検出できるようにする。 */
  private notifyEntries(): void {
    this.entries.forEach((current, key) => {
      const entry: Entry = { ...current, listeners: current.listeners };
      this.entries.set(key, entry);
      entry.listeners.forEach((listener) => listener());
    });
  }

  /** 現在の編集状態を返し、対象が未登録の場合だけ初期下書きの末尾にキャレットを置いて登録する。 */
  get(owner: ComposerOwner, initialDraft = ""): ComposerControllerState {
    const key = ownerKey(owner);
    const existing = this.entries.get(key);
    if (existing) {
      return existing;
    }
    const entry: Entry = {
      owner,
      draft: initialDraft,
      revision: 0,
      selection: { start: initialDraft.length, end: initialDraft.length },
      isImeComposing: false,
      preview: createEmptyComposerPreview(),
      saveState: "idle",
      saveError: null,
      listeners: new Set(),
    };
    this.entries.set(key, entry);
    return entry;
  }

  /** 一度も編集されていない下書きだけを読み込み値で補い、適用した場合に通知する。 */
  hydrateIfUnedited(owner: ComposerOwner, draft: string): boolean {
    const current = this.get(owner);
    if (current.revision !== 0 || current.draft === draft) return false;
    const currentEntry = this.entries.get(ownerKey(owner)) as Entry;
    const entry: Entry = { ...currentEntry, listeners: currentEntry.listeners };
    entry.draft = draft;
    entry.selection = { start: draft.length, end: draft.length };
    entry.preview = createEmptyComposerPreview();
    this.entries.set(ownerKey(owner), entry);
    entry.listeners.forEach((listener) => listener());
    return true;
  }

  /** 指定対象の更新を購読し、同じ購読を解除する関数を返す。 */
  subscribe(
    owner: ComposerOwner,
    listener: Listener,
    initialDraft = "",
  ): () => void {
    const entry = this.get(owner, initialDraft) as Entry;
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  /** 購読者の集合を保ったままスナップショットを複製し、適用後の状態を通知する。 */
  private update(owner: ComposerOwner, updater: (entry: Entry) => void): void {
    const current = this.get(owner) as Entry;
    const entry: Entry = { ...current, listeners: current.listeners };
    updater(entry);
    this.entries.set(ownerKey(owner), entry);
    entry.listeners.forEach((listener) => listener());
  }

  /** 凍結条件と差分を確認し、下書きが変わる場合に版を進めてプレビューと保存表示を初期化する。 */
  private setDraftInternal(
    owner: ComposerOwner,
    draft: string,
    selection?: ComposerSelection,
    allowWhileFrozen = false,
    clearReply = false,
  ): number {
    const current = this.get(owner);
    if (this.frozen && !allowWhileFrozen) return current.revision;
    const nextSelection = clampSelection(selection ?? current.selection, draft);
    if (
      current.draft === draft &&
      current.selection.start === nextSelection.start &&
      current.selection.end === nextSelection.end &&
      !(clearReply && current.reply)
    ) {
      return current.revision;
    }
    let revision = 0;
    this.update(owner, (entry) => {
      entry.draft = draft;
      if (clearReply) entry.reply = undefined;
      entry.revision += 1;
      entry.selection = nextSelection;
      entry.preview = createEmptyComposerPreview();
      entry.saveState = "idle";
      entry.saveError = null;
      revision = entry.revision;
    });
    return revision;
  }

  /** 本文と指定された選択範囲を更新し、変更後または変更不要時の現在版を返す。 */
  setDraft(
    owner: ComposerOwner,
    draft: string,
    selection?: ComposerSelection,
  ): number {
    return this.setDraftInternal(owner, draft, selection);
  }

  /** 編集中の下書きを別の本文で置き換え、通常の入力と同じ凍結・版管理に従う。 */
  replaceDraft(
    owner: ComposerOwner,
    draft: string,
    selection?: ComposerSelection,
  ): number {
    return this.setDraft(owner, draft, selection);
  }

  /** 通常の編集として本文と選択を空にする。返信先はここでは消さない。 */
  clearDraft(owner: ComposerOwner): number {
    return this.setDraft(owner, "", { start: 0, end: 0 });
  }

  /** 送信受付と同じ版なら凍結中でも下書きと返信先を消費し、後続編集があれば空値を返す。 */
  clearIfRevision(
    owner: ComposerOwner,
    expectedRevision: number,
  ): number | null {
    if (this.get(owner).revision !== expectedRevision) return null;
    // 終了処理中も、受付済みの送信は取得時のリビジョンを消費する。
    return this.setDraftInternal(owner, "", { start: 0, end: 0 }, true, true);
  }

  /** 返信先を明示的に編集すると、インラインの添付参照と同じく下書きの版に反映される。 */
  setReply(owner: ComposerOwner, reply: ComposerDraftReply | undefined): void {
    if (this.frozen || this.get(owner).reply === reply) return;
    this.update(owner, (entry) => {
      entry.reply = reply;
      entry.revision += 1;
    });
  }

  /** 同じ未解決の返信先が残っているときだけ、版を進めず解決結果へ差し替える。 */
  resolveReply(
    owner: ComposerOwner,
    pending: ComposerDraftReply,
    resolved: ComposerDraftReply,
  ): void {
    if (this.get(owner).reply !== pending) return;
    this.update(owner, (entry) => {
      entry.reply = resolved;
    });
  }

  /** 指定版がまだ現行の場合だけ失敗時の本文を復元する。凍結中も許可し、版違いなら空値を返す。 */
  restoreIfRevision(
    owner: ComposerOwner,
    expectedRevision: number,
    update: (currentDraft: string) => string,
  ): number | null {
    const current = this.get(owner);
    if (current.revision !== expectedRevision) return null;
    // 失敗からの復元は内部更新であり、終了処理でユーザーの編集を凍結した後も
    // 取得済みの下書きを復元できなければならない。
    return this.setDraftInternal(
      owner,
      update(current.draft),
      current.selection,
      true,
    );
  }

  /** 凍結されていなければ選択範囲を本文内に収めて更新し、本文の版は進めない。 */
  setSelection(
    owner: ComposerOwner,
    selection: SetStateAction<ComposerSelection>,
  ): void {
    if (this.frozen) return;
    const current = this.get(owner);
    const next =
      typeof selection === "function"
        ? selection(current.selection)
        : selection;
    const clamped = clampSelection(next, current.draft);
    if (
      current.selection.start === clamped.start &&
      current.selection.end === clamped.end
    )
      return;
    this.update(owner, (entry) => {
      entry.selection = clamped;
    });
  }

  /** 凍結されていなければIME変換中の状態を切り替え、変化がある場合だけ通知する。 */
  setImeComposing(owner: ComposerOwner, isImeComposing: boolean): void {
    if (this.frozen) return;
    if (this.get(owner).isImeComposing === isImeComposing) return;
    this.update(owner, (entry) => {
      entry.isImeComposing = isImeComposing;
    });
  }

  /** 凍結されていなければプレビューを更新し、同じ参照を返した更新は通知しない。 */
  setPreview(
    owner: ComposerOwner,
    preview: SetStateAction<ComposerPreview>,
  ): void {
    if (this.frozen) return;
    const current = this.get(owner);
    const next =
      typeof preview === "function" ? preview(current.preview) : preview;
    if (Object.is(current.preview, next)) return;
    this.update(owner, (entry) => {
      entry.preview = next;
    });
  }

  /** 対象の保存状態とエラーを反映する。凍結中も完了・失敗などの通知は受け付ける。 */
  setSaveState(
    owner: ComposerOwner,
    saveState: ComposerSaveState,
    saveError: string | null = null,
  ): void {
    const current = this.get(owner);
    if (current.saveState === saveState && current.saveError === saveError)
      return;
    this.update(owner, (entry) => {
      entry.saveState = saveState;
      entry.saveError = saveError;
    });
  }

  /** 現時点の送信対象、本文、版だけを控えとして返す。 */
  capture(owner: ComposerOwner): ComposerDraftCapture {
    const entry = this.get(owner);
    return { owner: entry.owner, draft: entry.draft, revision: entry.revision };
  }

  /** レジストリーから指定対象を除き、次回の読み出しで再初期化できるようにする。 */
  discardOwner(owner: ComposerOwner): void {
    this.entries.delete(ownerKey(owner));
  }

  /** 本文を変えずに空のプレビューへ戻す。通常のプレビュー更新と同じく凍結に従う。 */
  resetPreview(owner: ComposerOwner): void {
    this.setPreview(owner, createEmptyComposerPreview());
  }
}

/** 入力欄間で編集対象ごとの状態を共有する、レンダラー既定のレジストリー。 */
export const composerControllerRegistry = new ComposerControllerRegistry();

/** 指定対象の編集状態をReactで購読し、対象を束縛した更新操作とともに返す。 */
export function useComposerController(
  owner: ComposerOwner,
  initialDraft = "",
  registry: ComposerControllerRegistry = composerControllerRegistry,
) {
  const key = ownerKey(owner);
  const subscribe = useCallback(
    (listener: Listener) => registry.subscribe(owner, listener, initialDraft),
    [key, owner, initialDraft, registry],
  );
  const getSnapshot = useCallback(
    () => registry.get(owner, initialDraft),
    [key, owner, initialDraft, registry],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(
    () => ({
      ...state,
      /** 現在の対象の下書きと、指定された選択範囲を更新する。 */
      setDraft: (draft: string, selection?: ComposerSelection) =>
        registry.setDraft(owner, draft, selection),
      /** 現在の対象の本文を、新しい下書きと任意の選択範囲で置き換える。 */
      replaceDraft: (draft: string, selection?: ComposerSelection) =>
        registry.replaceDraft(owner, draft, selection),
      /** 現在の対象の本文を空にし、キャレット位置を先頭に戻す。 */
      clearDraft: () => registry.clearDraft(owner),
      /** 現在の対象のキャレットまたは選択範囲を反映する。 */
      setSelection: (selection: SetStateAction<ComposerSelection>) =>
        registry.setSelection(owner, selection),
      /** 現在の対象にIME変換の開始または終了を記録する。 */
      setImeComposing: (value: boolean) =>
        registry.setImeComposing(owner, value),
      /** 現在の対象の下書きに対応するプレビュー状態を反映する。 */
      setPreview: (preview: SetStateAction<ComposerPreview>) =>
        registry.setPreview(owner, preview),
      /** 現在の対象へ保存の進行状況と任意のエラーを反映する。 */
      setSaveState: (value: ComposerSaveState, error?: string | null) =>
        registry.setSaveState(owner, value, error),
      /** 現在の対象から、送信後の照合に使う本文と版を取得する。 */
      capture: () => registry.capture(owner),
    }),
    [owner, registry, state],
  );
}
