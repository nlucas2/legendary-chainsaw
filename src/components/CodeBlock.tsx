import { memo, useEffect, useRef, useState } from "react";
import { codeLanguage, MAX_DIAGRAM_LENGTH, MAX_HIGHLIGHT_LENGTH } from "../lib/codeRendering";
import "./code-block.css";

function useVisible(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!enabled || visible || !ref.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [enabled, visible]);
  return { ref, visible };
}

export const CodeBlock = memo(function CodeBlock({ source, language = "", streaming = false, controls = true, forceRaw = false }: {
  source: string; language?: string; streaming?: boolean; controls?: boolean; forceRaw?: boolean;
}) {
  const lang = codeLanguage(language);
  const diagram = lang === "mermaid";
  const oversized = source.length > (diagram ? MAX_DIAGRAM_LENGTH : MAX_HIGHLIGHT_LENGTH);
  const { ref, visible } = useVisible(!forceRaw && !!lang && lang !== "plaintext" && !oversized);
  const [raw, setRaw] = useState(false);
  const [dark, setDark] = useState(() => typeof document !== "undefined" && document.documentElement.dataset.theme !== "light");
  const [rendered, setRendered] = useState<{ source: string; language: string; dark: boolean; html: string | null; error?: string }>();
  const showRaw = forceRaw || raw;
  useEffect(() => {
    if (!diagram) return;
    const sync = () => setDark(document.documentElement.dataset.theme !== "light");
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [diagram]);
  useEffect(() => {
    if (!visible || showRaw || streaming || !lang || lang === "plaintext") return;
    if (source.length > (diagram ? MAX_DIAGRAM_LENGTH : MAX_HIGHLIGHT_LENGTH)) return;
    if (rendered?.source === source && rendered.language === lang && (!diagram || rendered.dark === dark)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const work = diagram
        ? import("../lib/renderMermaid").then((module) => module.renderMermaid(source, dark, controller.signal))
        : import("../lib/highlightCode").then((module) => module.highlightCode(source, lang, controller.signal));
      void work.then((html) => {
        if (!controller.signal.aborted) setRendered({ source, language: lang, dark, html });
      }).catch((cause) => {
        if (!controller.signal.aborted) setRendered({ source, language: lang, dark, html: null,
          error: diagram ? `Could not render this diagram; showing source.${cause instanceof Error ? ` ${cause.message.slice(0, 500)}` : ""}`
            : cause instanceof Error ? cause.message : "Highlighting unavailable; showing source." });
      });
    }, diagram ? 150 : 50);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [source, lang, diagram, dark, showRaw, streaming, visible, rendered]);
  const current = rendered?.source === source && rendered.language === lang && (!diagram || rendered.dark === dark) ? rendered : undefined;
  const html = !showRaw && !streaming ? current?.html : undefined;
  return <div ref={ref} className={`code-block${diagram ? " diagram-block" : ""}`} data-language={lang || "plaintext"}>
    {controls && <div className="code-block-toolbar"><span>{language || "Code"}</span>
      <label><input type="checkbox" checked={raw} onChange={(event) => setRaw(event.target.checked)} />Show raw source</label>
    </div>}
    {diagram && html ? <div className="diagram-view" role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: html }} />
      : <pre className="code-block-source"><code {...(html ? { dangerouslySetInnerHTML: { __html: html } } : { children: source })} /></pre>}
    {!showRaw && diagram && streaming && <small className="code-block-notice">Diagram will render when the response finishes.</small>}
    {!showRaw && oversized && <small className="code-block-notice">Large block: showing source without {diagram ? "diagram rendering" : "highlighting"}.</small>}
    {!showRaw && current?.error && <small className="code-block-error" role="status">{current.error}</small>}
  </div>;
});
