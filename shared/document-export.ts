/**
 * A document as a reader takes it away, from its block tree (shared/document.ts): as Markdown (`documentMarkdown`) and
 * as the static HTML its PDF prints (`documentHtml`). Word is worker/documents/docx.ts, the printing worker/documents/pdf.ts.
 * What the reader may see is the document object's to cut (DocumentObject.exportView), never these. Pure: no DOM, no
 * Worker APIs.
 */
import type { DocMark, DocNode } from "./document.ts";

/** The file formats a document exports to, with what each is served as. */
export const EXPORT_FORMATS = {
  md: { type: "text/markdown; charset=utf-8", extension: "md" },
  docx: { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: "docx" },
  pdf: { type: "application/pdf", extension: "pdf" },
} as const;
export type ExportFormat = keyof typeof EXPORT_FORMATS;

export function isExportFormat(value: string): value is ExportFormat {
  return Object.hasOwn(EXPORT_FORMATS, value);
}

/** A file name for the export: the title's letters, digits, spaces, dots and dashes, never empty, never a path. */
export function exportFileName(title: string, format: ExportFormat): string {
  const base =
    title
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
      .replace(/\s+/g, " ")
      .replace(/^[ .]+|[ .]+$/g, "")
      .slice(0, 100) || "Document";
  return `${base}.${EXPORT_FORMATS[format].extension}`;
}

/** A picture an export carries itself: a data: URL of a raster type (what exportView's `images` holds). */
export const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

// ---- Inline text -------------------------------------------------------------------------------------------------

export function isChip(node: DocNode): boolean {
  return node.type === "mention" || node.type === "date" || node.type === "dropdown";
}

/** A chip's words, as the editor shows them: a person's @name, a date, a dropdown's value (none: nothing). */
export function chipText(node: DocNode): string {
  if (node.type === "mention") return `@${String(node.attrs?.name ?? "")}`;
  if (node.type === "date") return String(node.attrs?.value ?? "");
  if (node.type === "dropdown") return node.attrs?.value == null ? "" : String(node.attrs.value);
  return "";
}

/** A node that is a run of text or stands in one: text, a chip, a line break. */
function inline(node: DocNode): boolean {
  return node.type === "text" || node.type === "hardBreak" || isChip(node);
}

/** A block's text, marks dropped and chips as their words: a code, CSV or formula block's source, a cell's words. */
export function plainText(node: DocNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (isChip(node)) return chipText(node);
  const children = node.content ?? [];
  return children.map(plainText).join(children.every(inline) ? "" : "\n");
}

/** A link's address, only for the schemes the schema allows (the object already holds no other; a file never links one). */
export function safeHref(mark: DocMark): string | undefined {
  const href = String(mark.attrs?.href ?? "").trim();
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : undefined;
}

function isList(node: DocNode): boolean {
  return node.type === "bulletList" || node.type === "orderedList" || node.type === "taskList";
}

function isHeaderCell(cell: DocNode): boolean {
  return cell.type === "tableHeader";
}

/** What an embed (a chart or a diagram, drawn live in the editor) is in a file: its title, else its kind. */
export function embedLabel(node: DocNode): string {
  const title = String(node.attrs?.title ?? "");
  return title ? `${node.attrs?.kind === "diagram" ? "Diagram" : "Chart"}: ${title}` : node.attrs?.kind === "diagram" ? "Diagram" : "Chart";
}

// ---- Markdown ----------------------------------------------------------------------------------------------------

/** Characters Markdown would read as syntax in running text. */
function escapeMarkdown(text: string): string {
  return text
    .replace(/([\\`*_~[\]<>#|$])/g, "\\$1")
    .replace(/^(\s*)(\d+)\./gm, "$1$2\\.")
    .replace(/^(\s*)([-+])(\s)/gm, "$1\\$2$3");
}

/** Inline content as Markdown; `inCell` for a table cell, where GFM ends the cell at any unescaped pipe, code or not. */
function inlineMarkdown(nodes: DocNode[] | undefined, inCell = false): string {
  let out = "";
  for (const node of nodes ?? []) {
    if (node.type === "hardBreak") out += inCell ? "<br>" : "\\\n";
    else if (isChip(node)) out += escapeMarkdown(chipText(node));
    else if (node.type === "text") {
      const marks = node.marks ?? [];
      const has = (type: string) => marks.some((mark) => mark.type === type);
      let text = has("code") ? codeSpan(node.text ?? "") : escapeMarkdown(node.text ?? "");
      if (inCell) text = text.replace(/(?<!\\)\|/g, "\\|");
      if (has("bold")) text = `**${text}**`;
      if (has("italic")) text = `*${text}*`;
      if (has("strike")) text = `~~${text}~~`;
      const link = marks.find((mark) => mark.type === "link");
      const href = link && safeHref(link);
      if (href) text = `[${text}](<${href.replace(/[<>\s]/g, encodeURIComponent)}>)`;
      out += text;
    }
  }
  return out;
}

/** Inline code that may hold backticks: a fence one longer than the longest run inside. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** A fenced block that may hold fences: one longer than the longest run of backticks inside. */
function fenced(text: string, info = ""): string {
  const longest = Math.max(2, ...(text.match(/`{3,}/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${info}\n${text}\n${fence}`;
}

/** A GFM table from rows of cells already in Markdown; the first row is its header, as GFM needs one. */
function gfmTable(rows: string[][]): string {
  if (!rows.length) return "";
  const width = Math.max(1, ...rows.map((row) => row.length));
  const line = (row: string[]) => `| ${[...row, ...Array<string>(width - row.length).fill("")].join(" | ")} |`;
  const [head, ...body] = rows;
  return [line(head!), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
}

/** A cell in one line: its paragraphs joined by <br>, its line breaks too. */
function cellMarkdown(cell: DocNode): string {
  return (cell.content ?? []).map((paragraph) => inlineMarkdown(paragraph.content, true)).join("<br>");
}

/** A list at `indent` (the spaces its markers start after): an item's text, and what nests in it, line up after its marker. */
function listMarkdown(list: DocNode, indent: string): string {
  let number = list.type === "orderedList" ? Number(list.attrs?.start ?? 1) : 0;
  return (list.content ?? [])
    .map((item) => {
      // A task's checkbox belongs to its text, so what nests under it lines up with the "[", as GFM reads it.
      const marker = list.type === "orderedList" ? `${number++}. ` : "- ";
      const box = list.type === "taskList" ? `[${item.attrs?.checked ? "x" : " "}] ` : "";
      const inner = `${indent}${" ".repeat(marker.length)}`;
      // The first paragraph goes on the marker's line; the rest of the item under it, indented to its text.
      const [first, ...rest] = item.content ?? [];
      const head = first ? inlineMarkdown(first.content).replace(/\n/g, `\n${inner}`) : "";
      const after = rest.map((child) => (isList(child) ? listMarkdown(child, inner) : `\n${inner}${inlineMarkdown(child.content).replace(/\n/g, `\n${inner}`)}`));
      return [`${indent}${marker}${box}${head}`, ...after].join("\n");
    })
    .join("\n");
}

function blockMarkdown(block: DocNode): string {
  switch (block.type) {
    case "heading":
      return `${"#".repeat(Math.min(3, Math.max(1, Number(block.attrs?.level) || 1)) + 1)} ${inlineMarkdown(block.content)}`;
    case "paragraph":
      return inlineMarkdown(block.content);
    case "bulletList":
    case "orderedList":
    case "taskList":
      return listMarkdown(block, "");
    case "table":
      return gfmTable((block.content ?? []).map((row) => (row.content ?? []).map(cellMarkdown)));
    case "codeBlock":
      return fenced(plainText(block), String(block.attrs?.language ?? ""));
    case "csv":
      return gfmTable(parseCsv(plainText(block)).map((row) => row.map((field) => escapeMarkdown(field).replace(/\n/g, "<br>"))));
    case "latex":
      return `$$\n${plainText(block)}\n$$`;
    case "image": {
      const src = String(block.attrs?.src ?? "");
      const alt = escapeMarkdown(String(block.attrs?.alt ?? ""));
      // Only a picture the export carries (exportView's data: URL); one it has no bytes for is its alt text.
      return DATA_IMAGE.test(src) ? `![${alt}](${src})` : `*[${alt || "Image"}]*`;
    }
    case "embed":
      return `*[${escapeMarkdown(embedLabel(block))}]*`;
    case "pending":
      // A section still being written: nothing yet.
      return "";
    default:
      return "";
  }
}

/**
 * The document as Markdown (CommonMark with GFM tables, task lists and strikethrough): its title as the one level-1
 * heading, its headings one level down under it.
 */
export function documentMarkdown(title: string, blocks: DocNode[]): string {
  const body = blocks
    .map(blockMarkdown)
    .filter((text) => text !== "")
    .join("\n\n");
  return `# ${escapeMarkdown(title)}\n\n${body}${body ? "\n" : ""}`;
}

/** CSV rows: quoted fields with doubled quotes, commas and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---- HTML (what the PDF prints) ----------------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function inlineHtml(nodes: DocNode[] | undefined): string {
  let out = "";
  for (const node of nodes ?? []) {
    if (node.type === "hardBreak") out += "<br>";
    else if (isChip(node)) out += `<span class="chip">${escapeHtml(chipText(node))}</span>`;
    else if (node.type === "text") {
      const marks = node.marks ?? [];
      const has = (type: string) => marks.some((mark) => mark.type === type);
      let text = escapeHtml(node.text ?? "");
      if (has("code")) text = `<code>${text}</code>`;
      if (has("bold")) text = `<strong>${text}</strong>`;
      if (has("italic")) text = `<em>${text}</em>`;
      if (has("strike")) text = `<s>${text}</s>`;
      const link = marks.find((mark) => mark.type === "link");
      const href = link && safeHref(link);
      if (href) text = `<a href="${escapeHtml(href)}">${text}</a>`;
      out += text;
    }
  }
  return out;
}

function blocksHtml(blocks: DocNode[] | undefined): string {
  return (blocks ?? []).map(blockHtml).join("\n");
}

function itemHtml(item: DocNode): string {
  return (item.content ?? []).map((child) => (isList(child) ? blockHtml(child) : `<p>${inlineHtml(child.content) || "<br>"}</p>`)).join("");
}

function blockHtml(block: DocNode): string {
  switch (block.type) {
    case "heading": {
      // The title is the page's h1; the document's headings go one level down.
      const level = Math.min(3, Math.max(1, Number(block.attrs?.level) || 1)) + 1;
      return `<h${level}>${inlineHtml(block.content)}</h${level}>`;
    }
    case "paragraph":
      return `<p>${inlineHtml(block.content) || "<br>"}</p>`;
    case "bulletList":
      return `<ul>${(block.content ?? []).map((item) => `<li>${itemHtml(item)}</li>`).join("")}</ul>`;
    case "orderedList": {
      const start = Number(block.attrs?.start ?? 1);
      return `<ol${start !== 1 ? ` start="${start}"` : ""}>${(block.content ?? []).map((item) => `<li>${itemHtml(item)}</li>`).join("")}</ol>`;
    }
    case "taskList":
      return `<ul class="tasks">${(block.content ?? [])
        .map((item) => `<li><span class="box">${item.attrs?.checked ? "&#9745;" : "&#9744;"}</span><div>${itemHtml(item)}</div></li>`)
        .join("")}</ul>`;
    case "table":
      return `<table>${(block.content ?? [])
        .map((row) => `<tr>${(row.content ?? []).map((cell) => (isHeaderCell(cell) ? `<th>${blocksHtml(cell.content)}</th>` : `<td>${blocksHtml(cell.content)}</td>`)).join("")}</tr>`)
        .join("")}</table>`;
    case "codeBlock":
      return `<pre><code>${escapeHtml(plainText(block))}</code></pre>`;
    case "csv": {
      const cells = (row: string[], tag: string) => row.map((field) => `<${tag}>${escapeHtml(field)}</${tag}>`).join("");
      return `<table class="csv">${parseCsv(plainText(block))
        .map((row, i) => `<tr>${cells(row, i === 0 ? "th" : "td")}</tr>`)
        .join("")}</table>`;
    }
    case "latex":
      return `<pre class="formula">${escapeHtml(plainText(block))}</pre>`;
    case "image": {
      const src = String(block.attrs?.src ?? "");
      const alt = escapeHtml(String(block.attrs?.alt ?? ""));
      const width = Number(block.attrs?.width) || 0;
      // Only pictures the export carries itself: the printing browser reaches nothing.
      return DATA_IMAGE.test(src)
        ? `<figure><img src="${src}" alt="${alt}"${width ? ` style="width:${Math.min(width, 4000)}px"` : ""}></figure>`
        : `<p class="note">[${alt || "Image"}]</p>`;
    }
    case "embed":
      return `<p class="note">[${escapeHtml(embedLabel(block))}]</p>`;
    default:
      // A pending section (being written) and anything else the schema may add: nothing.
      return "";
  }
}

/** The page's own styles: print-friendly, no web fonts, nothing fetched. */
const PRINT_CSS = `
@page { size: A4; margin: 20mm 18mm; }
body { font: 11pt/1.5 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; }
h1 { font-size: 22pt; margin: 0 0 12pt; } h2 { font-size: 16pt; margin: 18pt 0 6pt; }
h3 { font-size: 13pt; margin: 14pt 0 4pt; } h4 { font-size: 11.5pt; margin: 12pt 0 4pt; }
h2, h3, h4 { break-after: avoid; } p { margin: 0 0 8pt; }
a { color: #1d4ed8; } code { font: 9.5pt ui-monospace, Menlo, Consolas, monospace; background: #f3f4f6; padding: 0 2pt; }
pre { font: 9.5pt/1.4 ui-monospace, Menlo, Consolas, monospace; background: #f3f4f6; padding: 8pt; white-space: pre-wrap; break-inside: avoid; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 0 0 10pt; }
th, td { border: 0.75pt solid #c7c7c7; padding: 4pt 6pt; text-align: left; vertical-align: top; } th { background: #f3f4f6; }
th p, td p { margin: 0; } tr { break-inside: avoid; }
ul.tasks { list-style: none; padding-left: 0; } ul.tasks li { display: flex; gap: 6pt; } ul.tasks li > div > p { margin: 0; }
li > p { margin: 0 0 2pt; } .chip { background: #eef2ff; border-radius: 3pt; padding: 0 3pt; }
figure { margin: 0 0 10pt; } img { max-width: 100%; } .note { color: #6b7280; font-style: italic; }`;

/**
 * The document as one static HTML page, its read-only view for printing: no script, a policy that loads nothing
 * (pictures only as data: URLs carried in it), the title as its heading.
 */
export function documentHtml(title: string, blocks: DocNode[]): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head>
<body><h1>${escapeHtml(title)}</h1>
${blocksHtml(blocks)}
</body></html>`;
}
