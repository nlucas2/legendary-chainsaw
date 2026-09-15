export interface SlashCommand { name: string; description: string }
export const CLIENT_COMMANDS: SlashCommand[] = [
  { name: "ask", description: "Ask a transient, no-tools question about this conversation" },
  { name: "fork", description: "Copy this conversation into a separate session" },
];

export function slashCommandSuggestions(raw: unknown, input: string): SlashCommand[] {
  const commands = raw && typeof raw === "object" && "commands" in raw && Array.isArray(raw.commands) ? raw.commands : [];
  const known = new Map(CLIENT_COMMANDS.map((command) => [command.name, command]));
  for (const item of commands) {
    if (!item || typeof item !== "object" || typeof item.name !== "string" || known.has(item.name)) continue;
    known.set(item.name, { name: item.name, description: typeof item.description === "string" ? item.description : "Session command" });
  }
  const query = input.trimStart().slice(1).split(/\s/, 1)[0].toLowerCase();
  return [...known.values()].filter((command) => command.name.toLowerCase().includes(query)).slice(0, 8);
}
