import type { ComposerPreview } from "./app-state.js";
import {
  resolveMicrocopy,
  type MicrocopyCatalog,
} from "./microcopy-state.js";

const TEXT_PATH_NOT_FOUND_ERROR_PATTERN = /^@ のパスが見つからないよ: (.+)$/;

export function createEmptyComposerPreview(): ComposerPreview {
  return { attachments: [], errors: [] };
}

export function resolveComposerPreviewDisplayErrors(
  errors: string[],
  userMicrocopyCatalog: MicrocopyCatalog | null | undefined,
): string[] {
  return errors.map((error) => {
    const pathNotFoundMatch = error.match(TEXT_PATH_NOT_FOUND_ERROR_PATTERN);
    if (pathNotFoundMatch) {
      return resolveMicrocopy({
        slot: "composer.error.path_not_found",
        userCatalog: userMicrocopyCatalog,
        seedParts: [pathNotFoundMatch[1]],
        replacements: {
          path: pathNotFoundMatch[1],
        },
      });
    }

    return error;
  });
}

export function resolveComposerPreviewDisplay(
  preview: ComposerPreview,
  userMicrocopyCatalog: MicrocopyCatalog | null | undefined,
): ComposerPreview {
  return {
    ...preview,
    errors: resolveComposerPreviewDisplayErrors(preview.errors, userMicrocopyCatalog),
  };
}
