import { memo, useCallback, useEffect, useRef, useState } from "react";
import { GitFileReview, type GitFileReviewProps } from "./GitFileReview";
import { visiblePath, type GitReviewFile } from "../lib/gitWorkspace";

const PAGE_SIZE = 3;

function readingTop(root: HTMLElement) {
  const header = root.querySelector<HTMLElement>(".git-panel-header");
  const inset = header && getComputedStyle(header).position === "sticky" ? header.offsetHeight : 0;
  return root.getBoundingClientRect().top + root.clientTop + inset + 12;
}

export interface GitDiffNavigation {
  path: string;
  sequence: number;
}

export const GitDiffFeed = memo(function GitDiffFeed({ files, scrollRoot, navigation, onActivePathChange, ...props }: Omit<GitFileReviewProps, "path" | "continuous" | "onLoaded"> & {
  files: GitReviewFile[];
  scrollRoot: HTMLElement | null;
  navigation: GitDiffNavigation | null;
  onActivePathChange: (path: string) => void;
}) {
  const [count, setCount] = useState(PAGE_SIZE);
  const [requested, setRequested] = useState(() => new Set(files.slice(0, PAGE_SIZE).map((file) => file.path)));
  const [loaded, setLoaded] = useState(new Set<string>());
  const feed = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const pendingJump = useRef<{ path: string; stableFrames: number } | null>(null);
  const visible = files.slice(0, count);
  const ready = [...requested].every((path) => loaded.has(path));
  const more = count < files.length;
  const expose = useCallback((start: number) => {
    const batch = files.slice(start, start + PAGE_SIZE);
    setCount((previous) => Math.max(previous, Math.min(files.length, start + PAGE_SIZE)));
    setRequested((previous) => {
      if (batch.every((file) => previous.has(file.path))) return previous;
      return new Set([...previous, ...batch.map((file) => file.path)]);
    });
  }, [files]);
  const onLoaded = useCallback((path: string) => {
    setLoaded((previous) => previous.has(path) ? previous : new Set(previous).add(path));
  }, []);
  useEffect(() => {
    if (!navigation) return;
    const index = files.findIndex((file) => file.path === navigation.path);
    if (index < 0) return;
    pendingJump.current = { path: navigation.path, stableFrames: 0 };
    expose(index);
  }, [navigation, files, expose]);

  useEffect(() => {
    if (!scrollRoot || !feed.current) return;
    const slots = Array.from(feed.current.querySelectorAll<HTMLElement>(".git-diff-slot"));
    let frame = 0;
    const update = () => {
      frame = 0;
      if (!slots.length) return;
      const top = readingTop(scrollRoot);
      if (pendingJump.current) {
        const jump = pendingJump.current;
        const slot = slots.find((slot) => slot.dataset.feedPath === jump.path);
        if (slot) {
          const desired = scrollRoot.scrollTop + slot.getBoundingClientRect().top - top;
          const bounded = Math.max(0, Math.min(desired, scrollRoot.scrollHeight - scrollRoot.clientHeight));
          const aligned = Math.abs(scrollRoot.scrollTop - bounded) < 1;
          scrollRoot.scrollTo({ top: bounded });
          // content-visibility can expand earlier cards after the first scroll/layout pass.
          // Keep the anchor until loaded previews have stayed aligned across paints.
          jump.stableFrames = ready && loaded.has(jump.path) && aligned ? jump.stableFrames + 1 : 0;
          if (jump.stableFrames >= 2) pendingJump.current = null;
          else if (ready) schedule();
        }
        return;
      }
      let low = 0, high = slots.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (slots[middle].getBoundingClientRect().bottom <= top) low = middle + 1;
        else high = middle;
      }
      const path = slots[Math.min(low, slots.length - 1)].dataset.feedPath;
      if (path) onActivePathChange(path);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const cancelJump = () => { pendingJump.current = null; schedule(); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select")) return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) cancelJump();
    };
    scrollRoot.addEventListener("scroll", schedule, { passive: true });
    scrollRoot.addEventListener("wheel", cancelJump, { passive: true });
    scrollRoot.addEventListener("touchstart", cancelJump, { passive: true });
    scrollRoot.addEventListener("pointerdown", cancelJump);
    scrollRoot.addEventListener("keydown", onKeyDown);
    const observer = new ResizeObserver(schedule);
    observer.observe(scrollRoot);
    for (const slot of slots) observer.observe(slot);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scrollRoot.removeEventListener("scroll", schedule);
      scrollRoot.removeEventListener("wheel", cancelJump);
      scrollRoot.removeEventListener("touchstart", cancelJump);
      scrollRoot.removeEventListener("pointerdown", cancelJump);
      scrollRoot.removeEventListener("keydown", onKeyDown);
    };
  }, [count, loaded, ready, scrollRoot, onActivePathChange, navigation]);

  // Jumping reserves intervening slots, but only nearby batches request file contents.
  useEffect(() => {
    if (!ready || !feed.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (pendingJump.current) return;
      const entry = entries.find((entry) => entry.isIntersecting
        && (!scrollRoot || entry.boundingClientRect.bottom > readingTop(scrollRoot)));
      if (!entry) return;
      const path = entry.target.getAttribute("data-feed-path");
      const index = files.findIndex((file) => file.path === path);
      if (index >= 0) { observer.disconnect(); expose(index); }
    }, { root: scrollRoot, rootMargin: "0px 0px 200px 0px" });
    for (const slot of feed.current.querySelectorAll<HTMLElement>(".git-diff-slot")) {
      if (!requested.has(slot.dataset.feedPath!)) observer.observe(slot);
    }
    return () => observer.disconnect();
  }, [count, requested, ready, files, scrollRoot, expose]);

  useEffect(() => {
    if (!ready || !more || !sentinel.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!pendingJump.current && entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        expose(count);
      }
    }, { root: scrollRoot, rootMargin: "0px 0px 200px 0px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [ready, more, count, scrollRoot, expose]);
  return <div ref={feed} className="git-diff-feed" aria-label="Continuous Git diffs">
    {visible.map((file, index) => <div key={file.path} className="git-diff-slot" data-feed-path={file.path}
      data-navigation-target={navigation?.path === file.path ? true : undefined}>
      {requested.has(file.path)
        ? <GitFileReview {...props} view={file.view} path={file.path} continuous onLoaded={onLoaded} />
        : <div className="git-diff-placeholder">
          <h3>{visiblePath(file.path)}</h3>
          <button type="button" onClick={() => expose(index)}>Load diff for {visiblePath(file.path)}</button>
        </div>}
    </div>)}
    {more && <div ref={sentinel} className="git-diff-load-more">
      <button type="button" disabled={!ready} onClick={() => expose(count)}>
        {ready ? `Load more diffs (${files.length - count} remaining)` : "Loading file previews..."}
      </button>
    </div>}
    {!more && files.length > 0 && <p className="git-panel-empty">End of {files.length} files.{requested.size < files.length && " Skipped previews load when scrolled into view."}</p>}
  </div>;
});
