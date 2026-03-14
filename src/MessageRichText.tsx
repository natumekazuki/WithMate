import { Fragment, type ReactNode } from "react";

type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; lines: string[] }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "code"; language: string; code: string };

const INLINE_TOKEN_PATTERN = /(`[^`\n]+`)|(\[[^\]]+\]\([^)]+\))/g;

function isUnorderedListLine(line: string): boolean {
  return /^[-*]\s+/.test(line);
}

function isOrderedListLine(line: string): boolean {
  return /^\d+\.\s+/.test(line);
}

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const codeFence = line.match(/^```(.*)$/);
    if (codeFence) {
      const codeLines: string[] = [];
      const language = codeFence[1]?.trim() ?? "";
      index += 1;
      while (index < lines.length && !lines[index]?.trimStart().startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ type: "code", language, code: codeLines.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2] ?? "",
      });
      index += 1;
      continue;
    }

    if (isUnorderedListLine(line)) {
      const items: string[] = [];
      while (index < lines.length && isUnorderedListLine((lines[index] ?? "").trim())) {
        items.push((lines[index] ?? "").trim().replace(/^[-*]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "unordered-list", items });
      continue;
    }

    if (isOrderedListLine(line)) {
      const items: string[] = [];
      while (index < lines.length && isOrderedListLine((lines[index] ?? "").trim())) {
        items.push((lines[index] ?? "").trim().replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "ordered-list", items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const next = (lines[index] ?? "").trimEnd();
      const trimmed = next.trim();
      if (!trimmed) {
        break;
      }
      if (trimmed.startsWith("```") || /^(#{1,3})\s+/.test(trimmed) || isUnorderedListLine(trimmed) || isOrderedListLine(trimmed)) {
        break;
      }
      paragraphLines.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraphLines });
  }

  return blocks;
}

function renderInline(text: string, onOpenPath?: (target: string) => void) {
  const parts: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE_TOKEN_PATTERN)) {
    const matched = match[0];
    if (!matched) {
      continue;
    }
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push(text.slice(lastIndex, start));
    }

    if (matched.startsWith("`") && matched.endsWith("`")) {
      parts.push(
        <code key={`code-${start}`} className="message-inline-code">
          {matched.slice(1, -1)}
        </code>,
      );
    } else {
      const linkMatch = matched.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        const label = linkMatch[1] ?? matched;
        const target = linkMatch[2] ?? "";
        parts.push(
          <button
            key={`link-${start}`}
            className="message-inline-link"
            type="button"
            title={target}
            onClick={() => onOpenPath?.(target)}
          >
            {label}
          </button>,
        );
      } else {
        parts.push(matched);
      }
    }

    lastIndex = start + matched.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}

function renderParagraph(lines: string[], onOpenPath?: (target: string) => void) {
  return lines.map((line, index) => (
    <Fragment key={`line-${index}`}>
      {renderInline(line, onOpenPath)}
      {index < lines.length - 1 ? <br /> : null}
    </Fragment>
  ));
}

export function MessageRichText({
  text,
  className = "message-body",
  onOpenPath,
}: {
  text: string;
  className?: string;
  onOpenPath?: (target: string) => void;
}) {
  const blocks = parseBlocks(text);

  return (
    <div className={`${className} rich-text`.trim()}>
      {blocks.map((block, index) => {
        switch (block.type) {
          case "heading": {
            const Tag = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
            return (
              <Tag key={`heading-${index}`} className={`message-heading level-${block.level}`}>
                {renderInline(block.text, onOpenPath)}
              </Tag>
            );
          }
          case "unordered-list":
            return (
              <ul key={`ul-${index}`} className="message-list">
                {block.items.map((item, itemIndex) => (
                  <li key={`ul-item-${itemIndex}`}>{renderInline(item, onOpenPath)}</li>
                ))}
              </ul>
            );
          case "ordered-list":
            return (
              <ol key={`ol-${index}`} className="message-list ordered">
                {block.items.map((item, itemIndex) => (
                  <li key={`ol-item-${itemIndex}`}>{renderInline(item, onOpenPath)}</li>
                ))}
              </ol>
            );
          case "code":
            return (
              <pre key={`code-${index}`} className="message-code-block">
                <code>{block.code}</code>
              </pre>
            );
          case "paragraph":
          default:
            return (
              <p key={`paragraph-${index}`} className="message-paragraph">
                {renderParagraph(block.lines, onOpenPath)}
              </p>
            );
        }
      })}
    </div>
  );
}
