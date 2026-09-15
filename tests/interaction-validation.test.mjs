import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Reuse the existing renderer-test toolchain; no files or app processes created.
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: 'export { InteractionPanel, compileElicitationSchema, initialElicitationFields, validateElicitationContent } from "./InteractionPanel.tsx";',
    resolveDir: path.resolve("src", "components"),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  plugins: [{
    name: "shared-renderer-packages",
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
      builder.onResolve({ filter: /^(react(?:\/.*)?|react-markdown|remark-gfm|ajv(?:\/.*)?|ajv-formats)$/ },
        (args) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    },
  }],
});
const {
  InteractionPanel, compileElicitationSchema, initialElicitationFields, validateElicitationContent,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const fixtures = JSON.parse(await readFile(new URL("./interaction-validation.cases.json", import.meta.url), "utf8"));

for (const fixture of fixtures.cases) {
  test(`form constraints: ${fixture.name}`, () => {
    const validator = compileElicitationSchema(fixture.schema);
    assert.equal(validator.error, undefined);
    for (const value of fixture.valid) {
      const before = structuredClone(value);
      assert.equal(validateElicitationContent(validator, value), "", JSON.stringify(value));
      assert.deepEqual(value, before, "validation must not coerce or mutate submitted values");
    }
    for (const value of fixture.invalid) {
      const before = structuredClone(value);
      assert.notEqual(validateElicitationContent(validator, value), "", JSON.stringify(value));
      assert.deepEqual(value, before, "invalid answers must not acquire defaults or lose fields");
    }
  });
}

for (const fixture of fixtures.unsupported) {
  test(`unsupported form fails explicitly: ${fixture.name}`, () => {
    const validator = compileElicitationSchema(fixture.schema);
    assert.match(validator.error, /Unsupported or invalid elicitation schema/);
    assert.notEqual(validateElicitationContent(validator, {}), "");
  });
}

test("required booleans start as false, while untouched optional booleans remain absent", () => {
  const schema = {
    type: "object",
    properties: {
      requiredFalse: { type: "boolean" },
      optional: { type: "boolean" },
      defaultFalse: { type: "boolean", default: false },
      defaultTrue: { type: "boolean", default: true },
    },
    required: ["requiredFalse"],
  };
  const fields = initialElicitationFields(schema);
  assert.deepEqual(fields, { requiredFalse: false, defaultFalse: false, defaultTrue: true });
  assert.equal(validateElicitationContent(compileElicitationSchema(schema), fields), "");
});

test("empty required enum arrays are present, and minItems still requires selections", () => {
  const schema = fixtures.cases.find((item) => item.name.includes("empty required array")).schema;
  const fields = initialElicitationFields(schema);
  assert.deepEqual(fields, { tags: [] });
  assert.equal(validateElicitationContent(compileElicitationSchema(schema), fields), "");
  const minimum = structuredClone(schema);
  minimum.properties.tags.minItems = 1;
  assert.notEqual(validateElicitationContent(compileElicitationSchema(minimum), fields), "");
});

test("non-finite numeric state is rejected instead of serializing as null", () => {
  const validator = compileElicitationSchema({ type: "object", properties: { value: { type: "number" } }, required: ["value"] });
  for (const value of [NaN, Infinity, -Infinity]) assert.notEqual(validateElicitationContent(validator, { value }), "");
});

const render = (data) => {
  let responses = 0;
  const html = renderToStaticMarkup(createElement(InteractionPanel, {
    interaction: { sessionId: "s", requestId: "r", kind: "elicitation", data },
    onRespond: async () => { responses++; },
  }));
  assert.equal(responses, 0, "rendering a form must never answer it");
  return html;
};

test("ask_user choices are readable radio options, with no preselected answer", () => {
  const html = renderToStaticMarkup(createElement(InteractionPanel, {
    interaction: { sessionId: "s", requestId: "r", kind: "user_input",
      data: { question: "Choose a diagram", choices: ["Simplify 03 (Recommended)", "Leave 03 unchanged"], allowFreeform: true } },
    onRespond: async () => { throw new Error("Rendering must not answer"); },
  }));
  assert.match(html, /Simplify 03 \(Recommended\)/);
  assert.match(html, /Leave 03 unchanged/);
  assert.equal((html.match(/type="radio"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /checked=/);
  assert.match(html, /Or type your answer/);
});

test("form rendering uses schema validation, not checkbox truthiness", () => {
  const html = render({
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: {
        agree: { type: "boolean" },
        email: { type: "string", format: "email" },
        value: { type: "number", minimum: 1, maximum: 3 },
        text: { type: "string", minLength: 2, maxLength: 4 },
      },
      required: ["agree"],
    },
  });
  assert.match(html, /<form[^>]*noValidate=""/i);
  const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
  assert.ok(checkbox);
  assert.match(checkbox, /aria-required="true"/);
  assert.doesNotMatch(checkbox, /\srequired(?:=|\s|>)/);
  assert.doesNotMatch(checkbox, /\schecked(?:=|\s|>)/);
  assert.match(html, /type="email"/);
  assert.match(html, /min="1"/);
  assert.match(html, /max="3"/);
  assert.match(html, /Unicode characters/);
  // HTML maxlength counts UTF-16 code units and would reject valid emoji.
  assert.doesNotMatch(html, /maxLength=/i);
});

test("unsupported schema disables acceptance but leaves decline and cancel available", () => {
  const html = render({ requestedSchema: fixtures.unsupported[0].schema });
  assert.match(html, /role="alert"/);
  assert.match(html, /Unsupported or invalid elicitation schema/);
  const buttons = html.match(/<button\b[^>]*>[^<]*<\/button>/g) ?? [];
  assert.match(buttons.find((button) => button.endsWith(">Submit</button>")), /disabled/);
  assert.doesNotMatch(buttons.find((button) => button.endsWith(">Cancel</button>")), /disabled/);
  assert.doesNotMatch(buttons.find((button) => button.endsWith(">Decline</button>")), /disabled/);
});

test("empty-string enum choices have distinct UI identities from the unanswered placeholder", () => {
  const html = render({
    requestedSchema: { type: "object", properties: { choice: {
      type: "string", default: "", oneOf: [{ const: "", title: "Empty choice" }, { const: "x", title: "X" }],
    } }, required: ["choice"] },
  });
  assert.match(html, /<option value="">Select\.\.\.<\/option>/);
  assert.match(html, /<option value="0" selected="">Empty choice<\/option>/);
});
