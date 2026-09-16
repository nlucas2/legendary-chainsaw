import test from "node:test";
import assert from "node:assert/strict";
import { linkDestination } from "../src/lib/links.ts";

test("web and email destinations are normalized for the external opener", () => {
  for (const href of ["https://example.com/path?q=one#two", "http://localhost:3000/test", "mailto:user@example.com"]) {
    assert.deepEqual(linkDestination(href), { kind: "external", href });
  }
  assert.deepEqual(linkDestination(" //example.com/path "), { kind: "external", href: "https://example.com/path" });
  assert.deepEqual(linkDestination("HTTPS://Example.COM"), { kind: "external", href: "https://example.com/" });
});

test("page fragments remain internal, while relative paths and executable schemes cannot navigate the app", () => {
  assert.deepEqual(linkDestination("#footnote"), { kind: "fragment", href: "#footnote" });
  assert.deepEqual(linkDestination("#"), { kind: "fragment", href: "#" });
  for (const href of [undefined, "", "src/file.rs", "/api/session", "../file", "file:///C:/private.txt",
    "javascript:alert(1)", "data:text/html,hi", "vbscript:run", "vscode://file/path", "tauri://localhost",
    "https://", "java\nscript:alert(1)"]) {
    assert.equal(linkDestination(href).kind, "unsupported", href);
  }
});
