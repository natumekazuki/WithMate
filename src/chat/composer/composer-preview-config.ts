import type { ComposerPreview } from "../../../src-shared/session/runtime-state.js";
export function createEmptyComposerPreview(): ComposerPreview {
  return { attachments: [], errors: [] };
}
