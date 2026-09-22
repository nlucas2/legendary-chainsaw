export interface SessionSkill {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  path?: string;
  pluginName?: string;
  userInvocable: boolean;
}

export interface SessionSkills {
  sessionId: string;
  cwd: string | null;
  skills: SessionSkill[];
  warnings: string[];
  errors: string[];
}

export interface SessionSkillPreview {
  sessionId: string;
  cwd: string;
  discovered: SessionSkill[];
  added: string[];
  changed: string[];
  notDiscovered: string[];
  errors: string[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function normalizeSessionSkills(value: unknown, sessionId: string): SessionSkills {
  if (!record(value) || value.sessionId !== sessionId || !(value.cwd === null || typeof value.cwd === "string")
    || !Array.isArray(value.skills)) throw new Error("The daemon returned invalid session skill metadata.");
  const skills = value.skills.map((skill): SessionSkill => {
    if (!record(skill) || typeof skill.name !== "string" || !skill.name
      || typeof skill.description !== "string" || typeof skill.enabled !== "boolean"
      || typeof skill.source !== "string" || typeof skill.userInvocable !== "boolean"
      || !(skill.path === undefined || typeof skill.path === "string")
      || !(skill.pluginName === undefined || typeof skill.pluginName === "string")) {
      throw new Error("The daemon returned an invalid session skill.");
    }

    return { name: skill.name, description: skill.description, enabled: skill.enabled, source: skill.source,
      path: skill.path, pluginName: skill.pluginName, userInvocable: skill.userInvocable };
  });
  if (new Set(skills.map((skill) => skill.name)).size !== skills.length) throw new Error("The daemon returned duplicate skill names.");
  const messages = (key: "warnings" | "errors"): string[] => {
    const items = value[key];
    if (!Array.isArray(items) || !items.every((item) => typeof item === "string")) {
      throw new Error("The daemon returned invalid skill-loading diagnostics.");
    }
    return items;
  };
  return { sessionId, cwd: value.cwd, skills, warnings: messages("warnings"), errors: messages("errors") };
}

export function normalizeSkillPreview(value: unknown, sessionId: string): SessionSkillPreview {
  if (!record(value) || typeof value.cwd !== "string") throw new Error("Invalid skill discovery preview.");
  const snapshot = normalizeSessionSkills({ ...value, skills: value.discovered, warnings: [] }, sessionId);
  const names = (key: "added" | "changed" | "notDiscovered") => {
    const items = value[key];
    if (!Array.isArray(items) || !items.every((item) => typeof item === "string")) throw new Error("Invalid skill discovery changes.");
    return items;
  };
  return { sessionId, cwd: value.cwd, discovered: snapshot.skills,
    added: names("added"), changed: names("changed"), notDiscovered: names("notDiscovered"), errors: snapshot.errors };
}
