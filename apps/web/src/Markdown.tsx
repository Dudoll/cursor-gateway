import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Renders assistant/report Markdown as HTML. react-markdown does not emit raw
// HTML by default, so model-authored content cannot inject markup or scripts.
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
