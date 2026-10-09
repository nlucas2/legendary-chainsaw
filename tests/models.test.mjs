import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL_SELECTION, normalizeModelOptions, selectedModelOption, selectModel,
  modelSelectionError, modelSelectionSummary, preferredModelOptions } from "../src/lib/models.ts";
import { readModelDefaults } from "../src/lib/modelDefaults.ts";

const options = normalizeModelOptions([
  { id: "alpha", displayName: "Alpha", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low", supportedContextTiers: ["default", "long_context"] },
  { model_id: "beta", display_name: "Beta", supported_reasoning_efforts: ["high"], supported_context_tiers: ["long_context"] },
  { id: "plain", name: "Plain" },
  { id: "blocked", available: false, supportedReasoningEfforts: ["xhigh"] },
  { id: "auto", displayName: "Auto" },
]);

test("model options preserve Auto only when supplied and normalize both catalog schemas", () => {
  assert.equal(options[1].name, "Beta");
  assert.deepEqual(options[0].contextTiers, ["long_context"]);
  assert.equal(options[3].unavailable, true);
  assert.equal(options[4].id, "auto");
  assert.equal(selectedModelOption(options, ""), undefined);
  assert.equal(modelSelectionSummary(DEFAULT_MODEL_SELECTION, options), "");
});

test("only the configured model moves to the top, without duplicates or a synthetic default choice", () => {
  const original = options.map((option) => option.id);
  assert.deepEqual(preferredModelOptions(options, "beta").map((option) => option.id),
    ["beta", "alpha", "plain", "blocked", "auto"]);
  assert.deepEqual(preferredModelOptions(options, "blocked").map((option) => option.id),
    ["blocked", "alpha", "beta", "plain", "auto"]);
  for (const preferred of [undefined, "", "not-installed"]) {
    assert.deepEqual(preferredModelOptions(options, preferred).map((option) => option.id), original);
  }
  assert.deepEqual(options.map((option) => option.id), original);
  assert.equal(preferredModelOptions(options, "beta").filter((option) => option.id === "beta").length, 1);
});

test("all menus preserve compatible configuration and reconcile unsupported options identically", () => {
  const chosen = { modelId: "alpha", reasoningEffort: "high", reasoningSummary: "concise", contextTier: "long_context" };
  assert.deepEqual(selectModel(chosen, options[1]), { ...chosen, modelId: "beta" });
  assert.deepEqual(selectModel(chosen, options[2]), { modelId: "plain", reasoningEffort: "", reasoningSummary: "none", contextTier: "" });
  assert.equal(selectModel({ ...chosen, reasoningEffort: "max" }, options[0]).reasoningEffort, "low");
  assert.equal(modelSelectionError(chosen, options, false), "");
  assert.match(modelSelectionError({ ...chosen, modelId: "removed" }, options, true), /not in the current catalog/);
  assert.match(modelSelectionError({ ...chosen, modelId: "blocked" }, options, true), /unavailable/);
  assert.match(modelSelectionError({ ...chosen, reasoningEffort: "max" }, options, true), /not supported/);
  assert.match(modelSelectionError({ ...chosen, contextTier: "future" }, options, true), /not supported/);
  assert.equal(modelSelectionError(DEFAULT_MODEL_SELECTION, [], true), "");
  assert.match(modelSelectionSummary(chosen, options), /Alpha.*High.*concise.*Long Context/);
});

test("new-session model preferences roundtrip separately from runtime state and malformed settings report errors", () => {
  const selection = { modelId: "beta", reasoningEffort: "high", reasoningSummary: "concise", contextTier: "long_context" };
  assert.deepEqual(readModelDefaults(JSON.stringify({ version: 1, selection })), { value: selection, error: "" });
  assert.deepEqual(readModelDefaults(null), { value: DEFAULT_MODEL_SELECTION, error: "" });
  for (const bad of ["invalid", "[]", '{"version":2}', JSON.stringify({ version: 1, selection: { ...selection, reasoningSummary: "verbose" } }),
    JSON.stringify({ version: 1, selection: { ...selection, modelId: 3 } }),
    JSON.stringify({ version: 1, selection: { ...selection, reasoningSummary: ["none"] } })]) {
    assert.ok(readModelDefaults(bad).error);
  }
  assert.equal(readModelDefaults(JSON.stringify({ version: 1, selection: { ...selection, modelId: "not-in-catalog" } })).value.modelId, "not-in-catalog");
});
