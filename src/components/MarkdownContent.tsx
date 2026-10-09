import { createContext, memo, useContext } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink } from "./ExternalLink";
import { CodeBlock } from "./CodeBlock";
import "./markdown-content.css";

const plugins = [remarkGfm];
const Streaming = createContext(false);
const MarkdownCode: NonNullable<Components["pre"]> = ({ node, children }) => {
  const streaming = useContext(Streaming);
  const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
  if (!code || code.type !== "element") return <pre>{children}</pre>;
  const classes = code.properties.className;
  const language = Array.isArray(classes) ? String(classes.find((value) => typeof value === "string" && value.startsWith("language-")) ?? "").replace(/^language-/, "") : "";
  const source = code.children.map((child) => child.type === "text" ? child.value : "").join("");
  return <CodeBlock source={source} language={language} streaming={streaming} />;
};
const components: Components = {
  a: ({ node: _node, ...props }) => <ExternalLink {...props} />,
  table: ({ children }) => (
    <div className="markdown-table-scroll" role="region" aria-label="Table" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
  pre: MarkdownCode,
};

export const MarkdownContent = memo(function MarkdownContent({ children, streaming = false }: { children: string; streaming?: boolean }) {
  return <Streaming.Provider value={streaming}><div className="markdown-body">
    <ReactMarkdown remarkPlugins={plugins} components={components}>{children}</ReactMarkdown>
  </div></Streaming.Provider>;
});
