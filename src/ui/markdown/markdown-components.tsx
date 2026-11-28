import type { Components } from "react-markdown";
import type { Node } from "unist";

import {
  resolveMarkdownFrontmatterDisplay,
  formatMarkdownFrontmatterSource,
} from "../../../src-shared/text/markdown-frontmatter.js";
import { GlossaryAnnotationSpan } from "../../glossary/MessageGlossaryAnnotations.js";
import { MarkdownRenderContext } from "./markdown-context.js";
import { MarkdownPre } from "./markdown-code.js";
import { MarkdownAnchor } from "./markdown-artifacts.js";
import { MarkdownImageComponent } from "./markdown-images.js";
import { markdownSourceAttributes } from "./markdown-source-ranges.js";

/** 表示の基底クラスに構文変換から受け取った既存クラスを追加する。 */
function mergeClassName(baseClassName: string, className?: string) {
  return className ? `${baseClassName} ${className}` : baseClassName;
}
/** 構文から得た意味要素を保ち、会話表示のスタイルやリンク・画像などの専用部品を割り当てる。 */
export const markdownComponents: Components = {
  /** 最上位の見出しをh1のまま描画し、会話表示のレベル1クラスを付ける。 */
  h1: ({ children, className, node, ...props }) => (
    <h1
      {...props}
      className={mergeClassName("message-heading level-1", className)}
    >
      {children}
    </h1>
  ),
  /** h2の階層と原文由来の属性を保ち、レベル2の装飾を適用する。 */
  h2: ({ children, className, node, ...props }) => (
    <h2
      {...props}
      className={mergeClassName("message-heading level-2", className)}
    >
      {children}
    </h2>
  ),
  /** 第3階層の見出しを段落へ落とさず、h3のまま装飾する。 */
  h3: ({ children, className, node, ...props }) => (
    <h3
      {...props}
      className={mergeClassName("message-heading level-3", className)}
    >
      {children}
    </h3>
  ),
  /** 第4階層の識別を要素名とスタイルクラスの双方に残す。 */
  h4: ({ children, className, node, ...props }) => (
    <h4
      {...props}
      className={mergeClassName("message-heading level-4", className)}
    >
      {children}
    </h4>
  ),
  /** h5を会話の見出しスタイルで表示し、パース済みの子要素をそのまま残す。 */
  h5: ({ children, className, node, ...props }) => (
    <h5
      {...props}
      className={mergeClassName("message-heading level-5", className)}
    >
      {children}
    </h5>
  ),
  /** 最深の見出しもh6の意味を維持し、レベル6のクラスを付ける。 */
  h6: ({ children, className, node, ...props }) => (
    <h6
      {...props}
      className={mergeClassName("message-heading level-6", className)}
    >
      {children}
    </h6>
  ),
  /** テーマ区切りを装飾用の要素に置き換えず、意味のある水平線として描画する。 */
  hr: ({ className, node, ...props }) => (
    <hr {...props} className={mergeClassName("message-divider", className)} />
  ),
  /** 段落内のインライン要素を保持したまま、会話本文の段落スタイルを適用する。 */
  p: ({ children, className, node, ...props }) => (
    <p {...props} className={mergeClassName("message-paragraph", className)}>
      {children}
    </p>
  ),
  /** 箇条書きの親要素を保持し、入れ子の項目にも通常のリスト構造を使う。 */
  ul: ({ children, className, node, ...props }) => (
    <ul {...props} className={mergeClassName("message-list", className)}>
      {children}
    </ul>
  ),
  /** 開始番号などをolへ引き継ぎ、順序付きリスト向けのマーカーの余白を適用する。 */
  ol: ({ children, className, node, ...props }) => (
    <ol
      {...props}
      className={mergeClassName("message-list ordered", className)}
    >
      {children}
    </ol>
  ),
  /** コード要素のクラスを追加し、文字列として渡された本文の末尾改行を1つだけ除く。 */
  code: ({ children, className, node, ...props }) => (
    <code
      {...props}
      className={mergeClassName("message-inline-code", className)}
    >
      {typeof children === "string" && children.endsWith("\n")
        ? children.slice(0, -1)
        : children}
    </code>
  ),
  /** GFM表の行・セル構造を維持して表全体の装飾を適用する。 */
  table: ({ children, className, node, ...props }) => (
    <table {...props} className={mergeClassName("message-table", className)}>
      {children}
    </table>
  ),
  /** 見出しセルの意味を保ち、パーサー由来の配置指定をthへ渡す。 */
  th: ({ children, className, node, ...props }) => (
    <th
      {...props}
      className={mergeClassName("message-table-heading", className)}
    >
      {children}
    </th>
  ),
  /** 本文セルの配置指定を保持し、表見出しとは別の装飾を付ける。 */
  td: ({ children, className, node, ...props }) => (
    <td {...props} className={mergeClassName("message-table-cell", className)}>
      {children}
    </td>
  ),
  /** 強い強調をstrongで表し、子のリンクやコードを通常テキストに潰さない。 */
  strong: ({ children, className, node, ...props }) => (
    <strong
      {...props}
      className={mergeClassName("message-inline-strong", className)}
    >
      {children}
    </strong>
  ),
  span: GlossaryAnnotationSpan,
  pre: MarkdownPre,
  a: MarkdownAnchor,
  img: MarkdownImageComponent,
};
/** frontmatterをキー・値の表またはYAMLコード表示へ変換し、外側の要素に原文検索範囲を付ける。 */
export function renderMarkdownFrontmatter(_state: unknown, node: Node) {
  const value =
    "value" in node && typeof node.value === "string" ? node.value : "";
  const display = resolveMarkdownFrontmatterDisplay(value);
  if (display.kind === "table")
    return {
      type: "element" as const,
      tagName: "table",
      properties: {
        ...markdownSourceAttributes(node),
        className: ["message-frontmatter-table"],
        "aria-label": "YAML frontmatter",
      },
      children: [
        {
          type: "element" as const,
          tagName: "tbody",
          properties: {},
          children: display.rows.map((row) => ({
            type: "element" as const,
            tagName: "tr",
            properties: {},
            children: [
              {
                type: "element" as const,
                tagName: "th",
                properties: { scope: "row" },
                children: [{ type: "text" as const, value: row.key }],
              },
              {
                type: "element" as const,
                tagName: "td",
                properties: {},
                children: [{ type: "text" as const, value: row.value }],
              },
            ],
          })),
        },
      ],
    };
  return {
    type: "element" as const,
    tagName: "pre",
    properties: {
      className: ["message-frontmatter-block"],
      ...markdownSourceAttributes(node),
    },
    children: [
      {
        type: "element" as const,
        tagName: "code",
        properties: {
          className: ["message-frontmatter-code", "language-yaml"],
        },
        children: [
          {
            type: "text" as const,
            value: formatMarkdownFrontmatterSource(value),
          },
        ],
      },
    ],
  };
}
