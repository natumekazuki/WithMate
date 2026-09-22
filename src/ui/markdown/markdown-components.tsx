import type { Components } from "react-markdown";
import type { Node } from "unist";

import {
  resolveMarkdownFrontmatterDisplay,
  formatMarkdownFrontmatterSource,
} from "./markdown-frontmatter.js";
import { GlossaryAnnotationSpan } from "../../glossary/MessageGlossaryAnnotations.js";
import { MarkdownRenderContext } from "./markdown-context.js";
import { MarkdownPre } from "./markdown-code.js";
import { MarkdownLink } from "./markdown-links.js";
import { MarkdownImageComponent } from "./markdown-images.js";

function mergeClassName(baseClassName: string, className?: string) {
  return className ? `${baseClassName} ${className}` : baseClassName;
}
export const markdownComponents: Components = {
  h1: ({ children, className, node, ...props }) => (
    <h1
      {...props}
      className={mergeClassName("message-heading level-1", className)}
    >
      {children}
    </h1>
  ),
  h2: ({ children, className, node, ...props }) => (
    <h2
      {...props}
      className={mergeClassName("message-heading level-2", className)}
    >
      {children}
    </h2>
  ),
  h3: ({ children, className, node, ...props }) => (
    <h3
      {...props}
      className={mergeClassName("message-heading level-3", className)}
    >
      {children}
    </h3>
  ),
  h4: ({ children, className, node, ...props }) => (
    <h4
      {...props}
      className={mergeClassName("message-heading level-4", className)}
    >
      {children}
    </h4>
  ),
  h5: ({ children, className, node, ...props }) => (
    <h5
      {...props}
      className={mergeClassName("message-heading level-5", className)}
    >
      {children}
    </h5>
  ),
  h6: ({ children, className, node, ...props }) => (
    <h6
      {...props}
      className={mergeClassName("message-heading level-6", className)}
    >
      {children}
    </h6>
  ),
  hr: ({ className, node, ...props }) => (
    <hr {...props} className={mergeClassName("message-divider", className)} />
  ),
  p: ({ children, className, node, ...props }) => (
    <p {...props} className={mergeClassName("message-paragraph", className)}>
      {children}
    </p>
  ),
  ul: ({ children, className, node, ...props }) => (
    <ul {...props} className={mergeClassName("message-list", className)}>
      {children}
    </ul>
  ),
  ol: ({ children, className, node, ...props }) => (
    <ol
      {...props}
      className={mergeClassName("message-list ordered", className)}
    >
      {children}
    </ol>
  ),
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
  table: ({ children, className, node, ...props }) => (
    <table {...props} className={mergeClassName("message-table", className)}>
      {children}
    </table>
  ),
  th: ({ children, className, node, ...props }) => (
    <th
      {...props}
      className={mergeClassName("message-table-heading", className)}
    >
      {children}
    </th>
  ),
  td: ({ children, className, node, ...props }) => (
    <td {...props} className={mergeClassName("message-table-cell", className)}>
      {children}
    </td>
  ),
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
  a: MarkdownLink,
  img: MarkdownImageComponent,
};
export function renderMarkdownFrontmatter(_state: unknown, node: Node) {
  const value =
    "value" in node && typeof node.value === "string" ? node.value : "";
  const display = resolveMarkdownFrontmatterDisplay(value);
  if (display.kind === "table")
    return {
      type: "element" as const,
      tagName: "table",
      properties: {
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
    properties: { className: ["message-frontmatter-block"] },
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
