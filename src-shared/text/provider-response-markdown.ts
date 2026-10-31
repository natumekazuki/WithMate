import type { Root } from "mdast";
import type { Plugin } from "unified";
import type {} from "remark-parse";

import { codexFileReferencesFromMarkdown, codexFileReferencesSyntax } from "./codex-file-references.js";

export function providerResponseMarkdownExtensions(provider?: string) {
  if (provider === "codex") {
    return {
      extensions: [codexFileReferencesSyntax()],
      mdastExtensions: [codexFileReferencesFromMarkdown()],
    };
  }
  return { extensions: [], mdastExtensions: [] };
}

export const remarkProviderResponse: Plugin<[string?], Root> = function (provider) {
  const data = this.data();
  const extensions = providerResponseMarkdownExtensions(provider);
  (data.micromarkExtensions ??= []).push(...extensions.extensions);
  (data.fromMarkdownExtensions ??= []).push(...extensions.mdastExtensions);
};
