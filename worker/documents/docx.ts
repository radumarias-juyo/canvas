import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IRunOptions,
  type ParagraphChild,
} from "docx";
import { DATA_IMAGE, HELD_SECTION, chipText, isChip, parseCsv, plainText, safeHref } from "../../shared/document-export.ts";
import type { DocNode } from "../../shared/document.ts";

/** The numbering every ordered list of the document uses (one instance per list), decimal at every level. */
const ORDERED = "ordered";
const MONO = "Consolas";
const CODE_SHADING = { type: ShadingType.CLEAR, color: "auto", fill: "F3F4F6" } as const;
/** The widest a picture is laid out, in pixels (docx's unit for an image's size): the text width of an A4 page. */
const MAX_IMAGE_WIDTH = 600;

/** What one run of text carries from its marks. */
type RunStyle = Pick<IRunOptions, "bold" | "italics" | "strike" | "font" | "shading">;

function runs(nodes: DocNode[] | undefined, base: RunStyle = {}): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const node of nodes ?? []) {
    if (node.type === "hardBreak") out.push(new TextRun({ ...base, text: "", break: 1 }));
    else if (isChip(node)) out.push(new TextRun({ ...base, text: chipText(node) }));
    else if (node.type === "text") {
      const marks = node.marks ?? [];
      const has = (type: string) => marks.some((mark) => mark.type === type);
      const style: RunStyle = {
        ...base,
        ...(has("bold") && { bold: true }),
        ...(has("italic") && { italics: true }),
        ...(has("strike") && { strike: true }),
        ...(has("code") && { font: MONO, shading: CODE_SHADING }),
      };
      const link = marks.find((mark) => mark.type === "link");
      const href = link && safeHref(link);
      out.push(href ? new ExternalHyperlink({ link: href, children: [new TextRun({ ...style, text: node.text ?? "", style: "Hyperlink" })] }) : new TextRun({ ...style, text: node.text ?? "" }));
    }
  }
  return out;
}

/** The width and height of a PNG, JPEG or GIF from its header, or undefined for anything else. */
export function imageSize(bytes: Uint8Array): { width: number; height: number; type: "png" | "jpg" | "gif" } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 24 && view.getUint32(0) === 0x89504e47) return { width: view.getUint32(16), height: view.getUint32(20), type: "png" };
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return { width: view.getUint16(6, true), height: view.getUint16(8, true), type: "gif" };
  if (bytes.length > 4 && view.getUint16(0) === 0xffd8) {
    // The first start-of-frame marker holds the size.
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return undefined;
      const marker = bytes[at + 1];
      const length = view.getUint16(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(at + 5), width: view.getUint16(at + 7), type: "jpg" };
      }
      at += 2 + length;
    }
  }
  return undefined;
}

function imageParagraph(block: DocNode): Paragraph {
  const src = String(block.attrs?.src ?? "");
  const alt = String(block.attrs?.alt ?? "");
  const note = () => new Paragraph({ children: [new TextRun({ text: `[${alt || "image"}]`, italics: true, color: "6B7280" })] });
  if (!DATA_IMAGE.test(src)) return note();
  const bytes = Uint8Array.from(atob(src.slice(src.indexOf(",") + 1)), (char) => char.charCodeAt(0));
  const size = imageSize(bytes);
  if (!size || !size.width || !size.height) return note();
  const scale = Math.min(1, MAX_IMAGE_WIDTH / size.width);
  return new Paragraph({
    children: [
      new ImageRun({
        type: size.type,
        data: bytes,
        transformation: { width: Math.round(size.width * scale), height: Math.round(size.height * scale) },
        ...(alt && { altText: { name: alt, description: alt, title: alt } }),
      }),
    ],
  });
}

function codeParagraphs(text: string): Paragraph[] {
  const lines = text.split("\n");
  // One shaded box: no room between its lines, the usual room after the last.
  return lines.map(
    (line, i) => new Paragraph({ shading: CODE_SHADING, spacing: { after: i === lines.length - 1 ? 120 : 0, line: 240 }, children: [new TextRun({ text: line, font: MONO, size: 19 })] }),
  );
}

function table(rows: { header: boolean; blocks: (Paragraph | Table)[] }[][]): Table {
  const width = Math.max(1, ...rows.map((row) => row.length));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (row) =>
        new TableRow({
          children: [...row, ...Array.from({ length: width - row.length }, () => ({ header: false, blocks: [] }))].map(
            (cell) =>
              new TableCell({
                children: cell.blocks.length ? cell.blocks : [new Paragraph({})],
                ...(cell.header && { shading: { type: ShadingType.CLEAR, color: "auto", fill: "F3F4F6" } }),
              }),
          ),
        }),
    ),
  });
}

/** Walks the block tree into Word's paragraphs and tables, numbering each ordered list as its own. */
class Writer {
  #lists = 0;

  blocks(blocks: DocNode[] | undefined, depth = 0, base: RunStyle = {}): (Paragraph | Table)[] {
    return (blocks ?? []).flatMap((block) => this.block(block, depth, base));
  }

  block(block: DocNode, depth: number, base: RunStyle): (Paragraph | Table)[] {
    switch (block.type) {
      case "heading": {
        const level = Math.min(3, Math.max(1, Number(block.attrs?.level) || 1));
        const heading = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][level - 1];
        return [new Paragraph({ heading, children: runs(block.content, base) })];
      }
      case "paragraph":
        return [new Paragraph({ children: runs(block.content, base) })];
      case "bulletList":
      case "orderedList":
      case "taskList":
        return this.list(block, depth);
      case "table":
        return [
          table(
            (block.content ?? []).map((row) =>
              (row.content ?? []).map((cell) => {
                const header = cell.type === "tableHeader" || cell.attrs?.header === true;
                return { header, blocks: this.blocks(cell.content, 0, header ? { bold: true } : {}) };
              }),
            ),
          ),
        ];
      case "codeBlock":
        return codeParagraphs(plainText(block));
      case "csv":
        return [
          table(
            parseCsv(String(block.attrs?.text ?? plainText(block))).map((row, i) =>
              row.map((field) => ({ header: i === 0, blocks: [new Paragraph({ children: [new TextRun({ text: field, bold: i === 0 })] })] })),
            ),
          ),
        ];
      case "latex":
        return codeParagraphs(String(block.attrs?.text ?? plainText(block)));
      case "image":
        return [imageParagraph(block)];
      case "embed":
        return [new Paragraph({ children: [new TextRun({ text: `[${String(block.attrs?.title ?? block.attrs?.kind ?? "chart")}]`, italics: true, color: "6B7280" })] })];
      case "pending":
        return [];
      case "held":
        return [new Paragraph({ children: [new TextRun({ text: HELD_SECTION, italics: true, color: "6B7280" })] })];
      case "horizontalRule":
        return [new Paragraph({ thematicBreak: true, children: [] })];
      case "blockquote":
        return this.blocks(block.content, depth, { ...base, italics: true });
      default:
        return this.blocks(block.content, depth, base);
    }
  }

  /** A list's items: their first paragraph carries the bullet, number or checkbox; nested lists go one level in. */
  list(list: DocNode, depth: number): (Paragraph | Table)[] {
    const level = Math.min(depth, 8);
    const instance = list.type === "orderedList" ? ++this.#lists : 0;
    return (list.content ?? []).flatMap((item) => {
      const [first, ...rest] = item.content ?? [];
      const marked = first && first.type === "paragraph" ? first : undefined;
      const box = list.type === "taskList" ? [new TextRun({ text: item.attrs?.checked ? "☑ " : "☐ " })] : [];
      const lead = new Paragraph({
        // A task carries its checkbox instead of a bullet, indented as a list item would be.
        ...(list.type === "orderedList"
          ? { numbering: { reference: ORDERED, level, instance } }
          : list.type === "taskList"
            ? { indent: { left: 360 * (level + 1) } }
            : { bullet: { level } }),
        children: [...box, ...runs(marked?.content)],
      });
      const after = (marked ? rest : item.content ?? []).flatMap((child) =>
        child.type === "bulletList" || child.type === "orderedList" || child.type === "taskList" ? this.list(child, depth + 1) : this.block(child, depth + 1, {}),
      );
      return [lead, ...after];
    });
  }
}

/** The document as a Word file (.docx): its title, headings, lists with tasks, tables, code, pictures, links, chips as text. */
export async function documentDocx(title: string, blocks: DocNode[]): Promise<Uint8Array> {
  const body = new Writer().blocks(blocks);
  const document = new Document({
    title,
    creator: "",
    // Some room after each paragraph and before each heading, as the editor shows them; a sans-serif face.
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 22 }, paragraph: { spacing: { after: 120, line: 276 } } },
        heading1: { paragraph: { spacing: { before: 360, after: 120 } } },
        heading2: { paragraph: { spacing: { before: 280, after: 100 } } },
        heading3: { paragraph: { spacing: { before: 240, after: 80 } } },
      },
    },
    numbering: {
      config: [
        {
          reference: ORDERED,
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3],
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children: [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }), ...body] }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(document));
}
