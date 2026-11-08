// A newer version came in while the owner had changes not saved (another save of theirs, a restore, an approved edit
// request, pi writing): merge their changes onto it block by block, or drop them and take the newer one.

import { textOf, type Block, type Merged } from "./model.ts";

export function MergePrompt({
  rev,
  merged,
  mine,
  saving,
  onMerge,
  onDiscard,
}: {
  /** The newer version. */
  rev: number;
  merged: Merged;
  /** The owner's blocks as they are now: the text of a block both sides changed, to copy back. */
  mine: readonly Block[];
  /** Whether it came up on a save (else while reading the newer one in the background). */
  saving: boolean;
  onMerge: () => void;
  onDiscard: () => void;
}) {
  const conflicts = merged.conflicts.map((id) => mine.find((block) => block.attrs.id === id)).filter((block): block is Block => block !== undefined);
  return (
    <section className="doc-merge" role="alertdialog" aria-labelledby="doc-merge-title" aria-describedby="doc-merge-body">
      <h2 id="doc-merge-title">A newer version is here (version {rev})</h2>
      <p id="doc-merge-body">
        {saving ? "It was saved while you edited, so yours was not saved yet." : "It came in while you edited."} Merging keeps your changes wherever the newer
        version left that block as it was.
        {merged.conflicts.length > 0 &&
          ` ${merged.conflicts.length === 1 ? "One block was" : `${merged.conflicts.length} blocks were`} changed on both sides: the newer text is kept there, and yours is below to copy back.`}
      </p>
      {conflicts.length > 0 && (
        <ol className="doc-merge-conflicts">
          {conflicts.map((block) => (
            <li key={block.attrs.id}>
              <span className="doc-block-label">Your text</span>
              <q>{textOf(block) || "(empty)"}</q>
            </li>
          ))}
        </ol>
      )}
      <div className="doc-merge-actions">
        <button type="button" onClick={onDiscard}>
          Drop my changes
        </button>
        <button type="button" className="primary" onClick={onMerge} autoFocus>
          Merge my changes
        </button>
      </div>
    </section>
  );
}
