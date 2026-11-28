import type { ComposerPreview } from "../../../src-shared/session/runtime-state.js";
/** 新しい下書きに使う、添付候補も検証エラーもないプレビューを作る。 */
export function createEmptyComposerPreview(): ComposerPreview {
  return { attachments: [], errors: [] };
}
