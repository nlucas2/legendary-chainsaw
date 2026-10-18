import { visibleBidi, type DiffLine } from "../lib/gitWorkspace";

export function DiffLineContent({ line, showNumbers = true }: { line: DiffLine; showNumbers?: boolean }) {
  return <>
    {showNumbers && <>
      <span className="git-diff-number" aria-hidden="true">{line.oldLine ?? ""}</span>
      <span className="git-diff-number" aria-hidden="true">{line.newLine ?? ""}</span>
    </>}
    <code>{visibleBidi(line.text) || " "}</code>
  </>;
}
