export const MAX_HIGHLIGHT_LENGTH = 100_000;
export const MAX_DIAGRAM_LENGTH = 30_000;

const aliases: Record<string, string> = {
  js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  sh: "bash", shell: "bash", shellscript: "bash", ps: "powershell", ps1: "powershell", pwsh: "powershell",
  py: "python", rs: "rust", cs: "csharp", "c#": "csharp", "c++": "cpp", yml: "yaml",
  html: "xml", svg: "xml", md: "markdown", docker: "dockerfile", text: "plaintext", txt: "plaintext", console: "plaintext", log: "plaintext",
};
export function codeLanguage(value: string): string {
  const name = value.trim().toLowerCase().split(/\s+/)[0];
  return aliases[name] ?? name;
}

export function shellLanguage(toolName: string): string | undefined {
  const name = toolName.split(/[.:/-]/).pop()?.toLowerCase();
  return name && ["powershell", "pwsh"].includes(name) ? "powershell"
    : name && ["bash", "sh", "shell"].includes(name) ? "bash" : undefined;
}

export function rawOutput(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

export function formattedJson(source: string): string | null {
  if (source.length > MAX_HIGHLIGHT_LENGTH || !/^\s*[\[{]/.test(source)) return null;
  try { return JSON.stringify(JSON.parse(source), null, 2); }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
}

export function hasMarkdownFormatting(source: string): boolean {
  return /^(?: {0,3}(?:`{3,}|~{3,}|#{1,6}\s|>\s|[-*+]\s|\d+[.)]\s)|\s*\|.+\|)/m.test(source)
    || /!?\[[^\]\n]+\]\([^)]+\)|\*\*[^*\n]+\*\*|`[^`\n]+`/.test(source);
}
