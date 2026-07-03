import type { ComposerPreview } from "../app-state.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";

export type ComposerPreviewRequest = (message: string) => Promise<ComposerPreview>;
export type ComposerPreviewRequestMode = "session" | "companion";
export type ComposerPreviewRequestApi = Pick<WithMateWindowApi, "previewComposerInput" | "previewCompanionComposerInput">;

export function createComposerPreviewRequest({
  api,
  mode,
  sessionId,
}: {
  api: ComposerPreviewRequestApi | null | undefined;
  mode: ComposerPreviewRequestMode;
  sessionId: string | null | undefined;
}): ComposerPreviewRequest | null {
  if (!api || !sessionId) {
    return null;
  }

  return mode === "companion"
    ? (message: string) => api.previewCompanionComposerInput(sessionId, message)
    : (message: string) => api.previewComposerInput(sessionId, message);
}
