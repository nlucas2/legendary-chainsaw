import test from "node:test";
import assert from "node:assert/strict";
import { codeLanguage, formattedJson, hasMarkdownFormatting, MAX_HIGHLIGHT_LENGTH, rawOutput, shellLanguage } from "../src/lib/codeRendering.ts";
import { mermaidPolicyError, prepareMermaid } from "../src/lib/mermaidPolicy.ts";

test("language aliases are explicit and unknown languages remain unknown", () => {
  for (const [input, expected] of [["TS", "typescript"], ["ps1", "powershell"], ["sh", "bash"], ["html", "xml"],
    ["text", "plaintext"], ["rust", "rust"], ["mermaid", "mermaid"], ["unfamiliar", "unfamiliar"]]) {
    assert.equal(codeLanguage(input), expected);
  }
  assert.equal(shellLanguage("functions.powershell"), "powershell");
  assert.equal(shellLanguage("bash"), "bash");
  assert.equal(shellLanguage("my-mcp-search"), undefined);
});

test("raw output preserves line endings and object values without executing or expanding strings", () => {
  assert.equal(rawOutput("one\r\n  two\n\nthree"), "one\r\n  two\n\nthree");
  const value = { output: "<script>not code</script>\nnext", ok: true };
  assert.equal(rawOutput(value), JSON.stringify(value, null, 2));
  assert.equal(rawOutput(null), "null");
});

test("only complete bounded JSON gets formatting; logs and partial values remain text", () => {
  assert.equal(formattedJson('{"one":1,"two":[true,false]}'), '{\n  "one": 1,\n  "two": [\n    true,\n    false\n  ]\n}');
  assert.equal(formattedJson("not json\nseparate line"), null);
  assert.equal(formattedJson("{ incomplete"), null);
  assert.equal(formattedJson("[" + " ".repeat(MAX_HIGHLIGHT_LENGTH) + "]"), null);
});

test("plain command text is not passed through Markdown's whitespace normalization", () => {
  assert.equal(hasMarkdownFormatting("Name   Value\nfirst  1\n\n  Indented"), false);
  assert.equal(hasMarkdownFormatting("## Results\n- **First**"), true);
  assert.equal(hasMarkdownFormatting("```mermaid\nflowchart LR\nA-->B\n```"), true);
  assert.equal(hasMarkdownFormatting("| A | B |\n|---|---|"), true);
});

test("standard Mermaid styles, classes and link styling work without allowing resources or CSS rule injection", () => {
  for (const style of [
    "style DNS fill:#fff3cd,stroke:#9a6700,color:#000",
    "style A,B fill:lightblue,stroke:black,stroke-width:2px,opacity:0.5",
    "style A fill:none,fill-opacity:.5,stroke-opacity:1;",
    "style A fill:rgb(255\\, 243\\, 205),stroke-width:2px",
    "classDef highlight fill:#fff3cd,stroke:#9a6700,color:#000,font-weight:bold",
    "classDef dashed stroke-dasharray:5\\,5",
    "linkStyle default stroke:red,stroke-width:2px",
    "linkStyle 0,1 stroke:blue",
    "style A fill:red!important",
  ]) {
    assert.equal(mermaidPolicyError(`flowchart TB\n A-->B\n    ${style}`), null);
  }
  for (const style of [
    "style A fill:url(https://external.invalid/image.svg)",
    "style A fill:u\\72l(https://external.invalid/a)",
    "style A background-image:url(https://external.invalid/a)",
    "style A color:red}",
    "style A stroke-width:expression(alert(1))",
    "classDef injected fill:red} body {display:none",
    "linkStyle 0 stroke:url(https://external.invalid/a)",
  ]) {
    for (const separator of ["\n", ";"]) {
      assert.match(mermaidPolicyError(`flowchart LR\n A-->B${separator}${style}`), /Styles cannot/);
    }
  }
  assert.match(mermaidPolicyError('%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B'), /configuration/);
  assert.match(mermaidPolicyError('flowchart LR\n A-->B;click A "https://external.invalid"'), /click actions/);
});

test("Mermaid init extracts layout options without forwarding directives or mutating raw source", () => {
  const source = '%%{init: {"flowchart": {"curve": "stepAfter", "nodeSpacing": 35, "rankSpacing": 65}}}%%\r\nflowchart TB\nA-->B\nstyle A fill:none,stroke:none';
  assert.deepEqual(prepareMermaid(source), {
    source: "\r\nflowchart TB\nA-->B\nstyle A fill:none,stroke:none",
    flowchart: { curve: "stepAfter", nodeSpacing: 35, rankSpacing: 65 },
  });
  assert.equal(mermaidPolicyError(source), null);
  assert.ok(source.startsWith("%%{init:"));
  assert.deepEqual(prepareMermaid("flowchart TB\nA-->B"), { source: "flowchart TB\nA-->B", flowchart: {} });
  assert.deepEqual(prepareMermaid('%%{initialize: {"flowchart":{"nodeSpacing":0}}}%%\n%%{init: {"flowchart":{"rankSpacing":1000,"curve":"linear"}}}%%\nflowchart LR\nA-->B'), {
    source: "\n\nflowchart LR\nA-->B", flowchart: { nodeSpacing: 0, rankSpacing: 1000, curve: "linear" },
  });
  assert.deepEqual(prepareMermaid('%%{init: {\n"flowchart": {"curve": "stepBefore"}\n}}%%\nflowchart TB\nA-->B'), {
    source: "\n\n\nflowchart TB\nA-->B", flowchart: { curve: "stepBefore" },
  });
});

test("Mermaid configuration rejects unsupported settings, unsafe values and incomplete syntax explicitly", () => {
  for (const config of [
    null, [], true, { flowchart: null }, { flowchart: [] },
    { securityLevel: "loose", flowchart: { curve: "linear" } },
    { flowchart: { htmlLabels: true } }, { flowchart: { curve: "not-a-curve" } },
    { flowchart: { nodeSpacing: -1 } }, { flowchart: { rankSpacing: 1001 } },
    { flowchart: { nodeSpacing: "35" } }, { flowchart: { rankSpacing: null } },
    { flowchart: { curve: { toString: "linear" } } },
    { themeCSS: "@import 'https://external.invalid/';", flowchart: {} },
    { maxEdges: 100000, flowchart: {} },
  ]) {
    assert.ok(prepareMermaid(`%%{init: ${JSON.stringify(config)}}%%\nflowchart LR\nA-->B`).error);
  }
  for (const directive of [
    '%%{init: {"flowchart": {"nodeSpacing": 1e999}}}%%',
    '%%{init: {"flowchart": {"__proto__": {"htmlLabels": true}}}}%%',
    '%%{init: {"flowchart": {"curve":"linear"}}', "%%{init: not-json}%%",
    '%%{config: {"flowchart": {}}}%%', "---\nconfig:\n  securityLevel: loose\n---",
  ]) {
    assert.ok(prepareMermaid(`${directive}\nflowchart LR\nA-->B`).error);
  }
  const init = '%%{init: {"flowchart":{"curve":"stepAfter"}}}%%\n';
  assert.match(mermaidPolicyError(init + 'flowchart LR\nA-->B\nclick A "https://external.invalid"'), /click actions/);
  assert.match(mermaidPolicyError(init + "flowchart LR\nA-->B\nstyle A fill:url(https://external.invalid)"), /Styles cannot/);
});
