export type LinkDestination =
  | { kind: "external"; href: string }
  | { kind: "fragment"; href: string }
  | { kind: "unsupported"; reason: string };

export function linkDestination(value: string | undefined): LinkDestination {
  const href = value?.trim() ?? "";
  if (href.startsWith("#")) return { kind: "fragment", href };
  if (href) {
    try {
      const url = new URL(href.startsWith("//") ? `https:${href}` : href);
      if (["http:", "https:", "mailto:"].includes(url.protocol)) return { kind: "external", href: url.href };
    } catch {
      return { kind: "unsupported", reason: "This relative or invalid link cannot be opened. Use a full web URL; repository-file links are not supported here." };
    }
  }
  return { kind: "unsupported", reason: "This link type is not supported. Only web URLs, email links, and page anchors can be opened." };
}
