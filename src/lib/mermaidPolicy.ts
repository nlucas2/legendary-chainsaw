import type { MermaidConfig } from "mermaid";

type FlowchartLayout = Pick<NonNullable<MermaidConfig["flowchart"]>, "curve" | "nodeSpacing" | "rankSpacing">;
type PreparedMermaid = { source: string; flowchart: FlowchartLayout } | { error: string };
const curves = ["basis", "bumpX", "bumpY", "cardinal", "catmullRom", "linear", "monotoneX", "monotoneY",
  "natural", "step", "stepAfter", "stepBefore", "rounded"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Extract bounded layout options; never pass user configuration to Mermaid's directive parser. */
export function prepareMermaid(source: string): PreparedMermaid {
  const flowchart: FlowchartLayout = {};
  let diagram = source;
  for (const match of source.matchAll(/%%\s*\{([\s\S]*?)\}%%/g)) {
    const init = /^\s*(?:init|initialize)\s*:\s*([\s\S]+)$/.exec(match[1]);
    if (!init) return { error: "Only init configuration with flowchart layout settings is supported." };
    let config: unknown;
    try { config = JSON.parse(init[1]); }
    catch (error) {
      if (error instanceof SyntaxError) return { error: "Diagram init configuration must be valid JSON." };
      throw error;
    }
    if (!isRecord(config) || Object.keys(config).some((key) => key !== "flowchart") ||
        !isRecord(config.flowchart)) {
      return { error: "Diagram configuration only supports flowchart layout settings: curve, nodeSpacing and rankSpacing." };
    }
    for (const [key, value] of Object.entries(config.flowchart)) {
      if (key === "curve") {
        const curve = curves.find((candidate) => candidate === value);
        if (!curve) return { error: "Unsupported flowchart curve in diagram configuration." };
        flowchart.curve = curve;
      } else if (key === "nodeSpacing" || key === "rankSpacing") {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000) {
          return { error: `Flowchart ${key} must be a number between 0 and 1000.` };
        }
        flowchart[key] = value;
      } else {
        return { error: "Diagram configuration only supports flowchart layout settings: curve, nodeSpacing and rankSpacing." };
      }
    }
    diagram = diagram.replace(match[0], match[0].replace(/[^\r\n]/g, ""));
  }
  const error = sourcePolicyError(diagram);
  return error ? { error } : { source: diagram, flowchart };
}

export function mermaidPolicyError(source: string): string | null {
  const result = prepareMermaid(source);
  return "error" in result ? result.error : null;
}

function sourcePolicyError(source: string): string | null {
  if (/^\s*---(?:\r?\n|$)/.test(source) || /%%\s*\{/.test(source)) {
    return "Unsupported or incomplete diagram configuration. Use a JSON init directive with flowchart layout settings.";
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
