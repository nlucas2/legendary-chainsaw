import { isHumanMessage } from "./messageOrigin.ts";
import type { SessionEvent } from "./types.ts";

export function recentPrompts(events: readonly SessionEvent[], submitted: readonly string[]): string[] {
  const history = events.filter(isHumanMessage)
    .map((event) => event.data.content).filter((content): content is string => typeof content === "string" && !!content.trim());
  // Native history may already contain a locally submitted prompt.
  return [...new Set([...history, ...submitted].reverse())].slice(0, 100).reverse();
}

export class PromptHistoryNavigation {
  private entries: string[] | null = null;
  private index = 0;
  private draft = "";

  reset() { this.entries = null; }

  move(history: readonly string[], direction: -1 | 1, current: string): string | null {
    if (!this.entries) {
      if (direction === 1 || !history.length) return null;
      this.entries = [...history];
      this.index = history.length;
      this.draft = current;
    }
    const next = Math.max(0, Math.min(this.entries.length, this.index + direction));
    if (next === this.index) return null;
    if (this.index < this.entries.length) this.entries[this.index] = current;
    this.index = next;
    if (next === this.entries.length) {
      const draft = this.draft;
      this.reset();
      return draft;
    }
    return this.entries[next];
  }
}

export function atComposerEdge(input: HTMLTextAreaElement, direction: -1 | 1): boolean {
  if (input.selectionStart !== input.selectionEnd) return false;
  const caret = input.selectionStart;
  if (direction === -1 && caret === 0) return true;
  if (direction === 1 && caret === input.value.length) return true;
  if (direction === -1 && input.value.slice(0, caret).includes("\n")) return false;
  if (direction === 1 && input.value.slice(caret).includes("\n")) return false;

  // A logical line can wrap over several screen lines. Measure the caret on an
  // invisible mirror so Up/Down within wrapped text still moves the real caret.
  const style = getComputedStyle(input);
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  for (const property of ["font-family", "font-size", "font-weight", "font-style", "line-height",
    "letter-spacing", "word-spacing", "text-indent", "text-transform", "tab-size", "direction",
    "padding-top", "padding-right", "padding-bottom", "padding-left", "word-break", "overflow-wrap"]) {
    mirror.style.setProperty(property, style.getPropertyValue(property));
  }
  Object.assign(mirror.style, { position: "fixed", top: "0", left: "0", visibility: "hidden",
    pointerEvents: "none", width: `${input.clientWidth}px`, boxSizing: "border-box",
    whiteSpace: input.wrap === "off" ? "pre" : "pre-wrap" });
  const marker = () => {
    const span = document.createElement("span");
    span.textContent = "\u200b";
    return span;
  };
  const first = marker(), cursor = marker(), last = marker();
  mirror.append(first, input.value.slice(0, caret), cursor, input.value.slice(caret), last);
  document.body.append(mirror);
  try {
    const edge = direction === -1 ? first : last;
    return Math.abs(cursor.getBoundingClientRect().top - edge.getBoundingClientRect().top) < 1;
  } finally { mirror.remove(); }
}
