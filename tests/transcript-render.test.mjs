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

test("Copilot heading precedes tool-first activity instead of appearing below it on the final answer", () => {
  const events = [
    event("session.start", { model: "reported-model" }),
    event("user.message", { content: "Inspect the workspace" }),
    event("tool.execution_start", { toolCallId: "view", toolName: "view", arguments: { path: "file.txt" } }),
    event("tool.execution_start", { toolCallId: "shell", toolName: "powershell" }),
    event("assistant.message", { content: "Inspection done." }),
  ];
  const html = render(events);
  assert.equal((html.match(/<span>Copilot<\/span>/g) ?? []).length, 1);
  assert.equal((html.match(/<em>\(reported-model\)<\/em>/g) ?? []).length, 1);
  assert.ok(html.indexOf(">You</span>") < html.indexOf(">Copilot</span>"));
  assert.ok(html.indexOf(">Copilot</span>") < html.indexOf('class="tool-card'));
  assert.ok(html.indexOf(">powershell</strong>") < html.indexOf("Inspection done."));
  assert.ok(html.indexOf("</article>") < html.indexOf('class="assistant-activity-heading"'));
  const running = render(events.slice(0, 3));
  assert.match(running, /assistant-activity-heading/);
  assert.doesNotMatch(running, /class="message assistant"/);
});

test("later reasoning cannot steal the heading from leading tools and tool-only history is labeled", () => {
  const html = render([
    event("user.message", { content: "Prompt" }),
    event("tool.execution_start", { toolCallId: "first", toolName: "view" }),
    event("assistant.reasoning", { content: "Actual summary" }),
    event("assistant.message", { content: "Answer", reasoningText: "Actual summary" }),
  ]);
  assert.equal((html.match(/<span>Copilot<\/span>/g) ?? []).length, 1);
  assert.ok(html.indexOf(">Copilot</span>") < html.indexOf(">view</strong>"));
  assert.ok(html.indexOf(">view</strong>") < html.indexOf("Actual summary"));
  const next = render([
    event("user.message", { content: "First" }),
    event("tool.execution_start", { toolCallId: "first", toolName: "view" }),
    event("user.message", { content: "Second" }),
    event("tool.execution_start", { toolCallId: "second", toolName: "glob" }),
  ]);
  assert.equal((next.match(/<span>Copilot<\/span>/g) ?? []).length, 2);
});

test("nested and focused child tools carry the child label without claiming the parent's model", () => {
  const html = render([
    event("session.start", { model: "parent-model" }),
    event("user.message", { content: "Delegate" }),
    event("subagent.started", { agentName: "Builder", model: "child-model" }, "child"),
    event("tool.execution_start", { toolCallId: "child-tool", toolName: "view" }, "child"),
    event("assistant.message", { content: "Child result" }, "child"),
    event("assistant.message", { content: "Parent result" }),
  ]);
  assert.equal((html.match(/<span>Copilot<\/span>/g) ?? []).length, 1);
  assert.equal((html.match(/<span>Builder<\/span>/g) ?? []).length, 1);
  assert.equal((html.match(/<em>\(parent-model\)<\/em>/g) ?? []).length, 1);
  assert.equal((html.match(/<em>\(child-model\)<\/em>/g) ?? []).length, 1);
  assert.ok(html.indexOf(">Copilot</span>") < html.indexOf('class="subagent-card'));
  assert.ok(html.indexOf(">Builder</span>") < html.indexOf('class="tool-card'));
  const focused = render([
    event("session.start", { model: "child-model" }),
    event("tool.execution_start", { toolCallId: "child-tool", toolName: "view" }),
  ], { assistantLabel: "Builder", subagentConversation: true });
  assert.match(focused, /<span>Builder<\/span>/);
  assert.doesNotMatch(focused, /<span>Copilot<\/span>/);
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
  assert.match(html, />Instruction<\/span>/);
});

test("agent and skill inputs have their own labels and are not human scroll anchors", () => {
  const html = render([
    event("user.message", { content: "Human message" }),
    event("user.message", { content: "Only four files move.", source: "agent-primary" }),
    event("user.message", { content: "Load this skill", source: "skill-pdf" }),
    event("user.message", { content: "Unknown producer", source: "other-<script>" }),
  ]);
  assert.match(html, />You<\/span>/);
  assert.match(html, />Agent instruction<\/span>/);
  assert.match(html, />Skill instructions<\/span>/);
  assert.match(html, />Input<\/span>/);
  assert.match(html, /data-message-origin="agent"/);
  assert.equal((html.match(/data-root-human/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<script>/);
});

test("focused subagent input without sender metadata is not claimed as You", () => {
  const html = render([
    event("user.message", { content: "Legacy instruction" }),
    event("user.message", { content: "Typed by a person", source: "user" }),
  ], { subagentConversation: true });
  assert.match(html, />Instruction<\/span>/);
  assert.match(html, />You<\/span>/);
  assert.doesNotMatch(html, /data-root-human/);
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

test("Markdown tables retain semantic cells and alignment inside a focusable overflow region", () => {
  const html = render([event("assistant.message", {
    content: "| Location | Finding |\n| :--- | ---: |\n| [file.rs:3](https://example.com/file) | **Important** detail |\n",
  })]);
  assert.match(html, /class="markdown-body"/);
  assert.match(html, /class="markdown-table-scroll" role="region" aria-label="Table" tabindex="0"><table>/);
  assert.match(html, /<th style="text-align:right">Finding<\/th>/);
  assert.match(html, /<a href="https:\/\/example.com\/file" target="_blank" rel="noopener noreferrer">file.rs:3<\/a>/);
  assert.match(html, /<strong>Important<\/strong>/);
});

test("shell commands and output preserve newlines and indentation as text rather than Markdown paragraphs", () => {
  const html = render([
    event("tool.execution_start", { toolCallId: "p", toolName: "powershell",
      arguments: { command: '$n = 1\nWrite-Output "two"\n\n  # indentation' } }),
    event("tool.execution_complete", { toolCallId: "p", result: { output: "first\n  second\n\nthird <script>not executable</script>" } }),
  ], { toolDetailsExpanded: true });
  assert.match(html, /data-language="powershell"/);
  assert.match(html, /\$n = 1\nWrite-Output &quot;two&quot;\n\n  # indentation/);
  assert.match(html, /first\n  second\n\nthird &lt;script&gt;not executable&lt;\/script&gt;/);
  assert.match(html, /Show raw output/);
  assert.doesNotMatch(html, /<script>/);
});

test("fenced code has a shared raw-source control without wrapping block elements inside pre", () => {
  const html = render([event("assistant.message", { content: "```javascript\nconst x = '<script>';\n```" })]);
  assert.match(html, /data-language="javascript"/);
  assert.match(html, /Show raw source/);
  assert.match(html, /const x = &#x27;&lt;script&gt;&#x27;;/);
  assert.doesNotMatch(html, /<pre[^>]*><div/);
});

test("apply_patch arguments render as read-only file diffs with raw source and escaped code", () => {
  const patch = "*** Begin Patch\n*** Update File: src/file.ts\n@@\n-before\n+<script>after</script>\n*** Delete File: old.txt\n*** End Patch";
  const html = render([
    event("tool.execution_start", { toolCallId: "patch", toolName: "apply_patch", arguments: patch }),
    event("tool.execution_complete", { toolCallId: "patch", success: true, result: "Done" }),
  ], { toolDetailsExpanded: true });
  assert.match(html, /aria-label="Patch request"/);
  assert.match(html, /aria-label="Patch for src\/file\.ts"/);
  assert.match(html, /git-diff-line delete/);
  assert.match(html, /git-diff-line add/);
  assert.match(html, /Show raw patch/);
  assert.match(html, /Delete file; contents are not included/);
  assert.match(html, /\+&lt;script&gt;after&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|role="listbox"/);
});
