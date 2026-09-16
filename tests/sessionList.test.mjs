import test from "node:test";
import assert from "node:assert/strict";
import { filterSessions, groupSessions, SessionArchiveChanges } from "../src/lib/sessionList.ts";

const session = (id, extra = {}) => ({ sessionId: id, title: id, tags: [], pinned: false, ...extra });

test("archive scope filters without losing folders, tags, pins or sorting", () => {
  const rows = [
    session("current", { folder: "DBK", tags: ["security"] }),
    session("old", { archived: true, folder: "DBK", tags: ["security"], pinned: true }),
    session("legacy"),
  ];
  assert.deepEqual(filterSessions(rows, "", "current").map((row) => row.sessionId), ["current", "legacy"]);
  assert.deepEqual(filterSessions(rows, "DBK", "archived"), [rows[1]]);
  assert.deepEqual(filterSessions(rows, "SECURITY", "all"), rows.slice(0, 2));
  assert.deepEqual(filterSessions(rows, "missing", "all"), []);
  assert.deepEqual(groupSessions(filterSessions(rows, "", "archived")), [{
    key: "pinned", name: "Pinned", pinned: true, sessions: [rows[1]],
  }]);
  assert.equal(rows[1].folder, "DBK");
  assert.deepEqual(rows[1].tags, ["security"]);
});

test("folder boundaries and unfiled entries have distinct stable groups", () => {
  const rows = [session("loose"), session("one", { folder: "DBK" }), session("two", { folder: "App" }), session("pin", { pinned: true, folder: "DBK" })];
  const before = structuredClone(rows);
  assert.deepEqual(groupSessions(rows).map(({ key, name, sessions }) => [key, name, sessions.map((row) => row.sessionId)]), [
    ["pinned", "Pinned", ["pin"]], ["folder:App", "App", ["two"]], ["folder:DBK", "DBK", ["one"]], ["loose", "Unfiled", ["loose"]],
  ]);
  assert.deepEqual(rows, before);
  assert.deepEqual(groupSessions([]), []);
});

test("narrow archive events win over stale reads without replacing unrelated fields", () => {
  const changes = new SessionArchiveChanges();
  const read = changes.checkpoint();
  changes.record("a", true);
  const original = session("a", { archived: false, folder: "Latest folder", tags: ["current"] });
  assert.deepEqual(changes.reconcile(original, read), { ...original, archived: true });
  assert.equal(changes.changedSince("a", read), true);
  assert.equal(changes.changedSince("b", read), false);
  const newerRead = changes.checkpoint();
  assert.equal(changes.reconcile(original, newerRead), original);
  changes.record("a", false);
  assert.equal(changes.reconcile({ ...original, archived: true }, newerRead).archived, false);
  assert.equal(changes.reconcile(session("b"), read).sessionId, "b");
});
