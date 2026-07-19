import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Match the main CS chat renderer. Raw model-authored HTML stays disabled,
// while links always leave the local desktop WebView safely.
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer nofollow" />
          )
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
