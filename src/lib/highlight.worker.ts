import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { MAX_HIGHLIGHT_LENGTH } from "./codeRendering";

for (const [name, grammar] of Object.entries({ bash, cpp, csharp, css, diff, dockerfile, go, java,
  javascript, json, markdown, powershell, python, rust, sql, typescript, xml, yaml })) hljs.registerLanguage(name, grammar);

self.onmessage = (event: MessageEvent<{ id: number; source: string; language: string }>) => {
  const { id, source, language } = event.data;
  if (source.length > MAX_HIGHLIGHT_LENGTH || !hljs.getLanguage(language)) {
    self.postMessage({ id, html: null });
    return;
  }
  try { self.postMessage({ id, html: hljs.highlight(source, { language, ignoreIllegals: true }).value }); }
  catch { self.postMessage({ id, error: "Syntax highlighting failed; showing source." }); }
};
