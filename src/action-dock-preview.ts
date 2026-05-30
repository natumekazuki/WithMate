export interface ActionDockCompactPreviewOptions {
  maxLength?: number;
  truncationSuffix?: string;
}

const DEFAULT_MAX_LENGTH = 84;
const DEFAULT_TRUNCATION_SUFFIX = "…";
const RUNNING_PREVIEW = "実行中";
const EMPTY_PREVIEW = "下書きなし";

export function buildActionDockCompactPreview(
  draft: string,
  isRunning: boolean,
  options: ActionDockCompactPreviewOptions = {},
): string {
  const normalizedDraft = draft.replace(/\s+/g, " ").trim();

  if (normalizedDraft) {
    const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
    const truncationSuffix = options.truncationSuffix ?? DEFAULT_TRUNCATION_SUFFIX;

    if (normalizedDraft.length > maxLength) {
      return `${normalizedDraft.slice(0, maxLength)}${truncationSuffix}`;
    }

    return normalizedDraft;
  }

  if (isRunning) {
    return RUNNING_PREVIEW;
  }

  return EMPTY_PREVIEW;
}
