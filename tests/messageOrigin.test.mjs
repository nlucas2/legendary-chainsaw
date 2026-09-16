import test from "node:test";
import assert from "node:assert/strict";
import { messageOrigin, isHumanMessage } from "../src/lib/messageOrigin.ts";

test("documented agent/skill sources are not attributed to the human user", () => {
  assert.equal(messageOrigin("agent-root").kind, "agent");
  assert.equal(messageOrigin("agent-123", true).label, "Agent instruction");
  assert.match(messageOrigin("agent-123").description, /agent-123/);
  assert.equal(messageOrigin("skill-pdf").kind, "skill");
  assert.equal(messageOrigin("skill-pdf").label, "Skill instructions");
  for (const source of ["extension-message", "agent-", "skill-", {}, true]) {
    assert.equal(messageOrigin(source).kind, "unknown");
    assert.notEqual(messageOrigin(source).label, "You");
  }
});

test("legacy session users stay human, while unattributed subagent inputs remain unknown", () => {
  for (const source of [undefined, null, ""]) {
    assert.equal(messageOrigin(source).label, "You");
    assert.equal(messageOrigin(source, true).kind, "unknown");
    assert.equal(messageOrigin(source, true).label, "Instruction");
  }
  assert.equal(messageOrigin("user").kind, "human");
  assert.equal(messageOrigin("user", true).label, "You");
});

test("only root human inputs qualify as human messages, never guesses based on their text", () => {
  const event = { type: "user.message", data: { content: "Instructions that look like an agent wrote them" } };
  assert.equal(isHumanMessage(event), true);
  assert.equal(isHumanMessage({ ...event, agentId: "child" }), false);
  assert.equal(isHumanMessage({ ...event, type: "assistant.message" }), false);
  for (const source of ["agent-root", "skill-pdf", "custom", true]) {
    assert.equal(isHumanMessage({ ...event, data: { content: "I typed this", source } }), false);
  }
});
