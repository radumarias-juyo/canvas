import { documentHtml, documentMarkdown, EXPORT_FORMATS, exportFileName, isExportFormat } from "../../shared/document-export.ts";
import type { DocNode } from "../../shared/document.ts";
import { ID_PATTERN } from "../../shared/protocol.ts";
import { errorMessage } from "../../shared/util.ts";
import { json } from "../http.ts";
import { documentDocx } from "./docx.ts";

/**
 * A document as one reader may take it away (DocumentObject.exportView): already cut to what they may see, and its
 * pictures' bytes as data: URLs by the `src` the blocks name them with.
 */
export interface ExportView {
  title: string;
  blocks: DocNode[];
  images: Record<string, string>;
}

/** What the export route reaches, as the Worker gives it (tests give fakes). */
export interface ExportReach {
  /** The signed-in reader's view of the document, from its object: it checks they may read it and cuts what they may not see. */
  view(docId: string): Promise<ExportView | { status: number; error: string }>;
  /** Print the read-only view's HTML to a PDF in the headless browser. */
  print(html: string): Promise<Uint8Array<ArrayBuffer>>;
}

const ROUTE = /^\/api\/documents\/([^/]+)\/export$/;

/** How a download is served: never sniffed, never run, never cached. */
const DOWNLOAD_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "private, no-store",
};

/** The blocks with each picture's `src` swapped for the data: URL the view carries for it (a picture it has none for keeps its name, and exports as its alt text). */
export function withImages(blocks: DocNode[], images: Record<string, string>): DocNode[] {
  const swap = (node: DocNode): DocNode => {
    const src = node.type === "image" ? node.attrs?.src : undefined;
    const data = typeof src === "string" && Object.hasOwn(images, src) ? images[src] : undefined;
    return {
      ...node,
      ...(data && { attrs: { ...node.attrs, src: data } }),
      ...(node.content && { content: node.content.map(swap) }),
    };
  };
  return blocks.map(swap);
}

/**
 * GET /api/documents/:id/export?format=md|docx|pdf: the document as a file, of what the signed-in reader may see (the
 * object decides that). Null for any other path.
 */
export async function documentExportRoute(request: Request, reach: ExportReach): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(ROUTE);
  if (!match) return null;
  const docId = match[1];
  const format = url.searchParams.get("format") ?? "";
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (!ID_PATTERN.test(docId)) return json({ error: "Not found" }, 404);
  if (!isExportFormat(format)) return json({ error: `Expected format=${Object.keys(EXPORT_FORMATS).join(", ")}.` }, 400);

  const view = await reach.view(docId);
  if ("error" in view) return json({ error: view.error }, view.status);
  const blocks = withImages(view.blocks, view.images);
  let body: Uint8Array<ArrayBuffer> | string;
  try {
    body =
      format === "md"
        ? documentMarkdown(view.title, blocks)
        : format === "docx"
          ? await documentDocx(view.title, blocks)
          : await reach.print(documentHtml(view.title, blocks));
  } catch (error) {
    return json({ error: `The ${format === "pdf" ? "PDF" : "file"} could not be made: ${errorMessage(error)}` }, 503);
  }
  const name = exportFileName(view.title, format);
  return new Response(body, {
    headers: {
      ...DOWNLOAD_HEADERS,
      "content-type": EXPORT_FORMATS[format].type,
      // The plain name for old clients (ASCII only), the real one as UTF-8.
      "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
}
