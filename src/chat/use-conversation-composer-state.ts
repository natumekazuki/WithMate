import { useCallback, useRef, useState, type SetStateAction } from "react";

import type { ComposerPreview } from "../../src-shared/session/runtime-state.js";
import { createEmptyComposerPreview } from "./composer/composer-preview-config.js";

/** コンポーザー入力欄で保持する選択範囲の開始・終了位置。 */
type ComposerSelection = { start: number; end: number };
/** 会話の所有元ごとに保持する下書き、対応するプレビュー、入力欄の選択範囲。 */
type ConversationComposerState = {
  draft: string;
  preview: ComposerPreview;
  selection: ComposerSelection;
};

/** 選択範囲を会話ごとに保持し、本文が変わった場合は以前のプレビューを消して遅い応答も無視する。 */
export function useConversationComposerState(
  ownerId: string | null,
  draft: string,
) {
  const states = useRef(new Map<string | null, ConversationComposerState>());
  const displayedOwner = useRef(ownerId);
  displayedOwner.current = ownerId;
  const [, refresh] = useState(0);
  let state = states.current.get(ownerId);
  if (!state) {
    state = {
      draft,
      preview: createEmptyComposerPreview(),
      selection: { start: 0, end: 0 },
    };
    states.current.set(ownerId, state);
  } else if (state.draft !== draft) {
    state.draft = draft;
    state.preview = createEmptyComposerPreview();
  }
  const setPreview = useCallback(
    (update: SetStateAction<ComposerPreview>) => {
      const current = states.current.get(ownerId);
      if (!current || current.draft !== draft) return;
      current.preview =
        typeof update === "function" ? update(current.preview) : update;
      if (displayedOwner.current === ownerId)
        refresh((revision) => revision + 1);
    },
    [ownerId, draft],
  );
  const setSelection = useCallback(
    (update: SetStateAction<ComposerSelection>) => {
      const current = states.current.get(ownerId);
      if (!current) return;
      current.selection =
        typeof update === "function" ? update(current.selection) : update;
      if (displayedOwner.current === ownerId)
        refresh((revision) => revision + 1);
    },
    [ownerId],
  );
  return {
    preview: state.preview,
    setPreview,
    selection: state.selection,
    setSelection,
  };
}
