import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeProfileLibrary, normalizeProfilePreview, normalizeSessionProfile, normalizeInstalledPlugins, sourcePaths,
} from "../src/lib/profiles.ts";

const library = { directory: "Q:\\profiles", revision: "r1",
  groups: [{ id: "base", name: "Everyday", mcpConfigFiles: ["mcp.json"], skillDirectories: ["skills"] }],
  profiles: [{ id: "chosen", name: "My profile", groupIds: ["base"] }] };

test("installed plugin inventory validates status and exposes only editor metadata", () => {
  const plugins = [{ name: "fixture", marketplace: "example", version: "1.2.3", enabled: true },
    { name: "disabled", marketplace: "", version: null, enabled: false }];
  assert.deepEqual(normalizeInstalledPlugins({ plugins }), plugins);
  assert.deepEqual(normalizeInstalledPlugins({ plugins: [] }), []);
  assert.deepEqual(normalizeInstalledPlugins({ plugins: [{ ...plugins[0], installedFrom: "private-path", extra: "hidden" }] }), [plugins[0]]);
  for (const bad of [{}, { plugins: null }, { plugins: [{ ...plugins[0], name: "" }] },
    { plugins: [{ ...plugins[0], enabled: "true" }] }, { plugins: [{ name: "fixture" }] }]) {
    assert.throws(() => normalizeInstalledPlugins(bad));
  }
});
test("profile library preserves user-defined ordered groups and rejects invalid references", () => {
  assert.deepEqual(normalizeProfileLibrary(library), library);
  for (const value of [{}, { ...library, groups: [library.groups[0], library.groups[0]] },
    { ...library, profiles: [{ ...library.profiles[0], groupIds: ["missing"] }] }]) assert.throws(() => normalizeProfileLibrary(value));
  assert.deepEqual(sourcePaths(" Q:\\one\r\nQ:\\two\n\nQ:\\one"), ["Q:\\one", "Q:\\two"]);
});
test("profile preview contains only structured resolved capabilities and explicit reconnect state", () => {
  const preview = { profileId: "chosen", profileName: "My profile", revision: "resolved",
    groupNames: ["Everyday"], mcpServers: [{ name: "fixture", sourceFile: "Q:\\mcp.json" }], skillDirectories: ["Q:\\skills"],
    warnings: ["An explicit override"], addedServers: ["fixture"], removedServers: [], requiresReconnect: true };
  assert.deepEqual(normalizeProfilePreview(preview), preview);
  assert.throws(() => normalizeProfilePreview({ ...preview, requiresReconnect: "yes" }));
  assert.throws(() => normalizeProfilePreview({ ...preview, mcpServers: [{ name: "missing-origin" }] }));
  assert.deepEqual(normalizeProfilePreview({ ...preview, excludedSkillPlugins: ["fixture-alpha"] }).excludedSkillPlugins, ["fixture-alpha"]);
  assert.throws(() => normalizeProfilePreview({ ...preview, excludedSkillPlugins: "not a list" }));
});

test("profile skill exclusions are optional for old libraries and preserved for new ones", () => {
  assert.equal(normalizeProfileLibrary(library).profiles[0].excludedSkillPlugins, undefined);
  const next = { ...library, profiles: [{ ...library.profiles[0], excludedSkillPlugins: ["fixture-alpha"] }] };
  assert.deepEqual(normalizeProfileLibrary(next).profiles[0].excludedSkillPlugins, ["fixture-alpha"]);
  assert.throws(() => normalizeProfileLibrary({ ...next, profiles: [{ ...next.profiles[0], excludedSkillPlugins: [1] }] }));
});
test("profile status reports only current application and failure state, not a message queue", () => {
  const status = { sessionId: "s", profile: null, applying: true, configurationBlocked: true,
    requiresReconnect: false, error: null };
  assert.deepEqual(normalizeSessionProfile(status, "s"), status);
  assert.throws(() => normalizeSessionProfile(status, "different"));
  assert.throws(() => normalizeSessionProfile({ ...status, applying: "yes" }, "s"));
  assert.throws(() => normalizeSessionProfile({ sessionId: "s", profile: null, operation: null }, "s"));
});

test("MCP exclusions retain safe resolution decisions and reject malformed results", () => {
  const next = { ...library, profiles: [{ ...library.profiles[0], excludedMcpPlugins: ["fixture-alpha"] }] };
  assert.deepEqual(normalizeProfileLibrary(next).profiles[0].excludedMcpPlugins, ["fixture-alpha"]);
  assert.throws(() => normalizeProfileLibrary({ ...next, profiles: [{ ...next.profiles[0], excludedMcpPlugins: [1] }] }));
  const preview = { profileId: "chosen", profileName: "Limited", revision: "resolved",
    groupNames: [], mcpServers: [], skillDirectories: [], warnings: [], addedServers: [], removedServers: [], requiresReconnect: false,
    excludedMcpPlugins: ["fixture-alpha"], mcpExclusions: [{ name: "fixture", action: "keep", reason: "Independent base definition." }],
    resolutionIssues: ["Unknown shadowed source."] };
  assert.deepEqual(normalizeProfilePreview(preview), preview);
  assert.throws(() => normalizeProfilePreview({ ...preview, mcpExclusions: [{ name: "fixture", action: "unexpected", reason: "bad" }] }));
  assert.throws(() => normalizeProfilePreview({ ...preview, resolutionIssues: "not a list" }));
});
