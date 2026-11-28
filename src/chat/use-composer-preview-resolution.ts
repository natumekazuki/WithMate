import type { ComposerPreview } from "../../src-shared/session/runtime-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

/** 対象 Session に固定された、入力本文の添付・検証プレビュー要求。 */
export type ComposerPreviewRequest = (
  message: string,
) => Promise<ComposerPreview>;
/** コンポーザーの入力内容をプレビューするために使う Window API の部分集合。 */
export type ComposerPreviewRequestApi = Pick<
  WithMateWindowApi,
  "previewComposerInput"
>;

/** API と対象 ID が揃う場合だけ、その Session 向けのプレビュー要求を作る。 */
export function createComposerPreviewRequest({
  api,
  sessionId,
}: {
  api: ComposerPreviewRequestApi | null | undefined;
  sessionId: string | null | undefined;
}): ComposerPreviewRequest | null {
  if (!api || !sessionId) {
    return null;
  }

  return (message: string) => api.previewComposerInput(sessionId, message);
}
