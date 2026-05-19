import ReactMarkdown, { type Components } from "react-markdown";

type MessageRichTextProps = {
  text: string;
  className?: string;
};

const markdownComponents: Components = {
  h1: ({ children }) => <h3 className="message-heading level-1">{children}</h3>,
  h2: ({ children }) => <h4 className="message-heading level-2">{children}</h4>,
  h3: ({ children }) => <h5 className="message-heading level-3">{children}</h5>,
  h4: ({ children }) => <h5 className="message-heading level-3">{children}</h5>,
  h5: ({ children }) => <h5 className="message-heading level-3">{children}</h5>,
  h6: ({ children }) => <h5 className="message-heading level-3">{children}</h5>,
  p: ({ children }) => <p className="message-paragraph">{children}</p>,
  ul: ({ children }) => <ul className="message-list">{children}</ul>,
  ol: ({ children }) => <ol className="message-list ordered">{children}</ol>,
  pre: ({ children }) => <pre className="message-code-block">{children}</pre>,
  code: ({ children, className }) => (
    <code className={className ? `message-inline-code ${className}` : "message-inline-code"}>{children}</code>
  ),
  strong: ({ children }) => <strong className="message-inline-strong">{children}</strong>,
  img: () => null,
};

export function MessageRichText({ text, className = "message-body" }: MessageRichTextProps) {
  return (
    <div className={`${className} rich-text`.trim()}>
      <ReactMarkdown components={markdownComponents}>{text}</ReactMarkdown>
    </div>
  );
}
