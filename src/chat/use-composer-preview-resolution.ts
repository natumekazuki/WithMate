import type { ComposerPreview } from "../app-state.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";

export type ComposerPreviewRequest = (message: string) => Promise<ComposerPreview>;
export type ComposerPreviewRequestApi = Pick<WithMateWindowApi, "previewComposerInput">;

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
