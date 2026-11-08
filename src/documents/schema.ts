// The editor's schema, built from shared/document.ts's DOCUMENT_SCHEMA: one Tiptap extension per node and mark it
// names, each given exactly its content expression, group, flags and attributes, so nothing checkDocument refuses can
// be typed or pasted in (an extension's own extra attributes are dropped; a node or mark the schema lacks has no
// extension). Node definitions only: views.tsx attaches the React views, so the tests build this without a browser.

import { Extension, getSchema, Mark, mergeAttributes, Node, type AnyExtension, type Attribute, type Extensions } from "@tiptap/core";
import Bold from "@tiptap/extension-bold";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Heading from "@tiptap/extension-heading";
import Image from "@tiptap/extension-image";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import { BulletList, ListItem, OrderedList, TaskItem, TaskList } from "@tiptap/extension-list";
import Paragraph from "@tiptap/extension-paragraph";
import Strike from "@tiptap/extension-strike";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import Text from "@tiptap/extension-text";
import { Mapping } from "@tiptap/pm/transform";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { DOCUMENT_SCHEMA, IMAGE_SRC_PATTERN, newBlockId } from "../../shared/document.ts";

/** Links only to the web and mail, as checkDocument takes them: never `javascript:`, a data URL or a relative one. */
export function safeHref(href: unknown): string | null {
  return typeof href === "string" && /^(https?:\/\/|mailto:)[^\s]+$/i.test(href) ? href : null;
}

/** Where the app serves an image stored with document `documentId` (src "image:<id>"); null for any other src. */
export function imageUrl(documentId: string, src: unknown): string | null {
  if (typeof src !== "string" || !IMAGE_SRC_PATTERN.test(src)) return null;
  return `/api/documents/${encodeURIComponent(documentId)}/images/${encodeURIComponent(src.slice("image:".length))}`;
}

/** A block's id and hash: kept through edits, never copied onto the half a split makes; the id shown, the hash not. */
const ID_ATTRS: Record<string, Partial<Attribute>> = {
  id: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: (attrs) => (attrs.id ? { "data-block": attrs.id } : {}) },
  h: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
};

/** A node extension made to fit its DOCUMENT_SCHEMA entry: content, group, flags and exactly its attributes. */
function fitNode(extension: Node): Node {
  const spec = DOCUMENT_SCHEMA.nodes[extension.name];
  if (!spec) throw new Error(`DOCUMENT_SCHEMA has no node "${extension.name}"`);
  const config: Record<string, unknown> = {
    group: spec.group,
    inline: spec.inline ?? false,
    atom: spec.atom ?? false,
    code: spec.code ?? false,
    defining: spec.defining ?? false,
    isolating: spec.isolating ?? false,
    addAttributes(this: { parent?: () => Record<string, Partial<Attribute>> }) {
      const parent = this.parent?.() ?? {};
      return Object.fromEntries(
        Object.entries(spec.attrs ?? {}).map(([key, attr]) => [key, ID_ATTRS[key] ?? { ...(parent[key] ?? {}), default: "default" in attr ? attr.default : null }]),
      );
    },
  };
  if (spec.content !== undefined) config.content = spec.content;
  if (spec.marks !== undefined) config.marks = spec.marks;
  return extension.extend(config);
}

/** A mark extension made to fit its DOCUMENT_SCHEMA entry: exactly its attributes (a link: only its href). */
function fitMark(extension: Mark): Mark {
  const spec = DOCUMENT_SCHEMA.marks[extension.name as keyof typeof DOCUMENT_SCHEMA.marks];
  if (!spec) throw new Error(`DOCUMENT_SCHEMA has no mark "${extension.name}"`);
  return extension.extend({
    addAttributes(this: { parent?: () => Record<string, Partial<Attribute>> }) {
      const parent = this.parent?.() ?? {};
      return Object.fromEntries(Object.keys(spec.attrs ?? {}).map((key) => [key, { ...(parent[key] ?? {}), default: null }]));
    },
  });
}

/** pi's placeholder for a section it is still writing: what will go there (an atom: no text inside). */
const Pending = Node.create({
  name: "pending",
  selectable: true,
  draggable: false,
  parseHTML: () => [{ tag: "div[data-pending]", getAttrs: (el) => ({ intent: el.getAttribute("data-intent") ?? "" }) }],
  renderHTML: ({ HTMLAttributes, node }) => ["div", mergeAttributes(HTMLAttributes, { "data-pending": "", "data-intent": node.attrs.intent }), `Writing: ${node.attrs.intent}`],
});

/** Plain text in a monospace block, shown as a grid (CSV) or as a display formula (LaTeX). */
const textBlock = (name: "csv" | "latex") =>
  Node.create({
    name,
    parseHTML: () => [{ tag: `pre[data-${name}]`, preserveWhitespace: "full" as const }],
    renderHTML: ({ HTMLAttributes }) => ["pre", mergeAttributes(HTMLAttributes, { [`data-${name}`]: "" }), ["code", 0]],
  });

/** A chart or diagram drawn by the dashboard renderer (phase 2): kept as it is, shown as a frame until then. */
const Embed = Node.create({
  name: "embed",
  selectable: true,
  parseHTML: () => [{ tag: "div[data-embed]" }],
  renderHTML: ({ HTMLAttributes, node }) => ["div", mergeAttributes(HTMLAttributes, { "data-embed": node.attrs.kind }), node.attrs.title || node.attrs.kind],
});

/** An inline chip: an atom in the text, never split or typed into. Only copied within the app (its data-chip). */
const chip = (name: "mention" | "date" | "dropdown", label: (attrs: Record<string, unknown>) => string) =>
  Node.create({
    name,
    selectable: true,
    parseHTML: () => [{ tag: `span[data-chip="${name}"]`, getAttrs: (el) => JSON.parse(el.getAttribute("data-attrs") ?? "{}") as Record<string, unknown> }],
    renderHTML: ({ HTMLAttributes, node }) => ["span", mergeAttributes(HTMLAttributes, { "data-chip": name, "data-attrs": JSON.stringify(node.attrs) }), label(node.attrs)],
    renderText: ({ node }) => label(node.attrs),
  });

/** Images stored with the document only (src "image:<id>"): pasted images from elsewhere are left out. */
const DocImage = Image.extend<{ documentId: string; inline: boolean; allowBase64: boolean; HTMLAttributes: Record<string, unknown>; resize: false }>({
  parseHTML: () => [{ tag: "img[data-image-src]", getAttrs: (el) => ({ src: el.getAttribute("data-image-src"), alt: el.getAttribute("alt") ?? "" }) }],
  renderHTML({ HTMLAttributes, node }) {
    const url = imageUrl(this.options.documentId, node.attrs.src);
    return ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { src: url ?? "", "data-image-src": node.attrs.src, alt: node.attrs.alt ?? "" })];
  },
});

/** The block types that carry an id (every node whose schema attributes have one). */
const ID_TYPES = new Set(Object.entries(DOCUMENT_SCHEMA.nodes).flatMap(([name, spec]) => (spec.attrs && "id" in spec.attrs ? [name] : [])));

/**
 * Every block keeps a stable id, unique in the document: a block without one (new, pasted, half of a split) gets one,
 * and of two with the same id (a copy pasted) the one that was there keeps it. `taken`: the ids of the other tabs.
 */
export const BlockIds = Extension.create<{ taken: () => ReadonlySet<string> }>({
  name: "blockIds",
  addOptions: () => ({ taken: () => new Set<string>() }),
  addProseMirrorPlugins() {
    const taken = this.options.taken;
    return [
      new Plugin({
        key: new PluginKey("blockIds"),
        appendTransaction: (transactions, oldState, state) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          // Where each id was, mapped through the changes: the one still there keeps its id.
          const mapping = new Mapping();
          for (const tr of transactions) mapping.appendMapping(tr.mapping);
          const kept = new Map<string, number>();
          oldState.doc.descendants((node, pos) => {
            if (typeof node.attrs.id === "string" && ID_TYPES.has(node.type.name)) kept.set(node.attrs.id, mapping.map(pos));
          });
          const seen = new Set(taken());
          const fix: { pos: number; attrs: Record<string, unknown> }[] = [];
          const holders = new Map<string, number[]>();
          state.doc.descendants((node, pos) => {
            if (!ID_TYPES.has(node.type.name)) return;
            const id = node.attrs.id as string | null;
            if (id) holders.set(id, [...(holders.get(id) ?? []), pos]);
          });
          state.doc.descendants((node, pos) => {
            if (!ID_TYPES.has(node.type.name)) return;
            const id = node.attrs.id as string | null;
            const others = id ? holders.get(id)! : [];
            const owner = others.length > 1 ? (others.find((at) => at === kept.get(id!)) ?? others[0]) : pos;
            if (id && owner === pos && !seen.has(id)) {
              seen.add(id);
              return;
            }
            const fresh = newBlockId(new Set([...seen, ...holders.keys()]));
            seen.add(fresh);
            fix.push({ pos, attrs: { ...node.attrs, id: fresh, h: null } });
          });
          if (!fix.length) return null;
          const tr = state.tr;
          for (const { pos, attrs } of fix) tr.setNodeMarkup(pos, undefined, attrs);
          return tr.setMeta("addToHistory", false);
        },
      }),
    ];
  },
});

/** Which Tiptap extension stands for each node of the schema; a node the schema adds later must be added here. */
const NODE_EXTENSIONS: Record<string, Node> = {
  doc: Document,
  paragraph: Paragraph,
  text: Text,
  heading: Heading.configure({ levels: [1, 2, 3] }),
  bulletList: BulletList,
  orderedList: OrderedList,
  listItem: ListItem,
  taskList: TaskList,
  taskItem: TaskItem.configure({ nested: true }),
  table: Table.configure({ resizable: false, allowTableNodeSelection: true }),
  tableRow: TableRow,
  tableHeader: TableHeader,
  tableCell: TableCell,
  codeBlock: CodeBlock.configure({ enableTabIndentation: true }),
  csv: textBlock("csv"),
  latex: textBlock("latex"),
  image: DocImage,
  embed: Embed,
  pending: Pending,
  mention: chip("mention", (a) => `@${String(a.name ?? "")}`),
  date: chip("date", (a) => String(a.value ?? "")),
  dropdown: chip("dropdown", (a) => String(a.value ?? "")),
  hardBreak: HardBreak,
};

const MARK_EXTENSIONS: Record<string, Mark> = {
  bold: Bold,
  italic: Italic,
  strike: Strike,
  code: Code,
  // Links open in a new tab, only to safe addresses, never followed on a click while editing.
  link: Link.configure({
    openOnClick: false,
    autolink: true,
    linkOnPaste: true,
    protocols: [],
    HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
    isAllowedUri: (url) => safeHref(url) !== null,
  }),
};

/** The schema's nodes that have no editor extension: the tests require none. */
export function missingExtensions(): string[] {
  return [...Object.keys(DOCUMENT_SCHEMA.nodes).filter((name) => !NODE_EXTENSIONS[name]), ...Object.keys(DOCUMENT_SCHEMA.marks).filter((name) => !MARK_EXTENSIONS[name])];
}

/**
 * The extensions that make up the schema: one per node and mark of DOCUMENT_SCHEMA, fitted to it, then the block ids.
 * `documentId`: where images are served from; `taken`: ids the other tabs hold.
 */
export function schemaExtensions({ documentId = "", taken }: { documentId?: string; taken?: () => ReadonlySet<string> } = {}): Extensions {
  const nodes = Object.keys(DOCUMENT_SCHEMA.nodes).flatMap((name) => {
    const extension = NODE_EXTENSIONS[name];
    if (!extension) return [];
    const fitted = fitNode(extension);
    return [name === "image" ? (fitted as Node<{ documentId: string; inline: boolean; allowBase64: boolean }>).configure({ documentId, inline: false, allowBase64: false }) : fitted];
  });
  const marks = Object.keys(DOCUMENT_SCHEMA.marks).flatMap((name) => (MARK_EXTENSIONS[name] ? [fitMark(MARK_EXTENSIONS[name])] : []));
  return [...nodes, ...marks, BlockIds.configure(taken ? { taken } : {})] as AnyExtension[];
}

/** The ProseMirror schema the editor runs on: what the tests hold against DOCUMENT_SCHEMA. */
export function documentSchema() {
  return getSchema(schemaExtensions());
}
