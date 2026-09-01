import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownContent({
  content,
  compact = false
}: {
  content: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "markdown-content compact" : "markdown-content"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          img: ({ alt }) => <span className="markdown-image-placeholder">{alt ? `图片：${alt}` : "邮件图片"}</span>
        }}
      >
        {content || "暂无内容。"}
      </ReactMarkdown>
    </div>
  );
}
