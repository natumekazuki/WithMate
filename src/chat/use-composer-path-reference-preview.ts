import { useMemo } from "react";

import { buildTextReferenceCandidateState } from "../path-reference.js";
import { buildComposerPathReferencePreviewState } from "../session-composer-paths.js";

export function useComposerPathReferencePreview(input: {
  caret: number;
  draft: string;
  isEnabled: boolean;
}): ReturnType<typeof buildComposerPathReferencePreviewState> & {
  hasPreviewPathReferenceCandidates: boolean;
  previewPathReferenceCandidates: ReturnType<typeof buildTextReferenceCandidateState>["candidates"];
  previewPathReferenceSignature: string;
} {
  const pathReferencePreview = useMemo(
    () => buildComposerPathReferencePreviewState(input),
    [input.caret, input.draft, input.isEnabled],
  );
  const previewPathReferenceCandidateState = useMemo(
    () => buildTextReferenceCandidateState(pathReferencePreview.previewDraft),
    [pathReferencePreview.previewDraft],
  );

  return {
    ...pathReferencePreview,
    previewPathReferenceCandidates: previewPathReferenceCandidateState.candidates,
    hasPreviewPathReferenceCandidates: previewPathReferenceCandidateState.hasCandidates,
    previewPathReferenceSignature: previewPathReferenceCandidateState.signature,
  };
}
