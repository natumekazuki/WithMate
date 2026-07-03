import type { ComposerPreview } from "./app-state.js";

export function createEmptyComposerPreview(): ComposerPreview {
  return { attachments: [], errors: [] };
}
