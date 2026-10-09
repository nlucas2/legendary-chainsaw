/** Validate presentation-only Mermaid input before it reaches the DOM renderer. */
export function mermaidPolicyError(source: string): string | null {
  if (/^\s*---(?:\r?\n|$)/.test(source) || /%%\s*\{/.test(source)) {
    return "Diagram configuration directives are not enabled.";
  }
  if (/(?:^|;)\s*click\s/im.test(source) ||
      /\b(?:img|icon)\s*:|<\s*(?:img|image|iframe|object|embed|link|style|script)\b/i.test(source)) {
    return "Embedded resources and click actions are not enabled.";
  }
  for (const match of source.matchAll(/(?:^|;)[ \t]*(?:style|classDef|linkStyle)[ \t]+([^\r\n;]*)/gim)) {
    // Let Mermaid interpret styling, but do not allow stylesheet breakout or
    // resource loads. Escaped commas are ordinary Mermaid dash/colour syntax.
    if (/[{}<>@]|\/\*|\*\/|\\(?!,)|\b(?:url|expression)\s*\(/i.test(match[1])) {
      return "Styles cannot load external resources or inject CSS rules.";
    }
  }
  return null;
}
