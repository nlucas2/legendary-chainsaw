import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { lineLocation, visibleBidi, type DiffLine } from "../lib/gitWorkspace";
import "./git-diff-lines.css";

export interface GitDiffLinesProps {
  lines: readonly DiffLine[];
  selected: ReadonlySet<number>;
  onChange: (next: Set<number>) => void;
}

const selectableKinds = new Set<DiffLine["kind"]>(["add", "delete", "context"]);

function optionLabel(line: DiffLine): string {
  const kind = line.kind === "add" ? "Added" : line.kind === "delete" ? "Deleted" : "Context";
  return `${kind} line ${lineLocation(line)}`;
}

function lineElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[data-line-index]") : null;
}

export function GitDiffLines({ lines, selected, onChange }: GitDiffLinesProps) {
  const helpId = useId();
  const optionIdPrefix = useId();
  const root = useRef<HTMLDivElement>(null);
  const selectable = useMemo(() => lines.filter((line) => selectableKinds.has(line.kind)), [lines]);
  const selectableIndexes = useMemo(() => selectable.map((line) => line.index), [selectable]);
  const selectableSet = useMemo(() => new Set(selectableIndexes), [selectableIndexes]);
  const [active, setActive] = useState<number | null>(() =>
    selectableIndexes.find((index) => selected.has(index)) ?? selectableIndexes[0] ?? null);
  const anchor = useRef<number | null>(null);
  const drag = useRef<{
    start: number;
    last: number;
    base: Set<number>;
    additive: boolean;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const touch = useRef<{ pointerId: number; index: number; x: number; y: number; moved: boolean } | null>(null);
  const touchClick = useRef<number | null>(null);
  const previousSelectedSize = useRef(selected.size);

  useEffect(() => {
    setActive((current) =>
      current !== null && selectableSet.has(current)
        ? current
        : selectableIndexes.find((index) => selected.has(index)) ?? selectableIndexes[0] ?? null);
    anchor.current = null;
    drag.current = null;
    touch.current = null;
    touchClick.current = null;
  }, [lines, selectableIndexes, selectableSet]);

  useEffect(() => {
    if (selected.size === 0) {
      anchor.current = null;
      if (previousSelectedSize.current > 0) {
        const nativeSelection = window.getSelection();
        if (nativeSelection?.anchorNode && root.current?.contains(nativeSelection.anchorNode)) {
          nativeSelection.removeAllRanges();
        }
      }
    }
    previousSelectedSize.current = selected.size;
  }, [selected]);

  useEffect(() => {
    const finishDrag = () => {
      if (drag.current?.moved) {
        anchor.current = drag.current.start;
        suppressClick.current = true;
        window.setTimeout(() => { suppressClick.current = false; }, 0);
      }
      drag.current = null;
    };
    window.addEventListener("mouseup", finishDrag);
    return () => window.removeEventListener("mouseup", finishDrag);
  }, []);

  function normalizedSelection(): Set<number> {
    return new Set(Array.from(selected).filter((index) => selectableSet.has(index)));
  }

  function range(from: number, to: number): Set<number> {
    const first = selectableIndexes.indexOf(from);
    const last = selectableIndexes.indexOf(to);
    if (first < 0 || last < 0) return new Set();
    const start = Math.min(first, last);
    const end = Math.max(first, last);
    return new Set(selectableIndexes.slice(start, end + 1));
  }

  function emitRange(from: number, to: number, base?: Set<number>) {
    const next = base ? new Set(base) : new Set<number>();
    for (const index of range(from, to)) next.add(index);
    onChange(next);
  }

  function activate(index: number) {
    setActive(index);
    const listbox = document.getElementById(`${optionIdPrefix}-listbox`);
    listbox?.focus({ preventScroll: true });
  }

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    const row = lineElement(event.target);
    const index = Number(row?.dataset.lineIndex);
    if (!Number.isSafeInteger(index) || !selectableSet.has(index)) return;
    if (suppressClick.current) {
      suppressClick.current = false;
      activate(index);
      return;
    }

    const isTouch = touchClick.current === index;
    touchClick.current = null;
    activate(index);
    if (isTouch || event.ctrlKey || event.metaKey) {
      const next = normalizedSelection();
      if (!next.delete(index)) next.add(index);
      onChange(next);
      anchor.current = index;
    } else if (event.shiftKey) {
      const from = anchor.current ?? active ?? index;
      emitRange(from, index);
      if (anchor.current === null) anchor.current = from;
    } else {
      onChange(new Set([index]));
      anchor.current = index;
    }
  }

  function handleMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const row = lineElement(event.target);
    const index = Number(row?.dataset.lineIndex);
    if (!Number.isSafeInteger(index) || !selectableSet.has(index)) return;
    const additive = event.ctrlKey || event.metaKey;
    drag.current = {
      start: event.shiftKey ? anchor.current ?? index : index,
      last: index,
      base: additive ? normalizedSelection() : new Set(),
      additive,
      moved: false,
    };
  }

  function handleMouseMove(event: MouseEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || event.buttons !== 1) return;
    const row = lineElement(event.target);
    const index = Number(row?.dataset.lineIndex);
    if (!Number.isSafeInteger(index) || !selectableSet.has(index) || index === state.last) return;
    state.last = index;
    state.moved = true;
    setActive(index);
    emitRange(state.start, index, state.additive ? state.base : undefined);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch") return;
    suppressClick.current = false;
    const row = lineElement(event.target);
    const index = Number(row?.dataset.lineIndex);
    if (Number.isSafeInteger(index) && selectableSet.has(index)) {
      touch.current = { pointerId: event.pointerId, index, x: event.clientX, y: event.clientY, moved: false };
    }
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const state = touch.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - state.x, event.clientY - state.y) > 10) state.moved = true;
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const state = touch.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (state.moved) {
      touchClick.current = null;
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 500);
    } else {
      touchClick.current = state.index;
    }
    touch.current = null;
  }

  function moveActive(event: KeyboardEvent<HTMLDivElement>, destination: number) {
    const from = active ?? destination;
    setActive(destination);
    if (event.shiftKey) {
      const start = anchor.current ?? from;
      emitRange(start, destination, event.ctrlKey || event.metaKey ? normalizedSelection() : undefined);
      if (anchor.current === null) anchor.current = start;
    }
    const listbox = event.currentTarget;
    requestAnimationFrame(() => {
      listbox.querySelector<HTMLElement>(`[data-line-index="${destination}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!selectableIndexes.length) return;
    const position = Math.max(0, selectableIndexes.indexOf(active ?? selectableIndexes[0]));
    let destination: number | null = null;
    if (event.key === "ArrowDown") {
      destination = selectableIndexes[Math.min(selectableIndexes.length - 1, position + 1)];
    } else if (event.key === "ArrowUp") {
      destination = selectableIndexes[Math.max(0, position - 1)];
    } else if (event.key === "Home") {
      destination = selectableIndexes[0];
    } else if (event.key === "End") {
      destination = selectableIndexes[selectableIndexes.length - 1];
    } else if ((event.key === " " || event.key === "Enter") && active !== null) {
      event.preventDefault();
      if (event.shiftKey) {
        const start = anchor.current ?? active;
        emitRange(start, active, event.ctrlKey || event.metaKey ? normalizedSelection() : undefined);
        if (anchor.current === null) anchor.current = start;
      } else {
        const next = normalizedSelection();
        if (!next.delete(active)) next.add(active);
        onChange(next);
        anchor.current = active;
      }
      return;
    }
    if (destination !== null) {
      event.preventDefault();
      moveActive(event, destination);
    }
  }

  return <div ref={root} className="git-panel-diff git-diff-lines" role="region" aria-label="Selected file unified diff">
    <p className="git-diff-lines-help" id={helpId}>
      {selectableIndexes.length ? <>
        Click/drag to select. Shift extends a range; Ctrl/Cmd toggles. Keyboard: Up/Down, Home/End, Space/Enter.
        Left/Right scrolls long lines. Touch: tap to toggle.
      </> : "Metadata-only preview: there are no source lines to select."}
    </p>
    <div id={`${optionIdPrefix}-listbox`} className="git-diff-lines-list" role="listbox"
      aria-label="Diff lines" aria-multiselectable="true" aria-describedby={helpId}
      aria-activedescendant={active === null ? undefined : `${optionIdPrefix}-${active}`} tabIndex={0}
      onClick={handleClick} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
      onKeyDown={handleKeyDown} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp} onPointerCancel={() => { touch.current = null; touchClick.current = null; }}>
      {lines.map((line) => {
        const isSelectable = selectableSet.has(line.index);
        const isSelected = isSelectable && selected.has(line.index);
        return <div key={line.index}
          id={isSelectable ? `${optionIdPrefix}-${line.index}` : undefined}
          className={`git-diff-line ${line.kind}${isSelected ? " selected" : ""}${active === line.index ? " active" : ""}`}
          role={isSelectable ? "option" : "presentation"}
          aria-selected={isSelectable ? isSelected : undefined}
          aria-label={isSelectable ? optionLabel(line) : undefined}
          data-line-index={isSelectable ? line.index : undefined}>
          <span className="git-diff-number" aria-hidden="true">{line.oldLine ?? ""}</span>
          <span className="git-diff-number" aria-hidden="true">{line.newLine ?? ""}</span>
          <code>{visibleBidi(line.text) || " "}</code>
        </div>;
      })}
    </div>
  </div>;
}
