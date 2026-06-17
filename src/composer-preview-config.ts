import type { ComposerPreview } from "./app-state.js";

export function createEmptyComposerPreview(): ComposerPreview {
  return { attachments: [], errors: [] };
}

export const COMPOSER_PREVIEW_DEBOUNCE_MS = 120;
export const COMPOSER_PREVIEW_PATH_EDIT_DEBOUNCE_MS = 280;
export const WORKSPACE_PATH_QUERY_MIN_LENGTH = 2;
export const WORKSPACE_PATH_SEARCH_DEBOUNCE_MS = 100;
