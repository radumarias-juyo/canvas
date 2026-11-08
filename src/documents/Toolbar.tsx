// The document's toolbar: the block a line is, marks, lists, tables, code, CSV and formulas, links, images, and the
// chips. Every command is one the schema allows (schema.ts). A toolbar (role="toolbar"): Tab reaches it once, arrow
// keys move along it, and each button names its shortcut.

import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Person } from "../../shared/protocol.ts";
import { Icon } from "../Icon.tsx";
import { useDismiss } from "../layout.tsx";
import { dropdownOptions, today } from "./chips.ts";
import { safeHref } from "./schema.ts";

/** Where the toolbar's state comes from: what the selection is in, and what each command may do now. */
function useToolbarState(editor: Editor) {
  return useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: e.isActive("heading", { level: 1 })
        ? "h1"
        : e.isActive("heading", { level: 2 })
          ? "h2"
          : e.isActive("heading", { level: 3 })
            ? "h3"
            : e.isActive("paragraph")
              ? "p"
              : "",
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      taskList: e.isActive("taskList"),
      codeBlock: e.isActive("codeBlock"),
      inTable: e.isActive("table"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
}

/** The keyboard modifier as this machine names it, for the buttons' titles. */
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

export function Toolbar({
  editor,
  onImage,
  people,
}: {
  editor: Editor;
  /** Upload an image for the document; its src, or null when it failed (the caller says why). Only its owner may. */
  onImage?: (file: File) => Promise<string | null>;
  /** Whom a mention can name: the people of the document's chat as the viewer knows them. */
  people: () => Promise<Person[]>;
}) {
  const state = useToolbarState(editor);
  const bar = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<"link" | "mention" | "dropdown" | null>(null);
  const chain = () => editor.chain().focus();

  // Arrow keys move along the toolbar; Home and End go to its ends.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "SELECT") return;
    const stops = [...(bar.current?.querySelectorAll<HTMLElement>("[data-stop]:not(:disabled)") ?? [])];
    const at = stops.indexOf(target);
    if (at < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? stops.length - 1 : (at + (event.key === "ArrowRight" ? 1 : -1) + stops.length) % stops.length;
    stops[next]?.focus();
  };

  if (!state) return null;
  return (
    <div className="doc-toolbar" role="toolbar" aria-label="Formatting" ref={bar} onKeyDown={onKeyDown}>
      <select
        data-stop
        className="doc-block-select"
        aria-label="Text style"
        value={state.block}
        onChange={(event) => {
          const value = event.target.value;
          if (value === "p") chain().setParagraph().run();
          else chain().setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 }).run();
        }}
      >
        {state.block === "" && <option value="">—</option>}
        <option value="p">Text</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>
      <Group>
        <Tool label="Bold" keys={`${MOD}B`} on={state.bold} run={() => chain().toggleBold().run()}>
          <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />
        </Tool>
        <Tool label="Italic" keys={`${MOD}I`} on={state.italic} run={() => chain().toggleItalic().run()}>
          <path d="M14 5h-4M14 19h-4M14 5l-4 14" />
        </Tool>
        <Tool label="Strikethrough" keys={`${MOD}Shift+S`} on={state.strike} run={() => chain().toggleStrike().run()}>
          <path d="M5 12h14M16 7.5C15.4 6 13.9 5 12 5c-2.2 0-4 1.3-4 3.2 0 1.4 1 2.3 2.6 2.8M8 16.5c.6 1.5 2.1 2.5 4 2.5 2.2 0 4-1.3 4-3.2" />
        </Tool>
        <Tool label="Inline code" keys={`${MOD}E`} on={state.code} run={() => chain().toggleCode().run()}>
          <path d="m9 8-4 4 4 4M15 8l4 4-4 4" />
        </Tool>
        <Popover
          open={open === "link"}
          setOpen={(on) => setOpen(on ? "link" : null)}
          trigger={
            <Tool label={state.link ? "Edit link" : "Link"} keys={`${MOD}K`} on={state.link} run={() => setOpen(open === "link" ? null : "link")}>
              <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
            </Tool>
          }
        >
          <LinkForm
            current={String(editor.getAttributes("link").href ?? "")}
            onDone={(href) => {
              setOpen(null);
              if (href === null) return;
              if (href === "") chain().extendMarkRange("link").unsetLink().run();
              else chain().extendMarkRange("link").setLink({ href }).run();
            }}
          />
        </Popover>
      </Group>
      <Group>
        <Tool label="Bulleted list" keys={`${MOD}Shift+8`} on={state.bulletList} run={() => chain().toggleBulletList().run()}>
          <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
        </Tool>
        <Tool label="Numbered list" keys={`${MOD}Shift+7`} on={state.orderedList} run={() => chain().toggleOrderedList().run()}>
          <path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v5M3.5 14.5c.5-1 2.5-1 2.5.3 0 1-2.5 1.7-2.5 3.2h2.5" />
        </Tool>
        <Tool label="Task list" keys={`${MOD}Shift+9`} on={state.taskList} run={() => chain().toggleTaskList().run()}>
          <path d="M4 5h4v4H4zM4 15h4v4H4zM5 17l1 1 2-2M11 7h9M11 17h9" />
        </Tool>
      </Group>
      <Group>
        <Tool label="Table" on={state.inTable} run={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} disabled={state.inTable}>
          <path d="M4 5h16v14H4zM4 10h16M4 15h16M10 5v14" />
        </Tool>
        {state.inTable && (
          <>
            <TextTool label="Add a row below" run={() => chain().addRowAfter().run()}>
              + Row
            </TextTool>
            <TextTool label="Add a column to the right" run={() => chain().addColumnAfter().run()}>
              + Column
            </TextTool>
            <TextTool label="Delete this row" run={() => chain().deleteRow().run()}>
              − Row
            </TextTool>
            <TextTool label="Delete this column" run={() => chain().deleteColumn().run()}>
              − Column
            </TextTool>
            <TextTool label="Delete the table" run={() => chain().deleteTable().run()}>
              Delete table
            </TextTool>
          </>
        )}
        <Tool label="Code block" keys={`${MOD}Alt+C`} on={state.codeBlock} run={() => chain().toggleCodeBlock().run()}>
          <path d="M4 5h16v14H4zM9 10l-2 2 2 2M15 10l2 2-2 2" />
        </Tool>
        <Tool label="CSV data" run={() => chain().insertContent({ type: "csv", content: [{ type: "text", text: "Name,Value\n" }] }).run()}>
          <path d="M4 5h16v14H4zM4 10h16M9 5v14M15 5v14" />
        </Tool>
        <Tool label="Formula (LaTeX)" run={() => chain().insertContent({ type: "latex" }).run()}>
          <path d="M18 5H7l5 7-5 7h11" />
        </Tool>
        {onImage && (
          <Tool label="Image" run={() => picker.current?.click()}>
            <path d="M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9.5h.01" />
          </Tool>
        )}
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file || !onImage) return;
            const src = await onImage(file);
            if (src) chain().setImage({ src, alt: file.name.replace(/\.[^.]+$/, "") }).run();
          }}
        />
      </Group>
      <Group label="Chips">
        <Popover
          open={open === "mention"}
          setOpen={(on) => setOpen(on ? "mention" : null)}
          trigger={
            <TextTool label="Mention a person" run={() => setOpen(open === "mention" ? null : "mention")}>
              @ Person
            </TextTool>
          }
        >
          <MentionPicker
            people={people}
            onPick={(person) => {
              setOpen(null);
              chain().insertContent([{ type: "mention", attrs: { uid: person.uid, name: person.name } }, { type: "text", text: " " }]).run();
            }}
          />
        </Popover>
        <TextTool label="Insert today's date (change it with a click)" run={() => chain().insertContent([{ type: "date", attrs: { value: today() } }, { type: "text", text: " " }]).run()}>
          Date
        </TextTool>
        <Popover
          open={open === "dropdown"}
          setOpen={(on) => setOpen(on ? "dropdown" : null)}
          trigger={
            <TextTool label="Insert a dropdown (a status per row)" run={() => setOpen(open === "dropdown" ? null : "dropdown")}>
              Dropdown
            </TextTool>
          }
        >
          <DropdownForm
            onDone={(options) => {
              setOpen(null);
              if (options?.length) chain().insertContent({ type: "dropdown", attrs: { options, value: options[0] } }).run();
            }}
          />
        </Popover>
      </Group>
      <Group>
        <Tool label="Undo" keys={`${MOD}Z`} run={() => chain().undo().run()} disabled={!state.canUndo}>
          <path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" />
        </Tool>
        <Tool label="Redo" keys={`${MOD}Shift+Z`} run={() => chain().redo().run()} disabled={!state.canRedo}>
          <path d="m15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h3" />
        </Tool>
      </Group>
    </div>
  );
}

function Group({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="doc-tool-group" role="group" aria-label={label}>
      {children}
    </div>
  );
}

/** An icon button: pressed while what it toggles is on. Keeps the editor's selection (mousedown does not take focus). */
function Tool({ label, keys, on, disabled, run, children }: { label: string; keys?: string; on?: boolean; disabled?: boolean; run: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      data-stop
      className="icon-button doc-tool"
      aria-label={label}
      aria-pressed={on === undefined ? undefined : on}
      title={keys ? `${label} (${keys})` : label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={run}
    >
      <Icon size={18} stroke={1.9}>
        {children}
      </Icon>
    </button>
  );
}

/** A button with a word for a label (table and chip commands, whose icons would be guesses). */
function TextTool({ label, run, children }: { label: string; run: () => void; children: ReactNode }) {
  return (
    <button type="button" data-stop className="doc-tool doc-tool-text" title={label} aria-label={label} onMouseDown={(event) => event.preventDefault()} onClick={run}>
      {children}
    </button>
  );
}

/** A small panel under a toolbar button: closes on Escape or a click outside. */
function Popover({ open, setOpen, trigger, children }: { open: boolean; setOpen: (open: boolean) => void; trigger: ReactNode; children: ReactNode }) {
  const box = useDismiss<HTMLDivElement>(open, setOpen);
  return (
    <div className="doc-popover-anchor" ref={box}>
      {trigger}
      {open && (
        <div className="doc-popover" role="dialog" onKeyDown={(event) => event.key === "Escape" && setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

/** A link's address: only web and mail addresses are taken (safeHref); empty removes the link. Null: cancelled. */
export function LinkForm({ current, onDone }: { current: string; onDone: (href: string | null) => void }) {
  const [href, setHref] = useState(current);
  const typed = href.trim();
  // An address without a scheme reads as a web address.
  const full = typed && !/^[a-z]+:/i.test(typed) ? `https://${typed}` : typed;
  const valid = full === "" || safeHref(full) !== null;
  return (
    <form
      className="doc-popover-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onDone(full);
      }}
    >
      <label>
        <span>Link address</span>
        <input autoFocus type="text" inputMode="url" value={href} onChange={(event) => setHref(event.target.value)} placeholder="https://" aria-invalid={!valid} />
      </label>
      {!valid && <small className="form-error">Only web (https) and mail addresses.</small>}
      <div className="doc-popover-actions">
        {current && (
          <button type="button" onClick={() => onDone("")}>
            Remove link
          </button>
        )}
        <button type="submit" className="primary" disabled={!valid || !typed}>
          {current ? "Update" : "Add link"}
        </button>
      </div>
    </form>
  );
}

/** Whom to mention: the people the viewer shares chats with, filtered as they type. */
function MentionPicker({ people, onPick }: { people: () => Promise<Person[]>; onPick: (person: Person) => void }) {
  const [list, setList] = useState<Person[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    people().then(setList, () => setError(true));
  }
  const shown = (list ?? []).filter((person) => person.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="doc-popover-form">
      <label>
        <span>Mention</span>
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name"
          onKeyDown={(event) => {
            if (event.key === "Enter" && shown[0]) {
              event.preventDefault();
              onPick(shown[0]);
            }
          }}
        />
      </label>
      {error && <small className="form-error">Could not read the people you share chats with.</small>}
      {list === null && !error && <small className="skills-note">Reading…</small>}
      {list && !shown.length && <small className="skills-note">{list.length ? "Nobody by that name." : "You share no chat with anyone yet."}</small>}
      <ul className="doc-pick-list">
        {shown.slice(0, 8).map((person) => (
          <li key={person.uid}>
            <button type="button" onClick={() => onPick(person)}>
              {person.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A dropdown's options, typed with commas: the first is the one chosen. */
function DropdownForm({ onDone }: { onDone: (options: string[] | null) => void }) {
  const [typed, setTyped] = useState("To do, In progress, Done");
  const options = dropdownOptions(typed);
  return (
    <form
      className="doc-popover-form"
      onSubmit={(event) => {
        event.preventDefault();
        onDone(options);
      }}
    >
      <label>
        <span>Options, separated by commas</span>
        <input autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} />
      </label>
      <div className="doc-popover-actions">
        <button type="submit" className="primary" disabled={!options.length}>
          Insert
        </button>
      </div>
    </form>
  );
}
