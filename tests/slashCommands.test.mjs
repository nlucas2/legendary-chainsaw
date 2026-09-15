import test from "node:test";
import assert from "node:assert/strict";
import { slashCommandSuggestions } from "../src/lib/slashCommands.ts";

test("ask and fork are discoverable without runtime command discovery", () => {
  assert.equal(slashCommandSuggestions(null, "/as")[0].name, "ask");
  assert.equal(slashCommandSuggestions({}, "/for")[0].name, "fork");
});
test("local commands and native commands are merged without duplicate entries", () => {
  const result = slashCommandSuggestions({ commands: [{ name: "ask" }, { name: "usage" }, null] }, "/");
  assert.deepEqual(result.map((item) => item.name), ["ask", "fork", "usage"]);
});
