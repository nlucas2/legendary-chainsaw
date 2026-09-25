export interface ProfileGroup {
  id: string;
  name: string;
  mcpConfigFiles: string[];
  skillDirectories: string[];
}

export interface InstalledPlugin {
  name: string;
  marketplace: string;
  version: string | null;
  enabled: boolean;
}

export interface SessionProfile {
  id: string;
  name: string;
  groupIds: string[];
  excludedSkillPlugins?: string[];
  excludedMcpPlugins?: string[];
}

export interface ProfileLibrary {
  directory: string;
  revision: string;
  groups: ProfileGroup[];
  profiles: SessionProfile[];
}

export interface ProfilePreview {
  profileId: string | null;
  profileName: string;
  revision: string;
  groupNames: string[];
  mcpServers: { name: string; sourceFile: string }[];
  skillDirectories: string[];
  excludedSkillPlugins?: string[];
  excludedMcpPlugins?: string[];
  mcpExclusions?: { name: string; action: string; reason: string }[];
  resolutionIssues?: string[];
  warnings: string[];
  addedServers: string[];
  removedServers: string[];
  requiresReconnect: boolean;
}

export interface SessionProfileStatus {
  sessionId: string;
  profile: { id: string; name: string; revision: string; groupIds?: string[] } | null;
  applying: boolean;
  configurationBlocked: boolean;
  requiresReconnect: boolean;
  error: string | null;
}

export interface NewSessionProfileChoice {
  profileId: string | null;
  revision?: string;
  pending: boolean;
  error?: string;
}

export const DEFAULT_PROFILE_CHOICE: NewSessionProfileChoice = { profileId: null, pending: false };
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const nullableText = (value: unknown): value is string | null => value === null || text(value);

export function normalizeInstalledPlugins(value: unknown): InstalledPlugin[] {
  if (!record(value) || !Array.isArray(value.plugins)) throw new Error("The daemon returned an invalid plugin inventory.");
  return value.plugins.map((plugin) => {
    if (!record(plugin) || !text(plugin.name) || !plugin.name.trim() || !text(plugin.marketplace)
      || !nullableText(plugin.version) || typeof plugin.enabled !== "boolean") throw new Error("Invalid installed plugin.");
    return { name: plugin.name, marketplace: plugin.marketplace, version: plugin.version, enabled: plugin.enabled };
  });
}

export function normalizeProfileLibrary(value: unknown): ProfileLibrary {
  if (!record(value) || !text(value.directory) || !text(value.revision)
    || !Array.isArray(value.groups) || !Array.isArray(value.profiles)) throw new Error("The daemon returned an invalid profile library.");
  const groups = value.groups.map((group): ProfileGroup => {
    if (!record(group) || !text(group.id) || !group.id || !text(group.name)
      || !strings(group.mcpConfigFiles) || !strings(group.skillDirectories)) throw new Error("Invalid profile group.");
    return { id: group.id, name: group.name, mcpConfigFiles: group.mcpConfigFiles, skillDirectories: group.skillDirectories };
  });
  const groupIds = new Set(groups.map((group) => group.id));
  const profiles = value.profiles.map((profile): SessionProfile => {
    if (!record(profile) || !text(profile.id) || !profile.id || !text(profile.name) || !strings(profile.groupIds)
      || profile.groupIds.some((id) => !groupIds.has(id))
      || !(profile.excludedSkillPlugins === undefined || strings(profile.excludedSkillPlugins))
      || !(profile.excludedMcpPlugins === undefined || strings(profile.excludedMcpPlugins))) throw new Error("Invalid profile or unresolved group reference.");
    return { id: profile.id, name: profile.name, groupIds: profile.groupIds,
      ...(profile.excludedSkillPlugins === undefined ? {} : { excludedSkillPlugins: profile.excludedSkillPlugins }),
      ...(profile.excludedMcpPlugins === undefined ? {} : { excludedMcpPlugins: profile.excludedMcpPlugins }) };
  });
  if (groupIds.size !== groups.length || new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new Error("The profile library has duplicate identifiers.");
  }
  return { directory: value.directory, revision: value.revision, groups, profiles };
}

export function normalizeProfilePreview(value: unknown): ProfilePreview {
  if (!record(value) || !nullableText(value.profileId) || !text(value.profileName) || !text(value.revision)
    || !strings(value.groupNames) || !strings(value.skillDirectories) || !strings(value.warnings)
    || !strings(value.addedServers) || !strings(value.removedServers) || !Array.isArray(value.mcpServers)
    || typeof value.requiresReconnect !== "boolean"
    || !(value.excludedSkillPlugins === undefined || strings(value.excludedSkillPlugins))
    || !(value.excludedMcpPlugins === undefined || strings(value.excludedMcpPlugins))
    || !(value.resolutionIssues === undefined || strings(value.resolutionIssues))
    || !(value.mcpExclusions === undefined || Array.isArray(value.mcpExclusions))) throw new Error("The daemon returned an invalid profile preview.");
  const mcpExclusions = value.mcpExclusions?.map((decision: unknown) => {
    if (!record(decision) || !text(decision.name) || !text(decision.action) || !text(decision.reason)
      || !["keep", "exclude", "unresolved", "no-match"].includes(decision.action)) throw new Error("Invalid MCP exclusion decision.");
    return { name: decision.name, action: decision.action, reason: decision.reason };
  });
  const mcpServers = value.mcpServers.map((server) => {
    if (!record(server) || !text(server.name) || !text(server.sourceFile)) throw new Error("Invalid MCP source in profile preview.");
    return { name: server.name, sourceFile: server.sourceFile };
  });
  return { profileId: value.profileId, profileName: value.profileName, revision: value.revision,
    groupNames: value.groupNames, skillDirectories: value.skillDirectories, warnings: value.warnings,
    addedServers: value.addedServers, removedServers: value.removedServers, requiresReconnect: value.requiresReconnect, mcpServers,
    ...(value.excludedSkillPlugins === undefined ? {} : { excludedSkillPlugins: value.excludedSkillPlugins }),
    ...(value.excludedMcpPlugins === undefined ? {} : { excludedMcpPlugins: value.excludedMcpPlugins }),
    ...(mcpExclusions === undefined ? {} : { mcpExclusions }),
    ...(value.resolutionIssues === undefined ? {} : { resolutionIssues: value.resolutionIssues }) };
}

export function normalizeSessionProfile(value: unknown, sessionId: string): SessionProfileStatus {
  if (!record(value) || value.sessionId !== sessionId
    || typeof value.applying !== "boolean" || typeof value.configurationBlocked !== "boolean"
    || typeof value.requiresReconnect !== "boolean" || !nullableText(value.error)) {
    throw new Error("The daemon returned a mismatched or invalid session profile.");
  }
  let profile: SessionProfileStatus["profile"] = null;
  if (value.profile !== null) {
    const raw = value.profile;
    if (!record(raw) || !text(raw.id) || !text(raw.name) || !text(raw.revision)
      || !(raw.groupIds === undefined || strings(raw.groupIds))) throw new Error("Invalid active session profile.");
    profile = { id: raw.id, name: raw.name, revision: raw.revision, groupIds: raw.groupIds };
  }
  return { sessionId, profile, applying: value.applying, configurationBlocked: value.configurationBlocked,
    requiresReconnect: value.requiresReconnect, error: value.error };
}

export function sourcePaths(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((path) => path.trim()).filter(Boolean))];
}
