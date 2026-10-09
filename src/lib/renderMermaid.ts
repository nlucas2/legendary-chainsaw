import mermaid from "mermaid";
import DOMPurify from "dompurify";
import { MAX_DIAGRAM_LENGTH } from "./codeRendering";
import { mermaidPolicyError } from "./mermaidPolicy";

let sequence = 0;
let tail = Promise.resolve();

export function renderMermaid(source: string, dark: boolean, signal: AbortSignal): Promise<string> {
  const render = tail.then(async () => {
    if (signal.aborted) throw new Error("Diagram cancelled.");
    if (source.length > MAX_DIAGRAM_LENGTH) throw new Error("Diagram is too large to render automatically; showing source.");
    const policyError = mermaidPolicyError(source);
    if (policyError) throw new Error(policyError);
    mermaid.initialize({
      startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default",
      htmlLabels: false, maxTextSize: MAX_DIAGRAM_LENGTH, maxEdges: 200, suppressErrorRendering: true,
      flowchart: { htmlLabels: false },
      secure: ["securityLevel", "startOnLoad", "htmlLabels", "maxTextSize", "maxEdges", "themeCSS", "flowchart"],
    });
    const host = document.createElement("div");
    Object.assign(host.style, { position: "fixed", left: "-10000px", top: "0", visibility: "hidden" });
    document.body.append(host);
    try {
      const { svg } = await mermaid.render(`diagram-${++sequence}`, source, host);
      if (signal.aborted) throw new Error("Diagram cancelled.");
      const safe = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ["foreignObject", "image", "script", "iframe", "use", "a", "animate", "set"] });
      const template = document.createElement("template");
      template.innerHTML = safe;
      for (const element of template.content.querySelectorAll("*")) {
        for (const attribute of [...element.attributes]) {
          const urls = [...attribute.value.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi)];
          if (["href", "xlink:href", "src"].includes(attribute.name) ||
              urls.some((match) => !match[2].trim().startsWith("#"))) element.removeAttribute(attribute.name);
        }
      }
      if (!template.content.querySelector("svg")) throw new Error("Diagram renderer did not return an SVG.");
      return template.innerHTML;
    } finally { host.remove(); }
  });
  tail = render.then(() => undefined, () => undefined);
  return render;
}
