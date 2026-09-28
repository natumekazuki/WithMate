import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { useSessionFilesFeature } from "./use-session-files-feature.js";

export type SessionFilesFeatureHandle = {
  closePreviews: () => void;
};

export type SessionFilesFeatureProps = {
  api: WithMateWindowApi | null;
  activeRunSessionId: string | null;
  prepareCentralSurfaceOpen: () => boolean;
  workspacePath: string | null;
  additionalDirectories: readonly string[];
  enabled: boolean;
  paneHost: HTMLElement | null;
  previewHost: HTMLElement | null;
  composer: {
    canInsertPathReference: boolean;
    insertReferencePaths: (paths: string[]) => void;
  };
  previewBindings: {
    onBack: () => void;
    onCopyText: (text: string) => void;
    onQuoteText: (text: string) => void;
    chatNotice: string;
  };
  previewEnabled: boolean;
  onPreviewActiveChange: (active: boolean) => void;
};

export const SessionFilesFeature = forwardRef<SessionFilesFeatureHandle, SessionFilesFeatureProps>(function SessionFilesFeature({
  paneHost,
  previewHost,
  composer,
  previewBindings,
  previewEnabled,
  onPreviewActiveChange,
  ...input
}, ref) {
  const feature = useSessionFilesFeature(input);
  const onPreviewActiveChangeRef = useRef(onPreviewActiveChange);
  onPreviewActiveChangeRef.current = onPreviewActiveChange;

  useImperativeHandle(ref, () => ({ closePreviews: feature.closeFilePreviews }), [feature.closeFilePreviews]);
  useLayoutEffect(() => {
    onPreviewActiveChangeRef.current(feature.isPreviewActive);
  }, [feature.isPreviewActive]);

  return <>
    {paneHost && createPortal(feature.renderPane(composer), paneHost)}
    {previewHost && previewEnabled && createPortal(feature.renderPreview(previewBindings), previewHost)}
  </>;
});
