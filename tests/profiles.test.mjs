import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeProfileLibrary, normalizeProfilePreview, normalizeSessionProfile, sourcePaths,
} from "../src/lib/profiles.ts";

const library = { directory: "Q:\\profiles", revision: "r1",
  groups: [{ id: "base", name: "Everyday", mcpConfigFiles: ["mcp.json"], skillDirectories: ["skills"] }],
  profiles: [{ id: "chosen", name: "My profile", groupIds: ["base"] }] };
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
});
test("profile status reports only current application and failure state, not a message queue", () => {
  const status = { sessionId: "s", profile: null, applying: true, configurationBlocked: true,
    requiresReconnect: false, error: null };
  assert.deepEqual(normalizeSessionProfile(status, "s"), status);
  assert.throws(() => normalizeSessionProfile(status, "different"));
  assert.throws(() => normalizeSessionProfile({ ...status, applying: "yes" }, "s"));
  assert.throws(() => normalizeSessionProfile({ sessionId: "s", profile: null, operation: null }, "s"));
});
