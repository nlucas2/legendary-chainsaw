import { memo, useMemo, useState } from "react";
import { parseApplyPatch, patchArguments, type PatchFile } from "../lib/applyPatch";
import { rawOutput } from "../lib/codeRendering";
import { visiblePath } from "../lib/gitWorkspace";
import { CodeBlock } from "./CodeBlock";
import { DiffLineContent } from "./DiffLineContent";
import "./git-diff-lines.css";
import "./apply-patch-preview.css";

export const ApplyPatchPreview = memo(function ApplyPatchPreview({ value, preparing, failed }: {
  value: unknown; preparing: boolean; failed: boolean;
}) {
  const [raw, setRaw] = useState(false);
  const args = useMemo(() => patchArguments(value), [value]);
  const parsed = useMemo(() => preparing ? null : args ? parseApplyPatch(args.source)
    : { error: "Patch arguments use an unrecognized format; showing raw arguments." }, [args, preparing]);
  return <section className="detail-block apply-patch-preview" aria-label="Patch request">
    <div className="patch-toolbar"><h4>Patch</h4>
      <label className="output-raw-toggle"><input type="checkbox" checked={raw}
        onChange={(event) => setRaw(event.target.checked)} />Show raw patch</label>
    </div>
    {failed && <p className="patch-notice" role="status">Patch tool failed. These are the requested edits, not confirmation of applied changes.</p>}
    {!raw && preparing && <p className="patch-notice" role="status">Receiving patch arguments...</p>}
    {!raw && parsed?.error && <p className="patch-notice" role="status">{parsed.error}</p>}
    {raw || preparing || !parsed?.files ? <CodeBlock source={rawOutput(value)} forceRaw controls={false} />
      : <>
        <PatchFiles key={args!.source} files={parsed.files} />
        {args?.extra && <details className="patch-extra"><summary>Other arguments</summary>
          <CodeBlock source={rawOutput(args.extra)} language="json" controls={false} />
        </details>}
      </>}
  </section>;
});

function PatchFiles({ files }: { files: PatchFile[] }) {
  const [limit, setLimit] = useState(10);
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  return <>
    <p className="patch-summary">{files.length} file{files.length === 1 ? "" : "s"} · <span className="patch-added">+{added}</span> <span className="patch-removed">−{removed}</span>
      {files.some((file) => file.operation === "delete") && " · Deleted-file contents not included in counts"}</p>
    {files.slice(0, limit).map((file, index) => <PatchFileView key={`${index}:${file.path}`} file={file} />)}
    {files.length > limit && <button type="button" className="patch-load-more" onClick={() => setLimit((value) => value + 10)}>Show more files ({files.length - limit} remaining)</button>}
  </>;
}

function PatchFileView({ file }: { file: PatchFile }) {
  const [limit, setLimit] = useState(200);
  const [open, setOpen] = useState(true);
  const name = visiblePath(file.path);
  return <details className="patch-file" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <span className="patch-operation">{file.moveTo ? "Move / update" : file.operation === "add" ? "Add" : file.operation === "delete" ? "Delete" : "Update"}</span>
      <span className="patch-path">{name}{file.moveTo && <> → {visiblePath(file.moveTo)}</>}</span>
      {file.operation !== "delete" && <span className="patch-counts"><span className="patch-added">+{file.added}</span> <span className="patch-removed">−{file.removed}</span></span>}
    </summary>
    {open && <>
      {file.lines.length > 0 ? <div className="git-diff-lines patch-diff" role="region" aria-label={`Patch for ${name}`} tabIndex={0}>
        <div className="git-diff-lines-list">
          {file.lines.slice(0, limit).map((line) => <div key={line.index} className={`git-diff-line ${line.kind}`}>
            <DiffLineContent line={line} showNumbers={file.operation === "add"} />
          </div>)}
        </div>
      </div> : <p className="patch-notice">{file.operation === "delete" ? "Delete file; contents are not included in the patch."
        : file.moveTo ? "Move only; no content changes." : "Create an empty file."}</p>}
      {file.lines.length > limit && <button type="button" className="patch-load-more" onClick={() => setLimit((value) => value + 200)}>Show more lines ({file.lines.length - limit} remaining)</button>}
    </>}
  </details>;
}
