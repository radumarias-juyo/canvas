// A run's page step, the findings way: the run's report in the page's findings block, as an edit of its latest
// version, then the same check and publish every page goes through. A page that fails its check is not published: the
// run records "page not updated" and still sends its other deliveries.

import type { ArtifactMeta } from "../../../shared/protocol.ts";
import type { RunDelivery } from "../../../shared/runs.ts";
import { errorMessage, plural } from "../../../shared/util.ts";
import { checkDraft, publishDraft, readPageSource, writeDraft, type PublishScope } from "../../agent/publish.ts";
import { findingsEdit } from "./report.ts";

/** Put `report` in the findings block of `meta`'s latest version, check it, and publish it as a new version. */
export async function publishFindings(scope: PublishScope, meta: ArtifactMeta, report: string, message: string, at = new Date()): Promise<RunDelivery> {
  const to = meta.title;
  const notUpdated = (why: string): RunDelivery => ({ kind: "page", to, status: "failed", detail: `page not updated: ${why}` });
  try {
    const html = await readPageSource(scope, meta.id, meta.latest);
    if (html === null) return notUpdated("its latest version cannot be read");
    const edit = findingsEdit(html, report, at);
    if ("error" in edit) return notUpdated(edit.error);
    const draft = await writeDraft(scope, { artifact: meta, edits: [edit] });
    const checked = await checkDraft(scope, draft.id, { review: false });
    if (checked.draft.errors) return notUpdated(`its check found ${plural(checked.draft.errors, "error")}`);
    if (checked.draft.errors === null && !scope.publishUnchecked) return notUpdated(`no browser could check it (${checked.unchecked ?? "none to check it in"})`);
    const published = await publishDraft(scope, { draftId: draft.id, title: meta.title, artifactId: meta.id, message });
    return { kind: "page", to, status: "sent", detail: `${meta.title} v${published.meta.latest} published`, version: published.meta.latest };
  } catch (error) {
    return notUpdated(errorMessage(error));
  }
}
