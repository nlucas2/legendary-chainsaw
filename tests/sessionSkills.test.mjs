import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSessionSkills, normalizeSkillPreview } from "../src/lib/sessionSkills.ts";

const valid = {
  sessionId: "a", cwd: "Q:\\repo", warnings: [], errors: [],
  skills: [{ name: "repo-skill", description: "Review the repo", enabled: false, source: "project",
    path: "Q:\\repo\\.github\\skills\\repo-skill\\SKILL.md", userInvocable: true }],
};
test("effective skill snapshots preserve disabled state, paths, and native diagnostics", () => {
  const next = { ...valid, warnings: ["duplicate"], errors: ["invalid manifest"] };
  assert.deepEqual(normalizeSessionSkills(next, "a"), { ...next, skills: [{ ...next.skills[0], pluginName: undefined }] });
  for (const patch of [{ sessionId: "b" }, { cwd: 4 }, { warnings: null }, { errors: [false] },
    { skills: [valid.skills[0], valid.skills[0]] }, { skills: [{ ...valid.skills[0], enabled: "yes" }] },
    { skills: [{ name: "discovery-only", description: "missing effective state" }] }]) {
    assert.throws(() => normalizeSessionSkills({ ...valid, ...patch }, "a"));
  }
});

test("skill previews are separate from effective enablement and reject malformed change lists", () => {
  const preview = { sessionId: "a", cwd: "Q:\\repo", discovered: valid.skills,
    added: ["new"], changed: ["same-name-new-path"], notDiscovered: ["old-source"], errors: [] };
  assert.equal(normalizeSkillPreview(preview, "a").discovered[0].enabled, false);
  assert.deepEqual(normalizeSkillPreview(preview, "a").added, ["new"]);
  assert.throws(() => normalizeSkillPreview({ ...preview, added: null }, "a"));
  assert.throws(() => normalizeSkillPreview(preview, "b"));
});
