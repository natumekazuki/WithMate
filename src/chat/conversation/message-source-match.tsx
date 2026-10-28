import type { TextSearchMatch } from "../../../src-shared/text/find-text-matches.js";

export function MessageSourceMatch({ text, match }: { text: string; match: TextSearchMatch }) {
  const start = Math.max(0, match.startOffset - 80);
  const end = Math.min(text.length, match.endOffset + 80);
  return (
    <div className="message-source-match" role="status">
      <span className="message-source-match-label">Source Match</span>
      <code>
        {start > 0 ? "…" : ""}{text.slice(start, match.startOffset)}
        <mark>{text.slice(match.startOffset, match.endOffset)}</mark>
        {text.slice(match.endOffset, end)}{end < text.length ? "…" : ""}
      </code>
    </div>
  );
}
