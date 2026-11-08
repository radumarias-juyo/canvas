/**
 * A document as a reader may take it away: the parts they may see (`readerView`), as Markdown (`documentMarkdown`) and
 * as the static HTML its PDF prints (`documentHtml`). Word is in worker/documents/docx.ts, the PDF's printing in
 * worker/documents/pdf.ts. Pure: no DOM, no Worker APIs.
 */
import type { DocNode, DocMark } from "./document.ts";

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

/** What a private section shows to a reader it is held from, in the editor and in an export. */
export const HELD_SECTION = "A section only the document's owner sees.";

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

// ---- Inline text -------------------------------------------------------------------------------------------------

/** A chip's words as plain text: a person's name, a date, a dropdown's choice. */
export function chipText(node: DocNode): string {
  const attrs = node.attrs ?? {};
  if (node.type === "mention") return `@${String(attrs.label ?? attrs.name ?? attrs.id ?? "")}`;
  if (node.type === "date") return String(attrs.value ?? attrs.date ?? "");
  if (node.type === "dropdown") return String(attrs.value ?? attrs.label ?? "");
  return "";
}

/** True for a node that is a run of text or stands inside one (a chip, a line break). */
function inline(node: DocNode): boolean {
  return node.type === "text" || node.type === "hardBreak" || isChip(node);
}

export function isChip(node: DocNode): boolean {
  return node.type === "mention" || node.type === "date" || node.type === "dropdown";
}

/** A block's text, marks and chips flattened: for alt text, table cells in plain formats, and tests. */
export function plainText(node: DocNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (isChip(node)) return chipText(node);
  return (node.content ?? []).map(plainText).join(inline(node) ? "" : node.content?.every(inline) ? "" : "\n");
}

/** A link's address, kept only for the schemes a reader can safely follow from a file. */
export function safeHref(mark: DocMark): string | undefined {
  const href = String(mark.attrs?.href ?? "").trim();
  return /^(https?:|mailto:)/i.test(href) ? href : undefined;
}

// ---- Markdown ----------------------------------------------------------------------------------------------------

/** Characters Markdown would read as syntax in running text. */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_~[\]<>#|])/g, "\\$1").replace(/^(\s*)(\d+)\./gm, "$1$2\\.").replace(/^(\s*)([-+])(\s)/gm, "$1\\$2$3");
}

function inlineMarkdown(nodes: DocNode[] | undefined): string {
  let out = "";
  for (const node of nodes ?? []) {
    if (node.type === "hardBreak") {
      out += "  \n";
      continue;
    }
    if (isChip(node)) {
      out += escapeMarkdown(chipText(node));
      continue;
    }
    if (node.type !== "text") continue;
    const marks = node.marks ?? [];
    const code = marks.some((mark) => mark.type === "code");
    let text = code ? codeSpan(node.text ?? "") : escapeMarkdown(node.text ?? "");
    if (!code) {
      if (marks.some((mark) => mark.type === "bold")) text = `**${text}**`;
      if (marks.some((mark) => mark.type === "italic")) text = `*${text}*`;
      if (marks.some((mark) => mark.type === "strike")) text = `~~${text}~~`;
    }
    const link = marks.find((mark) => mark.type === "link");
    const href = link && safeHref(link);
    if (href) text = `[${text}](<${href.replace(/[<>]/g, encodeURIComponent)}>)`;
    out += text;
  }
  return out;
}

/** Inline code that holds backticks: a fence one longer than the longest run inside. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function fenced(text: string, info = ""): string {
  const longest = Math.max(2, ...(text.match(/`{3,}/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${info.replace(/[^\w+#.-]/g, "")}\n${text}\n${fence}`;
}

function tableMarkdown(table: DocNode): string {
  const rows = (table.content ?? []).map((row) => (row.content ?? []).map((cell) => cellMarkdown(cell)));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length), 1);
  const pad = (row: string[]) => [...row, ...Array<string>(width - row.length).fill("")];
  const line = (row: string[]) => `| ${pad(row).join(" | ")} |`;
  const [head, ...body] = rows;
  return [line(head), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
}

/** A cell in one line: its paragraphs joined by <br>, its pipes escaped. */
function cellMarkdown(cell: DocNode): string {
  return (cell.content ?? [])
    .map((block) => (block.content?.every(inline) ? inlineMarkdown(block.content) : escapeMarkdown(plainText(block))))
    .join("<br>")
    .replace(/\n/g, " ");
}

function csvMarkdown(node: DocNode): string {
  const rows = parseCsv(String(node.attrs?.text ?? plainText(node)));
  if (!rows.length) return "";
  return tableMarkdown({
    type: "table",
    content: rows.map((row) => ({ type: "tableRow", content: row.map((text) => ({ type: "tableCell", content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }] })) })),
  });
}

/** CSV rows: quoted fields with doubled quotes, commas and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === ",") row.push(field), (field = "");
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += char;
  }
  if (field !== "" || row.length) row.push(field), rows.push(row);
  return rows;
}

function listMarkdown(list: DocNode, depth: number): string {
  const ordered = list.type === "orderedList";
  let number = Number(list.attrs?.start ?? 1) || 1;
  const indent = "  ".repeat(depth);
  return (list.content ?? [])
    .map((item) => {
      const marker = list.type === "taskList" ? `- [${item.attrs?.checked ? "x" : " "}] ` : ordered ? `${number++}. ` : "- ";
      const [first, ...rest] = item.content ?? [];
      const head = first && !isList(first) ? blocksMarkdown([first], depth + 1).replace(/\n/g, `\n${indent}${" ".repeat(marker.length)}`) : "";
      const nested = [...(first && isList(first) ? [first] : []), ...rest].map((child) =>
        isList(child) ? listMarkdown(child, depth + 1) : `${indent}${" ".repeat(marker.length)}${blocksMarkdown([child], depth + 1)}`,
      );
      return [`${indent}${marker}${head}`, ...nested].join("\n");
    })
    .join("\n");
}

function isList(node: DocNode): boolean {
  return node.type === "bulletList" || node.type === "orderedList" || node.type === "taskList";
}

function blocksMarkdown(blocks: DocNode[], depth = 0): string {
  return blocks
    .map((block) => blockMarkdown(block, depth))
    .filter((text) => text !== "")
    .join("\n\n");
}

function blockMarkdown(block: DocNode, depth: number): string {
  switch (block.type) {
    case "heading":
      return `${"#".repeat(Math.min(3, Math.max(1, Number(block.attrs?.level) || 1)))} ${inlineMarkdown(block.content)}`;
    case "paragraph":
      return inlineMarkdown(block.content);
    case "bulletList":
    case "orderedList":
    case "taskList":
      return listMarkdown(block, depth);
    case "table":
      return tableMarkdown(block);
    case "codeBlock":
      return fenced(plainText(block), String(block.attrs?.language ?? ""));
    case "csv":
      return csvMarkdown(block);
    case "latex":
      return `$$\n${String(block.attrs?.text ?? plainText(block))}\n$$`;
    case "image": {
      const alt = escapeMarkdown(String(block.attrs?.alt ?? ""));
      const src = String(block.attrs?.src ?? "");
      // Only a picture the export carries (a data: URL) or one on the web; a file of the owner's is never linked by path.
      return /^(https:|data:image\/)/i.test(src) ? `![${alt}](<${src}>)` : alt ? `*[image: ${alt}]*` : "*[image]*";
    }
    case "embed":
      return `*[${escapeMarkdown(String(block.attrs?.title ?? block.attrs?.kind ?? "chart"))}]*`;
    case "pending":
      return "";
    case "held":
      return `*${HELD_SECTION}*`;
    case "horizontalRule":
      return "---";
    case "blockquote":
      return blocksMarkdown(block.content ?? [], depth)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    default:
      return block.content ? blocksMarkdown(block.content, depth) : "";
  }
}

/** The document as Markdown (CommonMark with GFM tables, task lists and strikethrough), from its block tree. */
export function documentMarkdown(title: string, blocks: DocNode[]): string {
  const body = blocksMarkdown(blocks);
  return `# ${escapeMarkdown(title)}\n\n${body}${body ? "\n" : ""}`;
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
      let text = escapeHtml(node.text ?? "");
      if (marks.some((mark) => mark.type === "code")) text = `<code>${text}</code>`;
      if (marks.some((mark) => mark.type === "bold")) text = `<strong>${text}</strong>`;
      if (marks.some((mark) => mark.type === "italic")) text = `<em>${text}</em>`;
      if (marks.some((mark) => mark.type === "strike")) text = `<s>${text}</s>`;
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

function itemsHtml(list: DocNode): string {
  return (list.content ?? []).map((item) => `<li>${blocksHtml(item.content)}</li>`).join("");
}

function blockHtml(block: DocNode): string {
  switch (block.type) {
    case "heading": {
      const level = Math.min(3, Math.max(1, Number(block.attrs?.level) || 1)) + 1;
      return `<h${level}>${inlineHtml(block.content)}</h${level}>`;
    }
    case "paragraph":
      return `<p>${inlineHtml(block.content) || "<br>"}</p>`;
    case "bulletList":
      return `<ul>${itemsHtml(block)}</ul>`;
    case "orderedList": {
      const start = Number(block.attrs?.start ?? 1) || 1;
      return `<ol${start !== 1 ? ` start="${start}"` : ""}>${itemsHtml(block)}</ol>`;
    }
    case "taskList":
      return `<ul class="tasks">${(block.content ?? [])
        .map((item) => `<li><span class="box">${item.attrs?.checked ? "&#9745;" : "&#9744;"}</span><div>${blocksHtml(item.content)}</div></li>`)
        .join("")}</ul>`;
    case "table":
      return `<table>${(block.content ?? [])
        .map((row) => `<tr>${(row.content ?? []).map((cell) => (header(cell) ? `<th>${blocksHtml(cell.content)}</th>` : `<td>${blocksHtml(cell.content)}</td>`)).join("")}</tr>`)
        .join("")}</table>`;
    case "codeBlock":
      return `<pre><code>${escapeHtml(plainText(block))}</code></pre>`;
    case "csv": {
      const rows = parseCsv(String(block.attrs?.text ?? plainText(block)));
      const cells = (row: string[], tag: string) => row.map((field) => `<${tag}>${escapeHtml(field)}</${tag}>`).join("");
      return `<table class="csv">${rows.map((row, i) => `<tr>${cells(row, i === 0 ? "th" : "td")}</tr>`).join("")}</table>`;
    }
    case "latex":
      return `<pre class="formula">${escapeHtml(String(block.attrs?.text ?? plainText(block)))}</pre>`;
    case "image": {
      const src = String(block.attrs?.src ?? "");
      const alt = escapeHtml(String(block.attrs?.alt ?? ""));
      // Only pictures the export carries itself: the printing browser reaches nothing.
      return DATA_IMAGE.test(src) ? `<figure><img src="${src}" alt="${alt}"></figure>` : `<p class="note">[${alt || "image"}]</p>`;
    }
    case "embed":
      return `<p class="note">[${escapeHtml(String(block.attrs?.title ?? block.attrs?.kind ?? "chart"))}]</p>`;
    case "pending":
      return "";
    case "held":
      return `<p class="note">${escapeHtml(HELD_SECTION)}</p>`;
    case "horizontalRule":
      return "<hr>";
    case "blockquote":
      return `<blockquote>${blocksHtml(block.content)}</blockquote>`;
    default:
      return blocksHtml(block.content);
  }
}

/** A picture an export carries itself, as a data: URL of a raster type. */
export const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

function header(cell: DocNode): boolean {
  return cell.type === "tableHeader" || cell.attrs?.header === true;
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
figure { margin: 0 0 10pt; } img { max-width: 100%; } .note { color: #6b7280; font-style: italic; }
blockquote { border-left: 3pt solid #d1d5db; margin: 0 0 8pt; padding-left: 10pt; color: #374151; }`;

/**
 * The document as one static HTML page for printing: no script, a policy that loads nothing (pictures only as data:
 * URLs carried in it), the title as its heading.
 */
export function documentHtml(title: string, blocks: DocNode[]): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head>
<body><h1>${escapeHtml(title)}</h1>
${blocksHtml(blocks)}
</body></html>`;
}
