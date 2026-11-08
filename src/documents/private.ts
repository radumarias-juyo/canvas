// Private sections (built from the owner's private servers on their own turn): marked on the page. The owner sees a
// line that only they see the block; anyone else gets the server's placeholder in its place (the document's object
// never sends them the text), marked the same way. Decorations only: nothing is added to the document.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const privateKey = new PluginKey<string[]>("privateBlocks");

/** Marks the top-level blocks whose ids are set with `setPrivate` (a transaction's meta), with class `doc-private`. */
export const PrivateBlocks = Extension.create({
  name: "privateBlocks",
  addProseMirrorPlugins() {
    return [
      new Plugin<string[]>({
        key: privateKey,
        state: {
          init: () => [],
          apply: (tr, ids) => (tr.getMeta(privateKey) as string[] | undefined) ?? ids,
        },
        props: {
          decorations: (state) => {
            const ids = new Set(privateKey.getState(state) ?? []);
            if (!ids.size) return null;
            const marks: Decoration[] = [];
            state.doc.forEach((node, offset) => {
              if (ids.has(node.attrs.id as string)) marks.push(Decoration.node(offset, offset + node.nodeSize, { class: "doc-private" }));
            });
            return DecorationSet.create(state.doc, marks);
          },
        },
      }),
    ];
  },
});
