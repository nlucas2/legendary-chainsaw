import test from "node:test";
import assert from "node:assert/strict";
import { normalizeChatWidth } from "../src/lib/chatWidth.ts";

test("chat width is opt-in and invalid preferences retain readable width", () => {
  assert.equal(normalizeChatWidth("full"), "full");
  for (const value of [null, undefined, false, 1, {}, "readable", "wide", "FULL"]) {
    assert.equal(normalizeChatWidth(value), "readable");
  }
});
