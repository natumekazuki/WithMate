import { useEffect } from "react";

import type { ComposerPreview } from "../app-state.js";
import {
  COMPOSER_PREVIEW_DEBOUNCE_MS,
  COMPOSER_PREVIEW_PATH_EDIT_DEBOUNCE_MS,
  createEmptyComposerPreview,
} from "../composer-preview-config.js";
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

export function useComposerPreviewResolution(input: {
  hasPreviewPathReferenceCandidates: boolean;
  isComposerImeComposing: boolean;
  isEditingPathReference: boolean;
  isPreviewBlocked: boolean;
  onComposerPreviewChange: (preview: ComposerPreview) => void;
  previewPathReferenceSignature: string;
  previewRequest: ComposerPreviewRequest | null;
  previewUserMessage: string;
}): void {
  useEffect(() => {
    let active = true;
    if (input.isPreviewBlocked || !input.previewRequest) {
      input.onComposerPreviewChange(createEmptyComposerPreview());
      return () => {
        active = false;
      };
    }

    if (!input.hasPreviewPathReferenceCandidates) {
      input.onComposerPreviewChange(createEmptyComposerPreview());
      return () => {
        active = false;
      };
    }

    if (input.isComposerImeComposing) {
      return () => {
        active = false;
      };
    }

    const previewRequest = input.previewRequest;
    const timeoutId = window.setTimeout(() => {
      void previewRequest(input.previewUserMessage).then((preview) => {
        if (active) {
          input.onComposerPreviewChange(preview);
        }
      }).catch((error) => {
        if (active) {
          input.onComposerPreviewChange({
            attachments: [],
            errors: [error instanceof Error ? error.message : "添付の解決に失敗したよ。"],
          });
        }
      });
    }, input.isEditingPathReference ? COMPOSER_PREVIEW_PATH_EDIT_DEBOUNCE_MS : COMPOSER_PREVIEW_DEBOUNCE_MS);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [
    input.hasPreviewPathReferenceCandidates,
    input.isComposerImeComposing,
    input.isEditingPathReference,
    input.isPreviewBlocked,
    input.onComposerPreviewChange,
    input.previewPathReferenceSignature,
    input.previewRequest,
    input.previewUserMessage,
  ]);
}
