import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Compile TSX in memory with the existing Vite/esbuild dependency. These are
// markup regressions, not measurements of browser/WebView layout or painting.
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: 'export { Transcript } from "./Transcript.tsx";',
    resolveDir: path.resolve("src", "components"),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  plugins: [{
    name: "shared-react-and-packages",
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
      builder.onResolve({ filter: /^(react(?:\/.*)?|react-markdown|remark-gfm|lucide-react)$/ },
        (args) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    },
  }],
});
const { Transcript } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
let sequence = 0;
const event = (type, data = {}, agentId) => ({
  id: `render-${++sequence}`, type, data, agentId, timestamp: "2026-09-04T00:00:00Z",
});
const render = (events, props = {}) => renderToStaticMarkup(createElement(Transcript, {
  hasSession: true, loading: false, events, subagentContext: [], permissions: [],
  reasoningExpanded: true, toolDetailsExpanded: false, showRawEvents: false,
  onPermission() {}, ...props,
}));

test("Transcript export is memoized", () => {
  assert.equal(Transcript.$$typeof, Symbol.for("react.memo"));
});

test("actual summary is expanded, precedes answer, and owns the only model/avatar heading", () => {
  const html = render([
    event("assistant.message_start", { messageId: "a" }),
    event("assistant.message_delta", { messageId: "a", content: "Actual answer" }),
    event("assistant.message", {
      messageId: "a", content: "Actual answer", reasoningText: "Visible **summary**",
      model: "provenance-model",
    }),
  ]);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /<strong>summary<\/strong>/);
  assert.ok(html.indexOf("Visible") < html.indexOf("Actual answer"));
  assert.equal((html.match(/<span>Copilot<\/span>/g) ?? []).length, 1);
  assert.equal((html.match(/<em>\(provenance-model\)<\/em>/g) ?? []).length, 1);
});

test("no dummy reasoning, pending summary or phantom assistant bubbles appear", () => {
  const html = render([
    event("user.message", { content: "Prompt" }),
    event("assistant.reasoning_delta", { reasoningId: "r", content: " \n" }),
    event("assistant.message_start", { messageId: "a" }),
    event("assistant.streaming_delta", { role: "assistant" }),
    event("assistant.message", { messageId: "a", content: "", toolRequests: [{}] }),
  ]);
  assert.doesNotMatch(html, /reasoning-card|Waiting for reasoning|No summary|message assistant/);
});

test("tools default collapsed while explicit global expansion remains supported", () => {
  const events = [event("tool.execution_start", {
    toolCallId: "t", toolName: "read_file", arguments: { path: "example.txt" },
  })];
  const collapsed = render(events);
  assert.match(collapsed, /aria-expanded="false"/);
  assert.doesNotMatch(collapsed, /tool-details/);
  const expanded = render(events, { toolDetailsExpanded: true });
  assert.match(expanded, /aria-expanded="true"/);
  assert.match(expanded, /tool-details/);
});

test("child reasoning uses the subagent label/model and child users are not root anchors", () => {
  const html = render([
    event("user.message", { content: "Root prompt" }),
    event("assistant.reasoning", { content: "Root reasoning" }),
    event("subagent.started", { agentName: "Researcher", model: "child-model" }, "child"),
    event("user.message", { content: "Child prompt" }, "child"),
    event("assistant.reasoning", { content: "Child reasoning" }, "child"),
    event("assistant.message", { content: "Child answer" }, "child"),
  ]);
  assert.match(html, /<span>Researcher<\/span>/);
  assert.match(html, /<em>\(child-model\)<\/em>/);
  assert.equal((html.match(/<span>Copilot<\/span>/g) ?? []).length, 1);
  assert.equal((html.match(/data-root-human/g) ?? []).length, 1);
});

test("current picker does not label unknown historical answers", () => {
  const html = render([event("assistant.message", { content: "Historical answer" })],
    { assistantModel: "current-picker" });
  assert.doesNotMatch(html, /current-picker/);
});

test("user attachments render compact escaped names without file data, paths, or Markdown", () => {
  const html = render([event("user.message", {
    content: "Attached",
    attachments: [
      { type: "blob", mimeType: "application/pdf", displayName: "**report**.pdf", data: "PRIVATE_FILE_BYTES" },
      { type: "file", path: "C:\\private\\notes.txt" },
      { displayName: "<script>.txt" },
    ],
  })]);
  assert.match(html, /aria-label="Message attachments"/);
  assert.match(html, /\*\*report\*\*\.pdf/);
  assert.match(html, /notes\.txt/);
  assert.match(html, /&lt;script&gt;\.txt/);
  assert.doesNotMatch(html, /PRIVATE_FILE_BYTES|C:\\|<strong>report<\/strong>|<script>/);
});

test("attachment-only messages keep their root-human anchor and image bytes are never embedded in markup", () => {
  const png = Buffer.from("\x89PNG\r\n\x1a\n", "binary").toString("base64");
  const html = render([event("user.message", {
    content: "", attachments: [{ type: "blob", displayName: "image.png", mimeType: "image/png", data: png }],
  })]);
  assert.match(html, /data-root-human/);
  assert.match(html, /transcript-attachment-thumbnail/);
  assert.match(html, /image\.png/);
  assert.doesNotMatch(html, new RegExp(png));
  assert.doesNotMatch(html, /src="(?:file:|https?:|data:)/);
});

test("assistant attachments never become user attachment UI", () => {
  const html = render([event("assistant.message", {
    content: "Answer", attachments: [{ displayName: "not-user-selected.txt" }],
  })]);
  assert.doesNotMatch(html, /not-user-selected|transcript-attachments/);
});

test("user messages preserve literal line breaks, blank lines and indentation without parsing HTML or Markdown", () => {
  const content = "I agree with A.\n\nAs for B:\n  - First point\n\t- Second point\n\n**literal emphasis** <script>alert(1)</script>";
  const html = render([event("user.message", { content })]);
  assert.match(html, /<p class="user-message-text">I agree with A\.\n\nAs for B:\n  - First point\n\t- Second point\n\n\*\*literal emphasis\*\* &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p>/);
  assert.doesNotMatch(html, /<script>|<strong>literal emphasis<\/strong>/);
});

test("child user messages use the same whitespace-preserving text renderer", () => {
  const html = render([
    event("subagent.started", { agentName: "Child" }, "child"),
    event("user.message", { content: "Child prompt\n\n  Indented detail" }, "child"),
    event("assistant.message", { content: "**Still Markdown**" }, "child"),
  ]);
  assert.match(html, /class="user-message-text">Child prompt\n\n  Indented detail<\/p>/);
  assert.match(html, /<strong>Still Markdown<\/strong>/);
});
