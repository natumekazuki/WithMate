import { Fragment, type ReactNode } from "react";

type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; lines: string[] }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "code"; language: string; code: string };

function isUnorderedListLine(line: string): boolean {
  return /^[-*]\s+/.test(line);
}

function isOrderedListLine(line: string): boolean {
  return /^\d+\.\s+/.test(line);
}

function normalizeBlockMarkerLine(line: string): string {
  const trimmedEnd = line.trimEnd();
  const leadingWhitespace = trimmedEnd.match(/^[\t ]*/)?.[0] ?? "";
  if (leadingWhitespace.length >= 4) {
    return trimmedEnd;
  }
  return trimmedEnd.slice(leadingWhitespace.length);
}

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trimEnd();
    const markerLine = normalizeBlockMarkerLine(rawLine);

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const codeFence = markerLine.match(/^```(.*)$/);
    if (codeFence) {
      const codeLines: string[] = [];
      const language = codeFence[1]?.trim() ?? "";
      index += 1;
      while (index < lines.length && !normalizeBlockMarkerLine(lines[index] ?? "").startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ type: "code", language, code: codeLines.join("\n") });
      continue;
    }

    const heading = markerLine.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2] ?? "",
      });
      index += 1;
      continue;
    }

    if (isUnorderedListLine(markerLine)) {
      const items: string[] = [];
      while (index < lines.length && isUnorderedListLine(normalizeBlockMarkerLine(lines[index] ?? ""))) {
        items.push(normalizeBlockMarkerLine(lines[index] ?? "").replace(/^[-*]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "unordered-list", items });
      continue;
    }

    if (isOrderedListLine(markerLine)) {
      const items: string[] = [];
      while (index < lines.length && isOrderedListLine(normalizeBlockMarkerLine(lines[index] ?? ""))) {
        items.push(normalizeBlockMarkerLine(lines[index] ?? "").replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "ordered-list", items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const next = lines[index] ?? "";
      const trimmed = next.trim();
      const nextMarkerLine = normalizeBlockMarkerLine(next);
      if (!trimmed) {
        break;
      }
      if (
        nextMarkerLine.startsWith("```") ||
        /^(#{1,3})\s+/.test(nextMarkerLine) ||
        isUnorderedListLine(nextMarkerLine) ||
        isOrderedListLine(nextMarkerLine)
      ) {
        break;
      }
      paragraphLines.push(next);
      index += 1;
    }

    if (paragraphLines.length === 0) {
      paragraphLines.push(rawLine);
      index += 1;
    }

    blocks.push({ type: "paragraph", lines: paragraphLines });
  }

  return blocks;
}

type InlineTokenMatch = {
  nextIndex: number;
  node: ReactNode;
};

function matchInlineCode(text: string, index: number): InlineTokenMatch | null {
  if (text[index] !== "`") {
    return null;
  }

  const end = text.indexOf("`", index + 1);
  if (end <= index + 1) {
    return null;
  }

  const content = text.slice(index + 1, end);
  if (content.includes("\n")) {
    return null;
  }

  return {
    nextIndex: end + 1,
    node: (
      <code key={`code-${index}`} className="message-inline-code">
        {content}
      </code>
    ),
  };
}

function matchInlineLink(text: string, index: number, onOpenPath?: (target: string) => void): InlineTokenMatch | null {
  if (text[index] !== "[") {
    return null;
  }

  const linkMatch = text.slice(index).match(/^\[([^\]]+)\]\(([^)]+)\)/);
  if (!linkMatch) {
    return null;
  }

  const label = linkMatch[1] ?? linkMatch[0];
  const target = linkMatch[2] ?? "";
  return {
    nextIndex: index + linkMatch[0].length,
    node: (
      <button
        key={`link-${index}`}
        className="message-inline-link"
        type="button"
        title={target}
        onClick={() => onOpenPath?.(target)}
      >
        {label}
      </button>
    ),
  };
}

function matchInlineStrong(text: string, index: number, onOpenPath?: (target: string) => void): InlineTokenMatch | null {
  if (!text.startsWith("**", index)) {
    return null;
  }

  const end = text.indexOf("**", index + 2);
  if (end <= index + 2) {
    return null;
  }

  const content = text.slice(index + 2, end);
  if (!content.trim()) {
    return null;
  }

  return {
    nextIndex: end + 2,
    node: (
      <strong key={`strong-${index}`} className="message-inline-strong">
        {renderInline(content, onOpenPath)}
      </strong>
    ),
  };
}

function renderInline(text: string, onOpenPath?: (target: string) => void) {
  const parts: ReactNode[] = [];
  let index = 0;
  let plainStart = 0;

  while (index < text.length) {
    const token =
      matchInlineCode(text, index) ??
      matchInlineLink(text, index, onOpenPath) ??
      matchInlineStrong(text, index, onOpenPath);

    if (token) {
      if (index > plainStart) {
        parts.push(text.slice(plainStart, index));
      }
      parts.push(token.node);
      index = token.nextIndex;
      plainStart = index;
      continue;
    }

    index += 1;
  }

  if (plainStart < text.length) {
    parts.push(text.slice(plainStart));
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
