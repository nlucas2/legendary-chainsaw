import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: 'export { SessionUsageSummary } from "./SessionUsageSummary.tsx";',
    resolveDir: path.resolve("src", "components"), loader: "tsx",
  },
  bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic",
  plugins: [{
    name: "shared-react",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ },
        (args) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    },
  }],
});
const { SessionUsageSummary } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const render = (totalNanoAiu) => renderToStaticMarkup(createElement(SessionUsageSummary, { usage: { totalNanoAiu } }));

test("AI-credit summary displays the native session total with explicit scope", () => {
  const html = render(1_250_000_000);
  assert.match(html, /aria-label="Session AI credits"/);
  assert.match(html, /AI credits used<\/dt><dd>1.25<\/dd>/);
  assert.match(html, /including subagents/);
  assert.match(html, /not your account balance or remaining quota/);
});

test("unavailable credit accounting is not rendered as zero", () => {
  assert.match(render(null), /<dd>Unavailable<\/dd>/);
  assert.match(render(null), /has not reported an AI-credit total/);
  assert.match(render(0), /<dd>0<\/dd>/);
  assert.doesNotMatch(render(0), /has not reported/);
  assert.match(render(1), /<dd>&lt;0.000001<\/dd>/);
});
