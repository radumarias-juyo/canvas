// Markdown to and from a document's blocks (shared/document.ts): what pi and the agents write a section in (`as:
// "markdown"` in an op, document-ops.ts), and how one block reads back to them. GitHub's flavour: headings 1-3, lists
// and task lists, tables, code blocks (```csv and ```latex make those blocks), bold, italic, strike, code and links.
// Chips (a mention, a date, a dropdown) and pending placeholders come from a map beside the markdown, each written in
// it as the token `<?claude block <key>?>`. Nothing here is checked against the schema: checkBlocks does that.

import type { Nodes as MdNode, PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { blockText, isBlockType, type DocMark, type DocNode, type MarkType } from "./document.ts";

/** A chip or a pending placeholder, as an op's `chips` map gives it: written in the markdown as `<?claude block <key>?>`. */
export type ChipSpec =
  | { type: "mention"; uid: string; name: string }
  | { type: "date"; value: string }
  | { type: "dropdown"; options: string[]; value?: string | null }
  | { type: "pending"; intent: string };

/** A markdown that cannot become blocks: an unknown chip key, or one used where it cannot stand. */
export class MarkdownError extends Error {}

const TOKEN = /^<\?claude block ([A-Za-z0-9_-]{1,40})\?>$/;
const TOKEN_ANYWHERE = /<\?claude block ([A-Za-z0-9_-]{1,40})\?>/g;
const SAFE_LINK = /^(https?:\/\/|mailto:)[^\s]+$/i;

/** A text node with `marks`; none for empty text. */
function textNode(value: string, marks: readonly DocMark[]): DocNode[] {
  if (!value) return [];
  return [marks.length ? { type: "text", text: value, marks: [...marks] } : { type: "text", text: value }];
}

function withMark(marks: readonly DocMark[], mark: DocMark): DocMark[] {
  // Code takes no other mark with it (the schema's rule): inside code, other marks are dropped; code drops them too.
  if (marks.some((one) => one.type === "code")) return [...marks];
  if (mark.type === "code") return [mark];
  return marks.some((one) => one.type === mark.type) ? [...marks] : [...marks, mark];
}

/** A chip node from its spec; a pending spec is a block, never inline. */
function chipNode(key: string, chips: Readonly<Record<string, ChipSpec>>): DocNode {
  const spec = chips[key];
  if (!spec) throw new MarkdownError(`"<?claude block ${key}?>" names no chip: add "${key}" to chips.`);
  if (spec.type === "pending") throw new MarkdownError(`"${key}" is a pending block: put its token alone in a paragraph of its own.`);
  if (spec.type === "mention") return { type: "mention", attrs: { uid: spec.uid, name: spec.name } };
  if (spec.type === "date") return { type: "date", attrs: { value: spec.value } };
  return { type: "dropdown", attrs: { options: [...spec.options], value: spec.value ?? null } };
}

/** Text that may hold chip tokens (html nodes in mdast, or literal text in a code-free place), as inline nodes. */
function textWithChips(value: string, marks: readonly DocMark[], chips: Readonly<Record<string, ChipSpec>>): DocNode[] {
  const out: DocNode[] = [];
  let at = 0;
  for (const found of value.matchAll(TOKEN_ANYWHERE)) {
    out.push(...textNode(value.slice(at, found.index), marks), chipNode(found[1]!, chips));
    at = found.index! + found[0].length;
  }
  out.push(...textNode(value.slice(at), marks));
  return out;
}

function inline(nodes: readonly PhrasingContent[], marks: readonly DocMark[], chips: Readonly<Record<string, ChipSpec>>): DocNode[] {
  return nodes.flatMap((node): DocNode[] => {
    switch (node.type) {
      case "text":
        return textWithChips(node.value, marks, chips);
      case "strong":
        return inline(node.children, withMark(marks, { type: "bold" }), chips);
      case "emphasis":
        return inline(node.children, withMark(marks, { type: "italic" }), chips);
      case "delete":
        return inline(node.children, withMark(marks, { type: "strike" }), chips);
      case "inlineCode":
        return textNode(node.value, withMark(marks, { type: "code" }));
      case "link":
        // Only links a click opens: anything else keeps its words.
        return inline(node.children, SAFE_LINK.test(node.url) ? withMark(marks, { type: "link", attrs: { href: node.url } }) : marks, chips);
      case "html":
        return textWithChips(node.value, marks, chips);
      case "break":
        return textNode(" ", marks);
      case "image":
        return textNode(node.alt ?? "", marks);
      default:
        return "value" in node && typeof node.value === "string" ? textNode(node.value, marks) : [];
    }
  });
}

/** Inline nodes with neighbours of the same marks merged, as an editor keeps them. */
function merged(nodes: readonly DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  for (const node of nodes) {
    const last = out.at(-1);
    if (node.type === "text" && last?.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) {
      out[out.length - 1] = { ...last, text: `${last.text}${node.text}` };
    } else out.push(node);
  }
  return out;
}

function paragraph(content: DocNode[]): DocNode {
  const kept = merged(content);
  return kept.length ? { type: "paragraph", content: kept } : { type: "paragraph" };
}

function codeBlock(lang: string | null | undefined, value: string): DocNode {
  const language = lang?.trim().toLowerCase() ?? "";
  const content = value ? [{ type: "text", text: value }] : undefined;
  const type = language === "csv" ? "csv" : language === "latex" || language === "tex" || language === "math" ? "latex" : "codeBlock";
  const node: DocNode = type === "codeBlock" ? { type, attrs: { language: /^[A-Za-z0-9_+#.-]{1,30}$/.test(language) ? language : null } } : { type };
  if (content) node.content = content;
  return node;
}

/** One mdast block as document blocks (a blockquote's children, a thematic break as none). */
function blocks(node: RootContent | MdNode, chips: Readonly<Record<string, ChipSpec>>): DocNode[] {
  switch (node.type) {
    case "heading":
      return [{ type: "heading", attrs: { level: Math.min(3, node.depth) }, ...(node.children.length && { content: merged(inline(node.children, [], chips)) }) }];
    case "paragraph": {
      // A pending placeholder: its token alone in a paragraph.
      const only = node.children.length === 1 ? node.children[0]! : undefined;
      const token = only && (only.type === "html" || only.type === "text") ? TOKEN.exec(only.value.trim()) : null;
      const spec = token ? chips[token[1]!] : undefined;
      if (spec?.type === "pending") return [{ type: "pending", attrs: { intent: spec.intent } }];
      return [paragraph(inline(node.children, [], chips))];
    }
    case "list": {
      const task = node.children.some((item) => typeof item.checked === "boolean");
      const items = node.children.map((item): DocNode => {
        const inner = item.children.flatMap((child) => blocks(child, chips)).filter((child) => child.type === "paragraph" || /List$/.test(child.type));
        if (inner[0]?.type !== "paragraph") inner.unshift({ type: "paragraph" });
        return task ? { type: "taskItem", attrs: { checked: item.checked === true }, content: inner } : { type: "listItem", content: inner };
      });
      if (task) return [{ type: "taskList", content: items }];
      return node.ordered ? [{ type: "orderedList", attrs: { start: node.start ?? 1 }, content: items }] : [{ type: "bulletList", content: items }];
    }
    case "table": {
      const width = Math.max(1, ...node.children.map((row) => row.children.length));
      const rows = node.children.map((row, r): DocNode => {
        const cells = Array.from({ length: width }, (_, c): DocNode => {
          const cell = row.children[c];
          return { type: r === 0 ? "tableHeader" : "tableCell", content: [paragraph(cell ? inline(cell.children, [], chips) : [])] };
        });
        return { type: "tableRow", content: cells };
      });
      return [{ type: "table", content: rows }];
    }
    case "code":
      return [codeBlock(node.lang, node.value)];
    case "blockquote":
      return node.children.flatMap((child) => blocks(child, chips));
    case "html": {
      // A token alone on its line: a pending placeholder (or a chip, in a paragraph of its own).
      const token = TOKEN.exec(node.value.trim());
      const spec = token ? chips[token[1]!] : undefined;
      if (spec?.type === "pending") return [{ type: "pending", attrs: { intent: spec.intent } }];
      return [paragraph(textWithChips(node.value, [], chips))];
    }
    case "thematicBreak":
    case "definition":
    case "footnoteDefinition":
    case "yaml":
      return [];
    default:
      return [];
  }
}

/** Markdown as document blocks, without ids (checkBlocks gives them). Empty markdown is no blocks. */
export function markdownBlocks(markdown: string, chips: Readonly<Record<string, ChipSpec>> = {}): DocNode[] {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return tree.children.flatMap((child) => blocks(child, chips));
}

/** Markdown's inline words as inline nodes, for words replaced in place: what one paragraph of it holds. */
export function markdownInline(markdown: string, chips: Readonly<Record<string, ChipSpec>> = {}): DocNode[] | undefined {
  const parsed = markdownBlocks(markdown, chips);
  if (parsed.length === 0) return [];
  return parsed.length === 1 && parsed[0]!.type === "paragraph" ? (parsed[0]!.content ?? []) : undefined;
}

// ---- Back to markdown: how one block reads to a model ----

const MARK_WRAP: Record<Exclude<MarkType, "link">, string> = { bold: "**", italic: "*", strike: "~~", code: "`" };

function inlineMarkdown(nodes: readonly DocNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === "mention") return `@${String(node.attrs?.name ?? "")}`;
      if (node.type === "date") return String(node.attrs?.value ?? "");
      if (node.type === "dropdown") return node.attrs?.value == null ? "[ ]" : `[${String(node.attrs.value)}]`;
      let text = node.text ?? "";
      for (const mark of node.marks ?? []) text = mark.type === "link" ? `[${text}](${mark.attrs?.href ?? ""})` : `${MARK_WRAP[mark.type]}${text}${MARK_WRAP[mark.type]}`;
      return text;
    })
    .join("");
}

function listMarkdown(node: DocNode, indent: string): string[] {
  return (node.content ?? []).flatMap((item, i) => {
    const bullet = node.type === "orderedList" ? `${Number(node.attrs?.start ?? 1) + i}.` : node.type === "taskList" ? `- [${item.attrs?.checked ? "x" : " "}]` : "-";
    const [first, ...rest] = item.content ?? [];
    const lines = [`${indent}${bullet} ${first ? inlineMarkdown(first.content ?? []) : ""}`];
    for (const child of rest) {
      if (child.type === "paragraph") lines.push(`${indent}    ${inlineMarkdown(child.content ?? [])}`);
      else lines.push(...listMarkdown(child, `${indent}    `));
    }
    return lines;
  });
}

/** One block as markdown: what document_read shows of it in full. Chips read as their words. */
export function blockMarkdown(node: DocNode): string {
  switch (node.type) {
    case "heading":
      return `${"#".repeat(Number(node.attrs?.level ?? 1))} ${inlineMarkdown(node.content ?? [])}`;
    case "paragraph":
      return inlineMarkdown(node.content ?? []);
    case "bulletList":
    case "orderedList":
    case "taskList":
      return listMarkdown(node, "").join("\n");
    case "listItem":
    case "taskItem":
      return listMarkdown({ type: node.type === "taskItem" ? "taskList" : "bulletList", content: [node] }, "").join("\n");
    case "table": {
      const rows = (node.content ?? []).map((row) => `| ${(row.content ?? []).map((cell) => blockText(cell).replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`);
      if (!rows.length) return "";
      const width = node.content?.[0]?.content?.length ?? 1;
      return [rows[0], `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1)].join("\n");
    }
    case "codeBlock":
      return `\`\`\`${node.attrs?.language ?? ""}\n${blockText(node)}\n\`\`\``;
    case "csv":
    case "latex":
      return `\`\`\`${node.type}\n${blockText(node)}\n\`\`\``;
    case "pending":
      return `(pending: ${String(node.attrs?.intent ?? "")})`;
    case "image":
      return `(image: ${String(node.attrs?.alt ?? "")})`;
    case "embed":
      return `(${String(node.attrs?.kind ?? "embed")}: ${String(node.attrs?.title ?? "")})`;
    default:
      return isBlockType(node.type) ? blockText(node) : "";
  }
}
