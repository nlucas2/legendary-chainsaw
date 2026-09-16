import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink } from "./ExternalLink";
import "./markdown-content.css";

const plugins = [remarkGfm];
const components: Components = {
  a: ({ node: _node, ...props }) => <ExternalLink {...props} />,
  table: ({ children }) => (
    <div className="markdown-table-scroll" role="region" aria-label="Table" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

export const MarkdownContent = memo(function MarkdownContent({ children }: { children: string }) {
  return <div className="markdown-body">
    <ReactMarkdown remarkPlugins={plugins} components={components}>{children}</ReactMarkdown>
  </div>;
});
