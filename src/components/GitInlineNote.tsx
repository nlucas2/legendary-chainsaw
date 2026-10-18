import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./git-inline-note.css";

interface GitInlineNoteProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: (floating: boolean) => ReactNode;
}

interface Placement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export function GitInlineNote({ anchor, onClose, children }: GitInlineNoteProps) {
  const editor = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  useLayoutEffect(() => {
    const element = editor.current;
    if (!element || !anchor) { setPlacement(null); return; }
    const file = anchor.closest<HTMLElement>(".git-file-review");
    const panel = anchor.closest<HTMLElement>(".git-panel, [role='dialog']");
    const diff = anchor.closest<HTMLElement>(".git-diff-lines");
    const media = window.matchMedia("(min-width: 761px)");
    let frame = 0;
    const update = () => {
      frame = 0;
      if (!media.matches || !anchor.isConnected) { setPlacement(null); return; }
      const viewport = window.visualViewport;
      const viewLeft = viewport?.offsetLeft ?? 0;
      const viewTop = viewport?.offsetTop ?? 0;
      const viewRight = viewLeft + (viewport?.width ?? window.innerWidth);
      const viewBottom = viewTop + (viewport?.height ?? window.innerHeight);
      const bounds = panel?.getBoundingClientRect();
      const header = panel?.querySelector<HTMLElement>(".git-panel-header");
      const headerBottom = header && getComputedStyle(header).position === "sticky"
        ? header.getBoundingClientRect().bottom : 0;
      const left = Math.max(viewLeft, bounds?.left ?? viewLeft) + 8;
      const right = Math.min(viewRight, bounds?.right ?? viewRight) - 8;
      const top = Math.max(viewTop, bounds?.top ?? viewTop, headerBottom) + 8;
      const bottom = Math.min(viewBottom, bounds?.bottom ?? viewBottom) - 8;
      const row = anchor.getBoundingClientRect();
      const visibleDiff = diff?.getBoundingClientRect();
      if (right <= left || bottom <= top || row.bottom <= Math.max(top, visibleDiff?.top ?? top)
        || row.top >= Math.min(bottom, visibleDiff?.bottom ?? bottom)) {
        setPlacement(null);
        return;
      }
      const width = Math.min(400, right - left);
      const height = Math.min(element.scrollHeight, bottom - top);
      const desiredTop = row.bottom + 8 + height <= bottom ? row.bottom + 8 : row.top - height - 8;
      const next = {
        left: Math.max(left, Math.min(visibleDiff?.left ?? row.left, right - width)),
        top: Math.max(top, Math.min(desiredTop, bottom - height)),
        width,
        maxHeight: bottom - top,
      };
      setPlacement((previous) => previous && previous.left === next.left && previous.top === next.top
        && previous.width === next.width && previous.maxHeight === next.maxHeight ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    // content-visibility creates a fixed-position containing block in continuous cards.
    file?.classList.add("git-has-inline-note");
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    if (panel) observer.observe(panel);
    if (diff) observer.observe(diff);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    media.addEventListener("change", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      file?.classList.remove("git-has-inline-note");
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      media.removeEventListener("change", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [anchor]);

  useLayoutEffect(() => {
    if (!placement || !anchor) return;
    const panel = anchor.closest(".git-panel, [role='dialog']");
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !(event.target instanceof Node)
        || !(panel ?? anchor.closest(".git-file-review"))?.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [!!placement, anchor, onClose]);

  return <div ref={editor} className={`git-panel-comment-editor git-note-editor${placement ? " git-inline-note" : ""}`}
    style={placement ?? undefined} role={placement ? "region" : undefined}
    aria-label={placement ? "Inline local review note" : undefined}>
    {children(!!placement)}
  </div>;
}
