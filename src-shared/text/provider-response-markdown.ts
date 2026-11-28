import type { Root } from "mdast";
import type { Plugin } from "unified";
import type {} from "remark-parse";

import {
  codexFileReferencesFromMarkdown,
  codexFileReferencesSyntax,
} from "./codex-file-references.js";

/** Codexにだけ固有のファイル参照構文を使わせるため、対応する二種類のMarkdown拡張を選ぶ。 */
export function providerResponseMarkdownExtensions(provider?: string) {
  if (provider === "codex") {
    return {
      extensions: [codexFileReferencesSyntax()],
      mdastExtensions: [codexFileReferencesFromMarkdown()],
    };
  }
  return { extensions: [], mdastExtensions: [] };
}

/** remarkに処理系固有の拡張を追加し、呼び出し元が登録済みの拡張は残す。 */
export const remarkProviderResponse: Plugin<[string?], Root> = function (
  provider,
) {
  const data = this.data();
  const extensions = providerResponseMarkdownExtensions(provider);
  (data.micromarkExtensions ??= []).push(...extensions.extensions);
  (data.fromMarkdownExtensions ??= []).push(...extensions.mdastExtensions);
};
